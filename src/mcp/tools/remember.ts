import { z } from 'zod';
import { findOrCreateEntity, listEntities, type Entity } from '../../db/entities.js';
import { createObservation, deleteObservation } from '../../db/observations.js';
import { createRelationship, relationshipExists } from '../../db/relationships.js';
import { generateEmbedding, storeEmbedding, getEmbeddingsByEntity, deleteEmbedding } from '../../embeddings/embedder.js';

const DEDUP_THRESHOLD = 0.85;

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
  deduplicated?: boolean;
  replaced_observation?: string;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export async function remember(input: RememberInput): Promise<RememberResult> {
  const entityName = input.entity || 'general';
  const entity = findOrCreateEntity(entityName, input.type);

  // Generate embedding first (needed for dedup check before creating observation)
  const vector = await generateEmbedding(input.content);

  // Dedup check: compare against existing observations for this entity
  const existing = getEmbeddingsByEntity(entity.id);
  let bestMatch: { similarity: number; index: number } | null = null;

  for (let i = 0; i < existing.length; i++) {
    const sim = cosineSimilarity(vector, existing[i].vector);
    if (sim >= DEDUP_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
      bestMatch = { similarity: sim, index: i };
    }
  }

  if (bestMatch) {
    const match = existing[bestMatch.index];

    if (match.content.length >= input.content.length) {
      // Existing is longer or equal — skip (already known)
      return {
        success: true,
        entityId: entity.id,
        entityName: entity.name,
        observationId: match.observation_id,
        relationships_created: [],
        message: `Deduplicated: similar observation already exists for "${entity.name}" (similarity: ${bestMatch.similarity.toFixed(3)})`,
        deduplicated: true,
      };
    }

    // New content is longer — replace existing with new (more information)
    const replacedContent = match.content;
    deleteEmbedding(match.observation_id);
    deleteObservation(match.observation_id);

    const observation = createObservation(entity.id, input.content, input.source);
    storeEmbedding(entity.id, observation.id, vector, input.content);

    const relationshipsCreated = detectAndCreateRelationships(entity, input.content);

    return {
      success: true,
      entityId: entity.id,
      entityName: entity.name,
      observationId: observation.id,
      relationships_created: relationshipsCreated,
      message: `Replaced shorter duplicate for "${entity.name}" (similarity: ${bestMatch.similarity.toFixed(3)})`,
      replaced_observation: replacedContent,
    };
  }

  // No duplicate found — proceed normally
  const observation = createObservation(entity.id, input.content, input.source);
  storeEmbedding(entity.id, observation.id, vector, input.content);

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
