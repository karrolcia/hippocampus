import { findEntityByName, deleteEntity } from '../../db/entities.js';
import { deleteObservation, deleteObservationsByEntity } from '../../db/observations.js';
import { deleteEmbedding, deleteEmbeddingsByEntity } from '../../embeddings/embedder.js';
import { deleteRelationshipsByEntity } from '../../db/relationships.js';

export interface ForgetInput {
  entity?: string;
  observation_id?: string;
}

export interface ForgetResult {
  success: boolean;
  message: string;
  deleted: {
    observations: number;
    embeddings: number;
    relationships: number;
    entity: boolean;
  };
}

export function forget(input: ForgetInput): ForgetResult {
  if (!input.entity && !input.observation_id) {
    return {
      success: false,
      message: 'Either entity name or observation_id is required.',
      deleted: { observations: 0, embeddings: 0, relationships: 0, entity: false },
    };
  }

  // Delete by specific observation ID
  if (input.observation_id) {
    // Delete embedding first — cascade from observation deletion would hide the count
    const embDeleted = deleteEmbedding(input.observation_id);
    const obsDeleted = deleteObservation(input.observation_id);
    return {
      success: obsDeleted,
      message: obsDeleted
        ? `Deleted observation ${input.observation_id}.`
        : `Observation ${input.observation_id} not found.`,
      deleted: {
        observations: obsDeleted ? 1 : 0,
        embeddings: embDeleted ? 1 : 0,
        relationships: 0,
        entity: false,
      },
    };
  }

  // Delete entire entity and all related data
  const entity = findEntityByName(input.entity!);
  if (!entity) {
    return {
      success: false,
      message: `Entity "${input.entity}" not found.`,
      deleted: { observations: 0, embeddings: 0, relationships: 0, entity: false },
    };
  }

  const embCount = deleteEmbeddingsByEntity(entity.id);
  const obsCount = deleteObservationsByEntity(entity.id);
  const relCount = deleteRelationshipsByEntity(entity.id);
  const entityDeleted = deleteEntity(entity.id);

  return {
    success: true,
    message: `Forgot entity "${input.entity}" and all associated data.`,
    deleted: {
      observations: obsCount,
      embeddings: embCount,
      relationships: relCount,
      entity: entityDeleted,
    },
  };
}
