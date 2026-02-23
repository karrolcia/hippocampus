import { z } from 'zod';
import { getDatabase } from '../../db/index.js';
import { findEntityByName, findOrCreateEntity, deleteEntity } from '../../db/entities.js';
import { moveObservationsToEntity } from '../../db/observations.js';
import { moveEmbeddingsToEntity } from '../../embeddings/embedder.js';
import { mergeRelationships } from '../../db/relationships.js';

export const mergeEntitiesSchema = z.object({
  source_entities: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(10),
  target_entity: z.string().min(1).max(200),
  target_type: z.string().max(50).optional(),
});

export type MergeEntitiesInput = z.infer<typeof mergeEntitiesSchema>;

export interface MergeEntitiesResult {
  success: boolean;
  target_entity: string;
  merged_count: number;
  observations_moved: number;
  embeddings_moved: number;
  relationships_updated: number;
  deleted_entities: string[];
  message: string;
}

export function mergeEntities(input: MergeEntitiesInput): MergeEntitiesResult {
  const db = getDatabase();

  // Reject self-merge: target in source_entities
  if (input.source_entities.includes(input.target_entity)) {
    throw new Error('Target entity cannot appear in source_entities (self-merge)');
  }

  // Validate all source entities exist
  const sourceEntities = input.source_entities.map(name => {
    const entity = findEntityByName(name);
    if (!entity) {
      throw new Error(`Source entity not found: "${name}"`);
    }
    return entity;
  });

  // Find or create target entity
  const targetEntity = findOrCreateEntity(input.target_entity, input.target_type);

  let totalObservations = 0;
  let totalEmbeddings = 0;
  let totalRelationships = 0;
  const deletedEntities: string[] = [];

  // Execute merge in a transaction
  const transaction = db.transaction(() => {
    for (const source of sourceEntities) {
      // Move observations
      const obsMoved = moveObservationsToEntity(source.id, targetEntity.id);
      totalObservations += obsMoved;

      // Move embeddings
      const embMoved = moveEmbeddingsToEntity(source.id, targetEntity.id);
      totalEmbeddings += embMoved;

      // Move and deduplicate relationships
      const relUpdated = mergeRelationships(source.id, targetEntity.id);
      totalRelationships += relUpdated;

      // Delete the now-empty source entity
      deleteEntity(source.id);
      deletedEntities.push(source.name);
    }
  });

  transaction();

  return {
    success: true,
    target_entity: targetEntity.name,
    merged_count: sourceEntities.length,
    observations_moved: totalObservations,
    embeddings_moved: totalEmbeddings,
    relationships_updated: totalRelationships,
    deleted_entities: deletedEntities,
    message: `Merged ${sourceEntities.length} entities into "${targetEntity.name}": ${totalObservations} observations, ${totalEmbeddings} embeddings, ${totalRelationships} relationship updates`,
  };
}
