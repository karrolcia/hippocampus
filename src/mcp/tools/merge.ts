import { getObservationsByIds, deleteObservation, createObservation } from '../../db/observations.js';
import { findEntityById } from '../../db/entities.js';
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

  // Create new merged observation + embedding
  const vector = await generateEmbedding(input.content);
  const newObservation = createObservation(entityId, input.content, source ?? undefined);
  storeEmbedding(entityId, newObservation.id, vector, input.content);

  // Delete old observations + embeddings (embedding first, then observation — same order as forget)
  for (const obs of observations) {
    deleteEmbedding(obs.id);
    deleteObservation(obs.id);
  }

  return {
    success: true,
    new_observation_id: newObservation.id,
    merged_count: observations.length,
    entity_name: entity.name,
    message: `Merged ${observations.length} observations into one for "${entity.name}".`,
  };
}
