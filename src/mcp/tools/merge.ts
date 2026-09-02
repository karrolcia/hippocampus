import { getObservationsByIds, deleteObservation, createObservation } from '../../db/observations.js';
import { findEntityById, updateEntityTimestamp } from '../../db/entities.js';
import { generateEmbedding, storeEmbedding, deleteEmbedding } from '../../embeddings/embedder.js';

export interface MergeInput {
  observation_ids: string[];
  content: string;
}

export interface MergeResult {
  success: boolean;
  new_observation_id: string;
  merged_count: number;
  entity_name: string;
  message: string;
  // Disclosed so the caller can see what classification survived — the sources
  // are deleted, so there is nothing else to check it against (mirrors update()).
  kind: string | null;
  importance: number;
  version_hash?: string | null;
}

export async function merge(input: MergeInput): Promise<MergeResult> {
  // Validate all observation IDs exist
  const observations = getObservationsByIds(input.observation_ids);
  const foundIds = new Set(observations.map(o => o.id));
  const missingIds = input.observation_ids.filter(id => !foundIds.has(id));

  if (missingIds.length > 0) {
    throw new Error(`Observations not found: ${missingIds.join(', ')}`);
  }

  // Validate all belong to the same entity
  const entityIds = new Set(observations.map(o => o.entity_id));
  if (entityIds.size > 1) {
    throw new Error('All observations must belong to the same entity. Found observations from multiple entities.');
  }

  const entityId = observations[0].entity_id;
  const entity = findEntityById(entityId);
  if (!entity) {
    throw new Error(`Entity ${entityId} not found.`);
  }

  // Collect source from originals (prefer non-null, take first found)
  const source = observations.find(o => o.source !== null)?.source ?? null;

  // Carry metadata through from the sources. `createObservation` defaults
  // `kind -> null` and `importance -> 1.0`, so passing neither — as this did
  // until now — silently stripped the classification every source carried.
  // Same defect that was fixed for `update()`; `merge()` never got it.
  //
  // `kind`: a merge may NOT silently pick a winner. Two or more distinct kinds
  // are a conflict only the caller can resolve, because the curated tier is
  // kind-load-bearing (`skill:*` splits trigger/content, `block:*` splits
  // idea/seed) and a wrong kind fails silently — the text survives, only the
  // classification dies. `null` is "no opinion", not a third kind, so
  // [null, "trigger"] carries "trigger" rather than rejecting.
  // An empty string is "no opinion" too: the zod boundary now rejects it, but a
  // row written before that guard (or by a direct caller) must not surface as a
  // third kind named `""` in the refusal.
  const kinds = [...new Set(observations.map(o => o.kind).filter((k): k is string => k != null && k !== ''))];
  if (kinds.length > 1) {
    throw new Error(
      `Cannot merge observations with different kinds: ${kinds.map(k => `"${k}"`).join(', ')}. ` +
        'A merged observation cannot carry two classifications, and picking one silently would ' +
        'drop the other. Merge each kind separately, or update() the sources to a common kind first.'
    );
  }
  const kind: string | undefined = kinds[0];

  // `importance`: take the maximum. The merged observation holds all of the
  // sources' content, so it is at least as important as its most important
  // source. Taking the min would silently de-prioritise material; falling back
  // to the 1.0 default (the old behaviour) silently PROMOTES a uniformly
  // de-prioritised group, since 1.0 is the schema ceiling, not a neutral value.
  // The column is `REAL DEFAULT 1.0` without NOT NULL, so guard a null row:
  // `Math.max(null, …)` reads null as 0 — a silent demotion, the mirror of the
  // bug being fixed. The validation above guarantees a non-empty list.
  const importance = observations.reduce((max, o) => Math.max(max, o.importance ?? 1.0), 0);

  // Create new merged observation + embedding
  const vector = await generateEmbedding(input.content);
  const newObservation = createObservation(entityId, input.content, source ?? undefined, importance, kind);
  storeEmbedding(entityId, newObservation.id, vector, input.content);

  // Delete old observations + embeddings (embedding first, then observation — same order as forget)
  for (const obs of observations) {
    deleteEmbedding(obs.id);
    deleteObservation(obs.id);
  }

  // Refresh version hash after mutation
  updateEntityTimestamp(entityId);
  const updated = findEntityById(entityId);

  return {
    success: true,
    new_observation_id: newObservation.id,
    merged_count: observations.length,
    entity_name: entity.name,
    message: `Merged ${observations.length} observations into one for "${entity.name}".`,
    kind: newObservation.kind,
    importance: newObservation.importance,
    version_hash: updated?.version_hash,
  };
}
