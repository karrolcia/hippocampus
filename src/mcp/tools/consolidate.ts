import { findEntityByName, listEntities } from '../../db/entities.js';
import { getObservationsByEntity } from '../../db/observations.js';
import { getEmbeddingsByEntity, generateEmbedding, type StoredVector } from '../../embeddings/embedder.js';
import { cosineSimilarity } from '../../embeddings/similarity.js';

export interface ConsolidateInput {
  entity?: string;
  threshold?: number;
  mode?: 'observations' | 'entities';
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

export async function consolidate(input: ConsolidateInput): Promise<ConsolidateResult | EntityResolutionResult> {
  if (input.mode === 'entities') {
    return resolveEntities(input.threshold ?? 0.7);
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
