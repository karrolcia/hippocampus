import { findEntityByName, listEntities } from '../../db/entities.js';
import { getObservationsByEntity } from '../../db/observations.js';
import { getEmbeddingsByEntity, generateEmbedding, type StoredVector } from '../../embeddings/embedder.js';
import { cosineSimilarity } from '../../embeddings/similarity.js';
import { computeRedundancyScores } from '../../embeddings/subspace.js';

export interface ConsolidateInput {
  entity?: string;
  threshold?: number;
  mode?: 'observations' | 'entities' | 'contradictions' | 'sleep';
  age_days?: number;
}

interface ClusterObservation {
  observation_id: string;
  entity: string;
  type: string | null;
  content: string;
  source: string | null;
  remembered_at: string;
}

export interface Cluster {
  observations: ClusterObservation[];
  avg_similarity: number;
}

export interface ConsolidateResult {
  success: boolean;
  total_observations: number;
  clusters: Cluster[];
  message: string;
}

interface EntityClusterMember {
  name: string;
  type: string | null;
  observation_count: number;
  last_updated: string;
}

export interface EntityCluster {
  entities: EntityClusterMember[];
  avg_similarity: number;
}

export interface EntityResolutionResult {
  success: boolean;
  total_entities: number;
  clusters: EntityCluster[];
  message: string;
}

interface ContradictionPair {
  observations: [ClusterObservation, ClusterObservation];
  embedding_similarity: number;
  lexical_overlap: number;
}

export interface ContradictionResult {
  success: boolean;
  total_observations: number;
  pairs: ContradictionPair[];
  message: string;
}

// Union-Find with path compression and union by rank
class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if (this.rank[rx] < this.rank[ry]) {
      this.parent[rx] = ry;
    } else if (this.rank[rx] > this.rank[ry]) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx]++;
    }
  }
}

export async function consolidate(input: ConsolidateInput): Promise<ConsolidateResult | EntityResolutionResult | ContradictionResult | SleepResult> {
  if (input.mode === 'entities') {
    return resolveEntities(input.threshold ?? 0.7);
  }
  if (input.mode === 'contradictions') {
    return detectContradictions(input);
  }
  if (input.mode === 'sleep') {
    return sleepMode(input);
  }
  return consolidateObservations(input);
}

function consolidateObservations(input: ConsolidateInput): ConsolidateResult {
  const threshold = input.threshold ?? 0.8;

  // Resolve entity name to ID if provided
  let entityId: string | undefined;
  if (input.entity) {
    const entity = findEntityByName(input.entity);
    if (!entity) {
      return {
        success: false,
        total_observations: 0,
        clusters: [],
        message: `Entity "${input.entity}" not found.`,
      };
    }
    entityId = entity.id;
  }

  const vectors = getEmbeddingsByEntity(entityId);

  if (vectors.length < 2) {
    return {
      success: true,
      total_observations: vectors.length,
      clusters: [],
      message: vectors.length === 0
        ? 'No observations found.'
        : 'Only one observation — nothing to consolidate.',
    };
  }

  // Pairwise cosine similarity + union-find clustering
  const uf = new UnionFind(vectors.length);
  const similarities: Map<string, number> = new Map();

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const sim = cosineSimilarity(vectors[i].vector, vectors[j].vector);
      if (sim >= threshold) {
        uf.union(i, j);
        // Store pairwise similarity for avg calculation
        similarities.set(`${i}:${j}`, sim);
      }
    }
  }

  // Group by cluster root
  const groups = new Map<number, number[]>();
  for (let i = 0; i < vectors.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(i);
  }

  // Build clusters (2+ members only), compute avg within-cluster similarity
  const clusters: Cluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;

    let simSum = 0;
    let simCount = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = members[i] < members[j]
          ? `${members[i]}:${members[j]}`
          : `${members[j]}:${members[i]}`;
        const sim = similarities.get(key);
        if (sim !== undefined) {
          simSum += sim;
          simCount++;
        } else {
          // Compute on the fly for transitive pairs not above threshold
          const s = cosineSimilarity(vectors[members[i]].vector, vectors[members[j]].vector);
          simSum += s;
          simCount++;
        }
      }
    }

    clusters.push({
      observations: members.map(idx => toClusterObservation(vectors[idx])),
      avg_similarity: simCount > 0 ? Math.round((simSum / simCount) * 1000) / 1000 : 0,
    });
  }

  // Sort by size descending
  clusters.sort((a, b) => b.observations.length - a.observations.length);

  return {
    success: true,
    total_observations: vectors.length,
    clusters,
    message: clusters.length === 0
      ? `Scanned ${vectors.length} observations — no clusters found above threshold ${threshold}.`
      : `Found ${clusters.length} cluster(s) across ${vectors.length} observations. Review each cluster and use merge to consolidate.`,
  };
}

