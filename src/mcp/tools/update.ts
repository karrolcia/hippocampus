import { findEntityByName, updateEntityTimestamp } from '../../db/entities.js';
import { getObservationsByEntity, createObservation, deleteObservation } from '../../db/observations.js';
import { generateEmbedding, storeEmbedding, deleteEmbedding } from '../../embeddings/embedder.js';

export interface UpdateInput {
  entity: string;
  old_content: string;
  new_content: string;
}

export interface UpdateResult {
  success: boolean;
  message: string;
  observationId?: string;
}

export async function update(input: UpdateInput): Promise<UpdateResult> {
  const entity = findEntityByName(input.entity);
  if (!entity) {
    return {
      success: false,
      message: `Entity "${input.entity}" not found.`,
    };
  }

  // Find observation with exact content match
  const observations = getObservationsByEntity(entity.id);
  const target = observations.find(o => o.content === input.old_content);
  if (!target) {
    return {
      success: false,
      message: `No observation matching the old content found for entity "${input.entity}".`,
    };
  }

  // Create new observation + embedding
  const newObs = createObservation(entity.id, input.new_content, target.source ?? undefined);
  const vector = await generateEmbedding(input.new_content);
  storeEmbedding(entity.id, newObs.id, vector, input.new_content);

  // Delete old observation + embedding
  deleteEmbedding(target.id);
  deleteObservation(target.id);

  updateEntityTimestamp(entity.id);

  return {
    success: true,
    message: `Updated observation for entity "${input.entity}".`,
    observationId: newObs.id,
  };
}
