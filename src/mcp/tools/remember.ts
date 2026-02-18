import { z } from 'zod';
import { findOrCreateEntity, listEntities, type Entity } from '../../db/entities.js';
import { createObservation } from '../../db/observations.js';
import { createRelationship, relationshipExists } from '../../db/relationships.js';
import { generateEmbedding, storeEmbedding } from '../../embeddings/embedder.js';

export const rememberSchema = z.object({
  content: z
    .string()
    .min(1, 'Content is required')
    .max(2000, 'Content must be 2000 characters or less')
    .transform(s => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')),
  entity: z
    .string()
    .max(200, 'Entity name must be 200 characters or less')
    .optional()
    .transform(s => s?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')),
  type: z.string().max(50).optional(),
  source: z.string().max(100).optional(),
});

export type RememberInput = z.infer<typeof rememberSchema>;

export interface RememberResult {
  success: boolean;
  entityId: string;
  entityName: string;
  observationId: string;
  relationships_created: string[];
  message: string;
}

export async function remember(input: RememberInput): Promise<RememberResult> {
  const entityName = input.entity || 'general';
  const entity = findOrCreateEntity(entityName, input.type);
  const observation = createObservation(entity.id, input.content, input.source);

  // Generate and store embedding
  const vector = await generateEmbedding(input.content);
  storeEmbedding(entity.id, observation.id, vector, input.content);

  // Auto-detect relationships from content
  const relationshipsCreated = detectAndCreateRelationships(entity, input.content);

  return {
    success: true,
    entityId: entity.id,
    entityName: entity.name,
    observationId: observation.id,
    relationships_created: relationshipsCreated,
    message: `Remembered: "${input.content.slice(0, 50)}${input.content.length > 50 ? '...' : ''}" for entity "${entity.name}"`,
  };
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