async function resolveEntities(threshold: number): Promise<EntityResolutionResult> {
  const entities = listEntities({ limit: 10000 });

  if (entities.length < 2) {
    return {
      success: true,
      total_entities: entities.length,
      clusters: [],
      message: entities.length === 0
        ? 'No entities found.'
        : 'Only one entity — nothing to resolve.',
    };
  }

  // Embed all entity names
  const embeddings = await Promise.all(
    entities.map(e => generateEmbedding(e.name))
  );

  // Pairwise cosine similarity + union-find clustering
  const uf = new UnionFind(entities.length);
  const similarities: Map<string, number> = new Map();

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      if (sim >= threshold) {
        uf.union(i, j);
        similarities.set(`${i}:${j}`, sim);
      }
    }
  }

  // Group by cluster root
  const groups = new Map<number, number[]>();
  for (let i = 0; i < entities.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(i);
  }

  // Build clusters (2+ members only)
  const clusters: EntityCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;

    let simSum = 0;
    let simCount = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = members[i] < members[j]
          ? `${members[i]}:${members[j]}`
          : `${members[j]}:${members[i]}`;
        const sim = similarities.get(key);
        if (sim !== undefined) {
          simSum += sim;
          simCount++;
        } else {
          const s = cosineSimilarity(embeddings[members[i]], embeddings[members[j]]);
          simSum += s;
          simCount++;
        }
      }
    }

    clusters.push({
      entities: members.map(idx => {
        const e = entities[idx];
        const obs = getObservationsByEntity(e.id);
        return {
          name: e.name,
          type: e.type,
          observation_count: obs.length,
          last_updated: e.updated_at,
        };
      }),
      avg_similarity: simCount > 0 ? Math.round((simSum / simCount) * 1000) / 1000 : 0,
    });
  }

  // Sort by size descending
  clusters.sort((a, b) => b.entities.length - a.entities.length);

  return {
    success: true,
    total_entities: entities.length,
    clusters,
    message: clusters.length === 0
      ? `Scanned ${entities.length} entity names — no similar names found above threshold ${threshold}.`
      : `Found ${clusters.length} cluster(s) of potentially duplicate entities across ${entities.length} total. Review each cluster and decide which to merge.`,
  };
}

const DEFAULT_CONTRADICTION_THRESHOLD = 0.6;
const MAX_LEXICAL_OVERLAP = 0.3;

function detectContradictions(input: ConsolidateInput): ContradictionResult {
  const threshold = input.threshold ?? DEFAULT_CONTRADICTION_THRESHOLD;

  // Resolve entity name to ID if provided
  let entityId: string | undefined;
  if (input.entity) {
    const entity = findEntityByName(input.entity);
    if (!entity) {
      return {
        success: false,
        total_observations: 0,
        pairs: [],
        message: `Entity "${input.entity}" not found.`,
      };
    }
    entityId = entity.id;
  }

  const vectors = getEmbeddingsByEntity(entityId);

  if (vectors.length < 2) {
    return {
      success: true,
      total_observations: vectors.length,
      pairs: [],
      message: vectors.length === 0
        ? 'No observations found.'
        : 'Only one observation — nothing to compare.',
    };
  }

  const pairs: ContradictionPair[] = [];

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const embSim = cosineSimilarity(vectors[i].vector, vectors[j].vector);
      if (embSim < threshold) continue;

      const lexOverlap = jaccardSimilarity(vectors[i].content, vectors[j].content);
      if (lexOverlap < MAX_LEXICAL_OVERLAP) {
        pairs.push({
          observations: [toClusterObservation(vectors[i]), toClusterObservation(vectors[j])],
          embedding_similarity: Math.round(embSim * 1000) / 1000,
          lexical_overlap: Math.round(lexOverlap * 1000) / 1000,
        });
      }
    }
  }

  // Sort by embedding similarity descending
  pairs.sort((a, b) => b.embedding_similarity - a.embedding_similarity);

  return {
    success: true,
    total_observations: vectors.length,
    pairs,
    message: pairs.length === 0
      ? `Scanned ${vectors.length} observations — no potential contradictions found.`
      : `Found ${pairs.length} potential contradiction(s) across ${vectors.length} observations. Review each pair — high semantic similarity with low lexical overlap suggests conflicting claims.`,
  };
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 0));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 0));
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function toClusterObservation(v: StoredVector): ClusterObservation {
  return {
    observation_id: v.observation_id,
    entity: v.entity_name,
    type: v.entity_type,
    content: v.content,
    source: v.source,
    remembered_at: v.created_at,
  };
}

