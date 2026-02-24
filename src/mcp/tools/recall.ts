import { z } from 'zod';
import { searchObservations, touchRecalledObservations, type ObservationWithEntity } from '../../db/observations.js';
import { findEntityByName } from '../../db/entities.js';
import { getRelatedEntities } from '../../db/relationships.js';
import { generateEmbedding, semanticSearchWithVector, getEmbeddingsByEntity, semanticSearch, type SemanticSearchResult } from '../../embeddings/embedder.js';
import { cosineSimilarity } from '../../embeddings/similarity.js';

export const recallSchema = z.object({
  query: z
    .string()
    .min(1, 'Query is required')
    .max(500, 'Query must be 500 characters or less'),
  limit: z.coerce.number().min(1).max(50).default(10),
  type: z.string().max(50).optional(),
  since: z.string().datetime().optional(),
  kind: z.string().max(50).optional(),
  spread: z.boolean().default(false),
  format: z.enum(['full', 'compact', 'wire', 'index']).default('full'),
});

export type RecallInput = z.infer<typeof recallSchema>;

const SIMILARITY_THRESHOLD = 0.15;
const SPREAD_DECAY = 0.5;
const SPREAD_ALPHA = 0.1;

interface MemoryResult {
  observation_id: string;
  entity: string;
  type: string | null;
  content: string;
  source: string | null;
  kind: string | null;
  remembered_at: string;
  similarity?: number;
  stale?: boolean;
}

export interface RecallResult {
  success: boolean;
  count: number;
  memories: MemoryResult[];
}

export interface RecallCompactResult {
  success: boolean;
  count: number;
  text: string;
}

export interface RecallIndexResult {
  success: boolean;
  count: number;
  entity_count: number;
  text: string;
}

export async function recall(input: RecallInput): Promise<RecallResult | RecallCompactResult | RecallIndexResult> {
  const searchOpts = {
    limit: input.limit,
    type: input.type,
    since: input.since,
    kind: input.kind,
  };

  let semanticResults: SemanticSearchResult[];
  let queryVector: Float32Array | null = null;

  if (input.spread) {
    // Generate embedding once, reuse for base search + spreading
    queryVector = await generateEmbedding(input.query);
    semanticResults = semanticSearchWithVector(queryVector, searchOpts);
  } else {
    semanticResults = await semanticSearch(input.query, searchOpts).catch(() => [] as SemanticSearchResult[]);
  }

  const keywordResults = searchObservations({
    query: input.query,
    limit: input.limit,
    type: input.type,
    since: input.since,
    kind: input.kind,
  });

  // Merge and deduplicate by observation ID
  const seen = new Set<string>();
  const memories: MemoryResult[] = [];

  // Semantic results first (primary), filtered by threshold
  for (const r of semanticResults) {
    if (r.similarity < SIMILARITY_THRESHOLD) continue;
    if (!seen.has(r.observation_id)) {
      seen.add(r.observation_id);
      memories.push({
        observation_id: r.observation_id,
        entity: r.entity_name,
        type: r.entity_type,
        content: r.content,
        source: r.source,
        kind: r.kind,
        remembered_at: r.created_at,
        similarity: Math.round(r.similarity * 1000) / 1000,
      });
    }
  }

  // Keyword results as fallback
  for (const obs of keywordResults) {
    if (!seen.has(obs.id)) {
      seen.add(obs.id);
      memories.push(formatObservation(obs));
    }
  }

  // Spreading activation: follow relationships 1 hop from matched entities
  if (input.spread && queryVector) {
    const matchedEntityNames = new Set(memories.map(m => m.entity));

    for (const entityName of matchedEntityNames) {
      const entity = findEntityByName(entityName);
      if (!entity) continue;

      const related = getRelatedEntities(entity.id, 1);
      for (const [relatedId] of related) {
        const vectors = getEmbeddingsByEntity(relatedId);
        for (const v of vectors) {
          if (seen.has(v.observation_id)) continue;
          // Apply kind filter if set
          if (input.kind && v.kind !== input.kind) continue;

          const sim = cosineSimilarity(queryVector, v.vector);
          const recallBoost = 1 + SPREAD_ALPHA * Math.log(1 + (v.recall_count ?? 0));
          const importance = v.importance ?? 1.0;
          const score = sim * recallBoost * importance * SPREAD_DECAY;

          if (score >= SIMILARITY_THRESHOLD) {
            seen.add(v.observation_id);
            memories.push({
              observation_id: v.observation_id,
              entity: v.entity_name,
              type: v.entity_type,
              content: v.content,
              source: v.source,
              kind: v.kind,
              remembered_at: v.created_at,
              similarity: Math.round(score * 1000) / 1000,
            });
          }
        }
      }
    }

    // Re-sort all memories by similarity descending
    memories.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  }

  // Reconsolidation hints: flag observations that may need updating
  const STALE_AGE_DAYS = 30;
  const now = Date.now();
  const entityUpdateCache = new Map<string, string>(); // entity name → updated_at

  for (const m of memories) {
    const createdAt = new Date(m.remembered_at).getTime();
    const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);
    if (ageDays <= STALE_AGE_DAYS) continue;

    // Look up entity updated_at (cached per entity name)
    let updatedAt = entityUpdateCache.get(m.entity);
    if (updatedAt === undefined) {
      const entity = findEntityByName(m.entity);
      updatedAt = entity?.updated_at ?? '';
      entityUpdateCache.set(m.entity, updatedAt);
    }

    if (updatedAt && new Date(updatedAt).getTime() > createdAt) {
      m.stale = true;
    }
  }

  const limited = memories.slice(0, input.limit);

  // Track access for recall-frequency analysis
  if (limited.length > 0) {
    touchRecalledObservations(limited.map(m => m.observation_id));
  }

  if (input.format === 'compact') {
    return {
      success: true,
      count: limited.length,
      text: formatCompact(limited),
    };
  }

  if (input.format === 'wire') {
    return {
      success: true,
      count: limited.length,
      text: formatWire(limited),
    };
  }

  if (input.format === 'index') {
    return formatIndex(limited);
  }

  return {
    success: true,
    count: limited.length,
    memories: limited,
  };
}

