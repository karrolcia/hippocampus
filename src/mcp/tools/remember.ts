import { z } from 'zod';
import { findOrCreateEntity, findEntityById, listEntities, type Entity } from '../../db/entities.js';
import { createObservation, deleteObservation, getObservationsByEntityAndKind } from '../../db/observations.js';
import { createRelationship, relationshipExists } from '../../db/relationships.js';
import { generateEmbedding, storeEmbedding, getEmbeddingsByEntity, deleteEmbedding } from '../../embeddings/embedder.js';
import { cosineSimilarity } from '../../embeddings/similarity.js';
import { computeNovelty } from '../../embeddings/subspace.js';
import { config } from '../../config.js';

export const DEDUP_THRESHOLD = 0.85;
const NEAR_MATCH_THRESHOLD = 0.5;
const MAX_NEAR_MATCHES = 3;

export const rememberSchema = z.object({
  content: z
    .string()
    .min(1, 'Content is required')
    .max(50000, 'Content must be 50000 characters or less')
    .transform(s => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')),
  entity: z
    .string()
    .max(200, 'Entity name must be 200 characters or less')
    .optional()
    .transform(s => s?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')),
  type: z.string().max(50).optional(),
  source: z.string().max(100).optional(),
  importance: z.number().min(0).max(1).optional(),
  kind: z.string().max(50).optional(),
  replace_kind: z.boolean().optional(),
});

export type RememberInput = z.infer<typeof rememberSchema>;

/**
 * Dedup-on-write is destructive: a >= 0.85 match whose existing content is
 * shorter is DELETED and replaced. Two guards keep that from silently breaking
 * an append-only contract:
 *
 * 1. Append-only entities (name matches a configured prefix) are exempt
 *    entirely — neither skipped nor replaced.
 * 2. Everywhere else, dedup only considers observations written on the SAME UTC
 *    calendar day. Entries written on different days can never evict each other,
 *    however similar they look.
 *
 * A >= 0.85 match blocked by either guard is not discarded — it is surfaced in
 * `near_matches` so the caller still sees the overlap, without losing data.
 *
 * Calendar-day equality rather than a rolling N-hour window: a rolling window
 * fails destructively at the midnight boundary (23:58 and 00:05 are 7 minutes
 * apart but are two different days' log entries). Day equality fails in the safe
 * direction — worst case a midnight-straddling retry stores a duplicate, which
 * `consolidate` already handles.
 */
function utcDay(timestamp: string | null | undefined): string | null {
  // created_at is SQLite datetime('now') — 'YYYY-MM-DD HH:MM:SS' in UTC.
  if (!timestamp || timestamp.length < 10) return null;
  return timestamp.slice(0, 10);
}

export function isAppendOnlyEntity(entityName: string): boolean {
  const name = entityName.toLowerCase();
  return config.appendOnlyPrefixes.some(prefix => name.startsWith(prefix));
}

export interface RememberResult {
  success: boolean;
  entityId: string;
  entityName: string;
  observationId: string;
  relationships_created: string[];
  message: string;
  version_hash?: string | null;
  deduplicated?: boolean;
  /** True whenever this write DELETED an existing observation. Always check this. */
  replaced?: boolean;
  replaced_observation?: string;
  replaced_observation_id?: string;
  replaced_count?: number;
  append_only?: boolean;
  near_matches?: Array<{ content: string; similarity: number }>;
  novelty?: number;
}

export async function remember(input: RememberInput): Promise<RememberResult> {
  const entityName = input.entity || 'general';
  const entity = findOrCreateEntity(entityName, input.type);

  // Kind-scoped upsert: delete existing observations with the same kind, then insert
  // Skips dedup entirely — the caller explicitly wants to replace
  if (input.replace_kind && input.kind) {
    const existing = getObservationsByEntityAndKind(entity.id, input.kind);
    const replacedCount = existing.length;

    for (const obs of existing) {
      deleteEmbedding(obs.id);
      deleteObservation(obs.id);
    }

    const vector = await generateEmbedding(input.content);
    const observation = createObservation(entity.id, input.content, input.source, input.importance ?? 1.0, input.kind);
    storeEmbedding(entity.id, observation.id, vector, input.content);

    const relationshipsCreated = detectAndCreateRelationships(entity, input.content);
    const updated = findEntityById(entity.id);

    return {
      success: true,
      entityId: entity.id,
      entityName: entity.name,
      observationId: observation.id,
      relationships_created: relationshipsCreated,
      message: replacedCount > 0
        ? `Replaced ${replacedCount} existing "${input.kind}" observation(s) for "${entity.name}"`
        : `Stored "${input.kind}" observation for "${entity.name}"`,
      version_hash: updated?.version_hash,
      replaced: replacedCount > 0,
      replaced_count: replacedCount,
    };
  }

  // Generate embedding first (needed for dedup check before creating observation)
  const vector = await generateEmbedding(input.content);

  // Dedup check: compare against existing observations for this entity.
  // Only same-UTC-day observations on a non-append-only entity are dedup-eligible
  // (see the guards documented above) — everything else can only ever be reported.
  const existing = getEmbeddingsByEntity(entity.id);
  const appendOnly = isAppendOnlyEntity(entity.name);
  const today = utcDay(new Date().toISOString());
  let bestMatch: { similarity: number; index: number } | null = null;
  const nearMatches: Array<{ content: string; similarity: number }> = [];

  for (let i = 0; i < existing.length; i++) {
    const sim = cosineSimilarity(vector, existing[i].vector);
    if (sim < NEAR_MATCH_THRESHOLD) continue;

    const sameDay = today !== null && utcDay(existing[i].created_at) === today;
    const dedupEligible = !appendOnly && sameDay;

    if (sim >= DEDUP_THRESHOLD && dedupEligible) {
      if (!bestMatch || sim > bestMatch.similarity) {
        bestMatch = { similarity: sim, index: i };
      }
    } else {
      // Includes >= 0.85 matches held back by a guard: report, never destroy.
      nearMatches.push({ content: existing[i].content, similarity: sim });
    }
  }

  // Keep top N near matches by similarity
  nearMatches.sort((a, b) => b.similarity - a.similarity);
  if (nearMatches.length > MAX_NEAR_MATCHES) nearMatches.length = MAX_NEAR_MATCHES;

  if (bestMatch) {
    const match = existing[bestMatch.index];

    if (match.content.length >= input.content.length) {
      // Existing is longer or equal — skip (already known)
      const current = findEntityById(entity.id);
      const result: RememberResult = {
        success: true,
        entityId: entity.id,
        entityName: entity.name,
        observationId: match.observation_id,
        relationships_created: [],
        message: `Deduplicated: similar observation already exists for "${entity.name}" (similarity: ${bestMatch.similarity.toFixed(3)}, same UTC day)`,
        version_hash: current?.version_hash,
        deduplicated: true,
        replaced: false,
      };
      if (nearMatches.length > 0) result.near_matches = nearMatches;
      return result;
    }

    // New content is longer — replace existing with new (more information).
    // Only reachable for a same-day match on a non-append-only entity.
    const replacedContent = match.content;
    const replacedId = match.observation_id;
    deleteEmbedding(match.observation_id);
    deleteObservation(match.observation_id);

    const observation = createObservation(entity.id, input.content, input.source, input.importance ?? 1.0, input.kind);
    storeEmbedding(entity.id, observation.id, vector, input.content);

    const relationshipsCreated = detectAndCreateRelationships(entity, input.content);
    const updated = findEntityById(entity.id);

    const result: RememberResult = {
      success: true,
      entityId: entity.id,
      entityName: entity.name,
      observationId: observation.id,
      relationships_created: relationshipsCreated,
      message: `Replaced shorter duplicate for "${entity.name}" (similarity: ${bestMatch.similarity.toFixed(3)}, same UTC day). DELETED the previous observation — its full text is in replaced_observation`,
      version_hash: updated?.version_hash,
      replaced: true,
      replaced_observation: replacedContent,
      replaced_observation_id: replacedId,
    };
    if (nearMatches.length > 0) result.near_matches = nearMatches;
    return result;
  }

  // No duplicate found — proceed normally
  const observation = createObservation(entity.id, input.content, input.source, input.importance ?? 1.0, input.kind);
  storeEmbedding(entity.id, observation.id, vector, input.content);

  const relationshipsCreated = detectAndCreateRelationships(entity, input.content);

  // Compute subspace novelty against all existing observations
  const novelty = existing.length > 0
    ? Math.round(computeNovelty(vector, existing.map(e => e.vector)) * 1000) / 1000
    : 1.0;

  const updatedEntity = findEntityById(entity.id);

  const result: RememberResult = {
    success: true,
    entityId: entity.id,
    entityName: entity.name,
    observationId: observation.id,
    relationships_created: relationshipsCreated,
    message: `Remembered: "${input.content.slice(0, 50)}${input.content.length > 50 ? '...' : ''}" for entity "${entity.name}"`,
    version_hash: updatedEntity?.version_hash,
    novelty,
    replaced: false,
  };

  if (appendOnly) {
    result.append_only = true;
    result.message += '. Append-only entity — stored without dedup';
  }

  if (novelty < 0.1) {
    result.message += '. Low novelty — this information may already be captured by existing observations';
  }

  if (nearMatches.length > 0) {
    result.near_matches = nearMatches;
    result.message += `. These existing observations overlap — consider consolidating (nothing was deleted): ${nearMatches.map(m => `"${m.content.slice(0, 40)}..." (${m.similarity.toFixed(3)})`).join(', ')}`;
  }

  return result;
}

const SKIP_ENTITIES = new Set(['general']);
const MIN_NAME_LENGTH = 3;

function detectAndCreateRelationships(sourceEntity: Entity, content: string): string[] {
  const entities = listEntities({ limit: 500 });
  const created: string[] = [];

  for (const candidate of entities) {
    // Skip self, default entity, and short names
    if (candidate.id === sourceEntity.id) continue;
    if (SKIP_ENTITIES.has(candidate.name)) continue;
    if (candidate.name.length < MIN_NAME_LENGTH) continue;

    // Word-boundary match (case-insensitive)
    // Escape regex special chars, then treat hyphens/underscores/spaces as interchangeable
    const escaped = candidate.name
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/[-_\s]+/g, '[-_\\s]+');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');

    if (pattern.test(content)) {
      // Don't create duplicates
      if (!relationshipExists(sourceEntity.id, candidate.id)) {
        createRelationship(sourceEntity.id, candidate.id, 'relates_to');
        created.push(candidate.name);
      }
    }
  }

  return created;
}
