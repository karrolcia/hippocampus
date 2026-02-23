import { z } from 'zod';
import { searchObservations, touchRecalledObservations, type ObservationWithEntity } from '../../db/observations.js';
import { semanticSearch, type SemanticSearchResult } from '../../embeddings/embedder.js';

export const recallSchema = z.object({
  query: z
    .string()
    .min(1, 'Query is required')
    .max(500, 'Query must be 500 characters or less'),
  limit: z.coerce.number().min(1).max(50).default(10),
  type: z.string().max(50).optional(),
  since: z.string().datetime().optional(),
  format: z.enum(['full', 'compact']).default('full'),
});

export type RecallInput = z.infer<typeof recallSchema>;

const SIMILARITY_THRESHOLD = 0.15;

interface MemoryResult {
  observation_id: string;
  entity: string;
  type: string | null;
  content: string;
  source: string | null;
  remembered_at: string;
  similarity?: number;
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

export async function recall(input: RecallInput): Promise<RecallResult | RecallCompactResult> {
  // Run semantic and keyword search in parallel
  const [semanticResults, keywordResults] = await Promise.all([
    semanticSearch(input.query, {
      limit: input.limit,
      type: input.type,
      since: input.since,
    }).catch(() => [] as SemanticSearchResult[]),
    Promise.resolve(
      searchObservations({
        query: input.query,
        limit: input.limit,
        type: input.type,
        since: input.since,
      })
    ),
  ]);

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

function formatObservation(obs: ObservationWithEntity): MemoryResult {
  return {
    observation_id: obs.id,
    entity: obs.entity_name,
    type: obs.entity_type,
    content: obs.content,
    source: obs.source,
    remembered_at: obs.created_at,
  };
}
