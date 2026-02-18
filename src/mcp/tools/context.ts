import { findEntityByName, findEntityById, searchEntities } from '../../db/entities.js';
import { getObservationsByEntity, type Observation } from '../../db/observations.js';
import { getRelationshipsByEntity, getRelatedEntities } from '../../db/relationships.js';
import { semanticSearch } from '../../embeddings/embedder.js';

export interface ContextInput {
  topic: string;
  depth?: number;
}

interface EntityContext {
  name: string;
  type: string | null;
  observations: Array<{ content: string; source: string | null; remembered_at: string }>;
}

interface RelationshipInfo {
  from: string;
  to: string;
  type: string;
}

export interface ContextResult {
  success: boolean;
  entity?: EntityContext;
  relationships: RelationshipInfo[];
  related_entities: EntityContext[];
  message: string;
}

export async function context(input: ContextInput): Promise<ContextResult> {
  const depth = Math.min(Math.max(input.depth ?? 1, 0), 3);

  // Find entity: exact → LIKE → semantic fallback
  let entity = findEntityByName(input.topic);

  if (!entity) {
    const likeResults = searchEntities(input.topic);
    if (likeResults.length > 0) {
      entity = likeResults[0];
    }
  }

  if (!entity) {
    // Semantic fallback: search for memories about this topic
    // Require minimum similarity to avoid false matches on unrelated queries
    const SEMANTIC_THRESHOLD = 0.2;
    const semanticResults = await semanticSearch(input.topic, { limit: 5 }).catch(() => []);
    if (semanticResults.length > 0 && semanticResults[0].similarity >= SEMANTIC_THRESHOLD) {
      entity = findEntityById(semanticResults[0].entity_id) ?? undefined;
    }
  }

  if (!entity) {
    return {
      success: false,
      relationships: [],
      related_entities: [],
      message: `No entity found for topic "${input.topic}".`,
    };
  }

  // Get observations for the main entity
  const observations = getObservationsByEntity(entity.id);
  const entityContext: EntityContext = {
    name: entity.name,
    type: entity.type,
    observations: observations.map(formatObs),
  };

  // Get direct relationships
  const rels = getRelationshipsByEntity(entity.id);
  const relationships: RelationshipInfo[] = rels.map(r => ({
    from: r.from_name,
    to: r.to_name,
    type: r.relation_type,
  }));

  // Follow relationships via BFS to depth N
  const relatedMap = getRelatedEntities(entity.id, depth);
  const relatedEntities: EntityContext[] = [];

  for (const [relId, info] of relatedMap) {
    const relObs = getObservationsByEntity(relId);
    relatedEntities.push({
      name: info.name,
      type: info.type,
      observations: relObs.map(formatObs),
    });
  }

  return {
    success: true,
    entity: entityContext,
    relationships,
    related_entities: relatedEntities,
    message: `Found "${entity.name}" with ${observations.length} observations, ${relationships.length} relationships, and ${relatedEntities.length} related entities.`,
  };
}

function formatObs(obs: Observation) {
  return {
    content: obs.content,
    source: obs.source,
    remembered_at: obs.created_at,
  };
}