function formatCompact(memories: MemoryResult[]): string {
  if (memories.length === 0) return '';

  // Group by entity
  const groups = new Map<string, { type: string | null; items: MemoryResult[] }>();
  for (const m of memories) {
    const existing = groups.get(m.entity);
    if (existing) {
      existing.items.push(m);
    } else {
      groups.set(m.entity, { type: m.type, items: [m] });
    }
  }

  const sections: string[] = [];
  for (const [entity, { type, items }] of groups) {
    const typeStr = type ? ` (${type})` : '';
    const lines = [`**${entity}**${typeStr}`];
    for (const item of items) {
      const simStr = item.similarity !== undefined ? ` [${item.similarity.toFixed(2)}]` : '';
      lines.push(`- ${item.content}${simStr}`);
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

function formatWire(memories: MemoryResult[]): string {
  if (memories.length === 0) return '';

  const groups = new Map<string, { type: string | null; items: MemoryResult[] }>();
  for (const m of memories) {
    const existing = groups.get(m.entity);
    if (existing) {
      existing.items.push(m);
    } else {
      groups.set(m.entity, { type: m.type, items: [m] });
    }
  }

  const sections: string[] = [];
  for (const [entity, { type, items }] of groups) {
    const typeStr = type ? `|${type}` : '';
    const lines = [`#E ${entity}${typeStr}`];
    for (const item of items) {
      lines.push(`- ${item.content}`);
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

function formatIndex(memories: MemoryResult[]): RecallIndexResult {
  if (memories.length === 0) {
    return { success: true, count: 0, entity_count: 0, text: '#I 0 results, 0 entities' };
  }

  const entityMap = new Map<string, { type: string | null; obsCount: number; bestSimilarity: number }>();
  for (const m of memories) {
    const existing = entityMap.get(m.entity);
    const sim = m.similarity ?? 0;
    if (existing) {
      existing.obsCount++;
      if (sim > existing.bestSimilarity) existing.bestSimilarity = sim;
    } else {
      entityMap.set(m.entity, { type: m.type, obsCount: 1, bestSimilarity: sim });
    }
  }

  const sorted = [...entityMap.entries()].sort((a, b) => b[1].bestSimilarity - a[1].bestSimilarity);

  const lines = [`#I ${memories.length} results, ${sorted.length} entities`];
  for (const [name, { type, obsCount, bestSimilarity }] of sorted) {
    const typeStr = type ?? '';
    lines.push(`${name}|${typeStr}|${obsCount} obs|${bestSimilarity.toFixed(2)}`);
  }

  return {
    success: true,
    count: memories.length,
    entity_count: sorted.length,
    text: lines.join('\n'),
  };
}

function formatObservation(obs: ObservationWithEntity): MemoryResult {
  return {
    observation_id: obs.id,
    entity: obs.entity_name,
    type: obs.entity_type,
    content: obs.content,
    source: obs.source,
    kind: obs.kind,
    remembered_at: obs.created_at,
  };
}