// --- Sleep mode: batch compression, pruning, reconsolidation ---

export interface SleepObservation {
  observation_id: string;
  entity: string;
  type: string | null;
  content: string;
  remembered_at: string;
  age_days: number;
  recall_count: number;
  redundancy: number;
}

export interface SleepResult {
  success: boolean;
  entity?: string;
  total_observations: number;
  information_rank: number;
  redundancy_ratio: number;
  compress: SleepObservation[];
  prune: SleepObservation[];
  refresh: SleepObservation[];
  message: string;
}

function sleepMode(input: ConsolidateInput): SleepResult {
  const ageDays = input.age_days ?? 30;
  const now = Date.now();

  // Resolve entity scope
  let entityIds: Array<{ id: string; name: string; type: string | null }> = [];
  if (input.entity) {
    const entity = findEntityByName(input.entity);
    if (!entity) {
      return {
        success: false,
        entity: input.entity,
        total_observations: 0,
        information_rank: 0,
        redundancy_ratio: 0,
        compress: [],
        prune: [],
        refresh: [],
        message: `Entity "${input.entity}" not found.`,
      };
    }
    entityIds = [{ id: entity.id, name: entity.name, type: entity.type }];
  } else {
    const entities = listEntities({ limit: 10000 });
    entityIds = entities.map(e => ({ id: e.id, name: e.name, type: e.type }));
  }

  // Collect all vectors and metadata across scoped entities
  const allVectors: StoredVector[] = [];
  for (const e of entityIds) {
    const vectors = getEmbeddingsByEntity(e.id);
    allVectors.push(...vectors);
  }

  if (allVectors.length === 0) {
    return {
      success: true,
      entity: input.entity,
      total_observations: 0,
      information_rank: 0,
      redundancy_ratio: 0,
      compress: [],
      prune: [],
      refresh: [],
      message: 'No observations found.',
    };
  }

  // Compute SVD redundancy scores
  const { scores, rank, redundancyRatio } = computeRedundancyScores(
    allVectors.map(v => v.vector)
  );

  // Classify each observation
  const compress: SleepObservation[] = [];
  const prune: SleepObservation[] = [];
  const refresh: SleepObservation[] = [];

  for (let i = 0; i < allVectors.length; i++) {
    const v = allVectors[i];
    const createdAt = new Date(v.created_at).getTime();
    const age = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
    const redundancy = Math.round(scores[i] * 1000) / 1000;
    const recallCount = v.recall_count ?? 0;

    if (age < ageDays) continue; // Too young — healthy

    const obs: SleepObservation = {
      observation_id: v.observation_id,
      entity: v.entity_name,
      type: v.entity_type,
      content: v.content,
      remembered_at: v.created_at,
      age_days: age,
      recall_count: recallCount,
      redundancy,
    };

    if (recallCount === 0) {
      // Never recalled + old → prune candidate
      prune.push(obs);
    } else if (redundancy >= 0.5 && recallCount > 0) {
      // Redundant + recalled + old → compress candidate
      compress.push(obs);
    } else if (recallCount >= 3 && redundancy < 0.5) {
      // Actively used + unique + old → refresh candidate
      refresh.push(obs);
    }
  }

  // Sort each category for actionability
  compress.sort((a, b) => b.redundancy - a.redundancy);
  prune.sort((a, b) => b.age_days - a.age_days);
  refresh.sort((a, b) => b.recall_count - a.recall_count);

  const total = compress.length + prune.length + refresh.length;
  const message = total === 0
    ? `Scanned ${allVectors.length} observations — all healthy (young or actively used with unique content).`
    : `Found ${compress.length} to compress, ${prune.length} to prune, ${refresh.length} to refresh across ${allVectors.length} observations. Information rank: ${rank}/${allVectors.length} (${Math.round(redundancyRatio * 100)}% redundant).`;

  return {
    success: true,
    entity: input.entity,
    total_observations: allVectors.length,
    information_rank: rank,
    redundancy_ratio: redundancyRatio,
    compress,
    prune,
    refresh,
    message,
  };
}
