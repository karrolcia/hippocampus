import { findEntityByName, deleteEntity, updateEntityTimestamp } from '../../db/entities.js';
import {
  deleteObservation,
  deleteObservationsByEntity,
  getObservationsByEntity,
  getObservationsByIds,
} from '../../db/observations.js';
import { deleteEmbedding, deleteEmbeddingsByEntity } from '../../embeddings/embedder.js';
import { deleteRelationshipsByEntity } from '../../db/relationships.js';

export interface ForgetInput {
  entity?: string;
  observation_id?: string;
  content?: string;
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

const NOTHING_DELETED = { observations: 0, embeddings: 0, relationships: 0, entity: false };

export function forget(input: ForgetInput): ForgetResult {
  if (!input.entity && !input.observation_id) {
    return {
      success: false,
      message:
        input.content !== undefined
          ? 'content requires an entity name to scope the match. Nothing deleted.'
          : 'Either entity name or observation_id is required.',
      deleted: { ...NOTHING_DELETED },
    };
  }

  // Delete by specific observation ID
  if (input.observation_id) {
    // Grab the row first — we need its entity_id to refresh the version hash
    const [target] = getObservationsByIds([input.observation_id]);
    // Delete embedding first — cascade from observation deletion would hide the count
    const embDeleted = deleteEmbedding(input.observation_id);
    const obsDeleted = deleteObservation(input.observation_id);
    if (obsDeleted && target) updateEntityTimestamp(target.entity_id);
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

  // Delete a single observation by exact content match — never widens to the
  // whole entity. A scoped delete that misses deletes nothing.
  if (input.content !== undefined) {
    const entity = findEntityByName(input.entity!);
    if (!entity) {
      return {
        success: false,
        message: `Entity "${input.entity}" not found.`,
        deleted: { ...NOTHING_DELETED },
      };
    }
    const target = getObservationsByEntity(entity.id).find(o => o.content === input.content);
    if (!target) {
      return {
        success: false,
        message: `No observation matching the given content found for entity "${input.entity}". Nothing deleted.`,
        deleted: { ...NOTHING_DELETED },
      };
    }
    const embDeleted = deleteEmbedding(target.id);
    const obsDeleted = deleteObservation(target.id);
    updateEntityTimestamp(entity.id);
    return {
      success: obsDeleted,
      message: `Deleted 1 observation from entity "${input.entity}" (matched by content). Entity kept.`,
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
      deleted: { ...NOTHING_DELETED },
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
