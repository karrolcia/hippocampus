import { findEntityByName, findEntityById, updateEntityTimestamp } from '../../db/entities.js';
import { getObservationsByEntity, createObservation, deleteObservation } from '../../db/observations.js';
import { generateEmbedding, storeEmbedding, deleteEmbedding } from '../../embeddings/embedder.js';

export interface UpdateInput {
  entity: string;
  old_content: string;
  new_content: string;
  kind?: string;
}

export interface UpdateResult {
  success: boolean;
  message: string;
  observationId?: string;
  kind?: string | null;
  version_hash?: string | null;
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

  // Create new observation + embedding. Carry over the old observation's
  // metadata — `kind` and `importance` survive the replacement unless the
  // caller explicitly sets a new kind.
  const newObs = createObservation(
    entity.id,
    input.new_content,
    target.source ?? undefined,
    target.importance,
    input.kind ?? target.kind ?? undefined
  );
  const vector = await generateEmbedding(input.new_content);
  storeEmbedding(entity.id, newObs.id, vector, input.new_content);

  // Delete old observation + embedding
  deleteEmbedding(target.id);
  deleteObservation(target.id);

  updateEntityTimestamp(entity.id);

  const updated = findEntityById(entity.id);

  return {
    success: true,
    message: `Updated observation for entity "${input.entity}".`,
    observationId: newObs.id,
    kind: newObs.kind,
    version_hash: updated?.version_hash,
  };
}
