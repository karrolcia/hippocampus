import { z } from 'zod';
import { searchObservations, touchRecalledObservations, type ObservationWithEntity } from '../../db/observations.js';
import { findEntityByName, getEntityVersion } from '../../db/entities.js';
import { getRelatedEntities } from '../../db/relationships.js';
import { generateEmbedding, semanticSearchWithVector, getEmbeddingsByEntity, semanticSearch, type SemanticSearchResult } from '../../embeddings/embedder.js';
import { cosineSimilarity } from '../../embeddings/similarity.js';
import { isAppendOnlyEntity } from '../../config.js';
import { normalizeSinceBound, parseStoredTimestamp, SINCE_CONTRACT_ERROR } from '../../db/timestamps.js';

export const recallSchema = z.object({
  query: z
    .string()
    .min(1, 'Query is required')
    .max(500, 'Query must be 500 characters or less'),
  limit: z.coerce.number().min(1).max(50).default(10),
  type: z.string().max(50).optional(),
  // No FORMAT validation here: `normalizeSinceBound` in recall() below is the
  // single arbiter of shape, and it accepts forms Zod's `.datetime()` rejects
  // (the space-separated stored form) while rejecting nothing it accepts. Two
  // validators disagreeing about a format is how the documented ISO spelling
  // ended up being the one that returned nothing. The `.max(64)` on the MCP
  // schema is not a second opinion about format — it is the input-length cap
  // every other string param carries, and a length cap cannot disagree.
  since: z.string().optional(),
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
  version_hash?: string | null;
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
  // Normalize once, here, and feed both search paths from the same variable:
  // the semantic and keyword halves compare `created_at >= ?` independently, so
  // a bound normalized in only one of them would return half an answer. Throws
  // on an unparseable value rather than filtering everything out (D13).
  const since = input.since === undefined ? undefined : normalizeSinceBound(input.since);

  const searchOpts = {
    limit: input.limit,
    type: input.type,
    since,
    kind: input.kind,
  };

  let semanticResults: SemanticSearchResult[];
  let queryVector: Float32Array | null = null;

  if (input.spread) {
    // Generate embedding once, reuse for base search + spreading
    queryVector = await generateEmbedding(input.query);
    semanticResults = semanticSearchWithVector(queryVector, searchOpts);
  } else {
    // Degrade to an empty semantic leg if the embedder fails (model load,
    // dimension drift) — the keyword leg still answers. But a `since` contract
    // violation must NOT degrade: it would surface as a thin result set that
    // looks like a ranking quirk, i.e. the silent-empty failure the assert
    // exists to prevent, reintroduced by the error handling around it. Today
    // the keyword leg below throws on the same bound anyway; that masking is
    // an accident of call order, not a guarantee, so this leg holds its own.
    semanticResults = await semanticSearch(input.query, searchOpts).catch((err: unknown) => {
      if ((err as Error | undefined)?.name === SINCE_CONTRACT_ERROR) throw err;
      return [] as SemanticSearchResult[];
    });
  }

  const keywordResults = searchObservations({
    query: input.query,
    limit: input.limit,
    type: input.type,
    since,
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

    // `since` has to gate these too. Spreading walks relationships and reads
    // embeddings directly, so it never passes through either SQL statement and
    // the bound applied there does not reach it. The consequence is worse than
    // extra rows: the re-sort below is followed by a slice to `limit`, so
    // damped out-of-window results can DISPLACE the in-window rows that were
    // actually asked for — a filtered query returning a full-looking answer
    // containing nothing new. Same fail-toward-absence family as the bound
    // itself (D13), in a shape that looks healthier than an empty result.
    //
    // Compared as instants rather than strings. `created_at` is TEXT with no
    // format constraint — every write path in src goes through the schema
    // default, but test fixtures backdate it with `toISOString()`, so ISO
    // values do occur in the column — and a lexicographic `>=` over a mixed
    // column is the exact trap D13 removed. The two SQL legs cannot do this
    // (comparing instants there would cost `idx_observations_created`); in
    // memory it is free.
    const sinceMs = since === undefined ? undefined : parseStoredTimestamp(since);

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
          // `type` is deliberately NOT applied here — spreading exists to reach
          // related entities, which are usually of a different type (a person's
          // projects), so filtering it would make `spread` + `type` inert. Pinned
          // by "spread: true includes related entity observations across type
          // boundary" in tests/new-features.test.ts. `since` is the opposite
          // case and is enforced below: "what landed since X" means the same
          // thing whichever entity it came from, and a temporal bound crossed
          // by accident is how this whole entry started.
          // Drop only what is provably before the bound: an unparseable
          // timestamp is included and stays visible, rather than being dropped
          // where nobody would ever see it go.
          if (sinceMs !== undefined && parseStoredTimestamp(v.created_at) < sinceMs) continue;

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
    // Append-only entities are never stale (D12). The flag means "this may need
    // updating", and `update` is create-new + delete-old — so on a log entity it
    // invites destroying a dated record. Worse, it fires on ALL of them: the
    // condition is "older than 30 days AND the entity has newer information
    // since", and an active log always has newer information since. Measured on
    // prod before the fix: 5 of 5 recalled log observations flagged stale. An old
    // log entry is not out of date; it is the entry for that date.
    if (isAppendOnlyEntity(m.entity)) continue;

    const createdAt = parseStoredTimestamp(m.remembered_at);
    const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);
    if (ageDays <= STALE_AGE_DAYS) continue;

    // Look up entity updated_at (cached per entity name)
    let updatedAt = entityUpdateCache.get(m.entity);
    if (updatedAt === undefined) {
      const entity = findEntityByName(m.entity);
      updatedAt = entity?.updated_at ?? '';
      entityUpdateCache.set(m.entity, updatedAt);
    }

    if (updatedAt && parseStoredTimestamp(updatedAt) > createdAt) {
      m.stale = true;
    }
  }

  // Inject version_hash per entity (cached)
  const versionCache = new Map<string, string | null>();
  for (const m of memories) {
    if (!versionCache.has(m.entity)) {
      const version = getEntityVersion(m.entity);
      versionCache.set(m.entity, version?.version_hash ?? null);
    }
    m.version_hash = versionCache.get(m.entity) ?? null;
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
  const groups = new Map<string, { type: string | null; version_hash: string | null; items: MemoryResult[] }>();
  for (const m of memories) {
    const existing = groups.get(m.entity);
    if (existing) {
      existing.items.push(m);
    } else {
      groups.set(m.entity, { type: m.type, version_hash: m.version_hash ?? null, items: [m] });
    }
  }

  const sections: string[] = [];
  for (const [entity, { type, version_hash, items }] of groups) {
    const typeStr = type ? ` (${type})` : '';
    const hashStr = version_hash ? ` [v:${version_hash.slice(0, 8)}]` : '';
    const lines = [`**${entity}**${typeStr}${hashStr}`];
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

  const groups = new Map<string, { type: string | null; version_hash: string | null; items: MemoryResult[] }>();
  for (const m of memories) {
    const existing = groups.get(m.entity);
    if (existing) {
      existing.items.push(m);
    } else {
      groups.set(m.entity, { type: m.type, version_hash: m.version_hash ?? null, items: [m] });
    }
  }

  const sections: string[] = [];
  for (const [entity, { type, version_hash, items }] of groups) {
    const typeStr = type ? `|${type}` : '';
    const hashStr = version_hash ? `|v:${version_hash.slice(0, 8)}` : '';
    const lines = [`#E ${entity}${typeStr}${hashStr}`];
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

  const entityMap = new Map<string, { type: string | null; version_hash: string | null; obsCount: number; bestSimilarity: number }>();
  for (const m of memories) {
    const existing = entityMap.get(m.entity);
    const sim = m.similarity ?? 0;
    if (existing) {
      existing.obsCount++;
      if (sim > existing.bestSimilarity) existing.bestSimilarity = sim;
    } else {
      entityMap.set(m.entity, { type: m.type, version_hash: m.version_hash ?? null, obsCount: 1, bestSimilarity: sim });
    }
  }

  const sorted = [...entityMap.entries()].sort((a, b) => b[1].bestSimilarity - a[1].bestSimilarity);

  const lines = [`#I ${memories.length} results, ${sorted.length} entities`];
  for (const [name, { type, version_hash, obsCount, bestSimilarity }] of sorted) {
    const typeStr = type ?? '';
    const hashStr = version_hash ? `|v:${version_hash.slice(0, 8)}` : '';
    lines.push(`${name}|${typeStr}|${obsCount} obs|${bestSimilarity.toFixed(2)}${hashStr}`);
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
