import { listEntities, findEntityByName, type Entity } from '../../db/entities.js';
import { getObservationsByEntity, type Observation } from '../../db/observations.js';
import { getRelationshipsByEntity, type RelationshipWithNames } from '../../db/relationships.js';

export interface ExportInput {
  format: 'claude-md' | 'markdown' | 'json';
  entity?: string;
  type?: string;
}

export interface ExportResult {
  success: boolean;
  format: string;
  entity_count: number;
  observation_count: number;
  data: string;
  message: string;
}

export interface EntityData {
  entity: Entity;
  observations: Observation[];
  relationships: RelationshipWithNames[];
}

/** Fetch observations and relationships for a list of entities. */
export function gatherEntityData(entities: Entity[]): EntityData[] {
  const entitiesData: EntityData[] = [];
  for (const entity of entities) {
    const observations = getObservationsByEntity(entity.id);
    const relationships = getRelationshipsByEntity(entity.id);
    entitiesData.push({ entity, observations, relationships });
  }
  return entitiesData;
}

export function exportMemories(input: ExportInput): ExportResult {
  // Resolve entity list
  let entities: Entity[];

  if (input.entity) {
    const entity = findEntityByName(input.entity);
    if (!entity) {
      return {
        success: false,
        format: input.format,
        entity_count: 0,
        observation_count: 0,
        data: '',
        message: `Entity "${input.entity}" not found.`,
      };
    }
    entities = [entity];
  } else {
    entities = listEntities({ type: input.type, limit: 10000 });
  }

  if (entities.length === 0) {
    return {
      success: true,
      format: input.format,
      entity_count: 0,
      observation_count: 0,
      data: '',
      message: input.type
        ? `No entities found with type "${input.type}".`
        : 'No entities found.',
    };
  }

  // Fetch observations and relationships for each entity
  const entitiesData = gatherEntityData(entities);
  let totalObservations = 0;
  for (const ed of entitiesData) totalObservations += ed.observations.length;

  // Deduplicate relationships across entities (same rel appears under both ends)
  const allRelationships = deduplicateRelationships(entitiesData);

  // Format output
  let data: string;
  switch (input.format) {
    case 'claude-md':
      data = formatClaudeMd(entitiesData);
      break;
    case 'markdown':
      data = formatMarkdown(entitiesData, allRelationships);
      break;
    case 'json':
      data = formatJson(entitiesData, allRelationships);
      break;
  }

  return {
    success: true,
    format: input.format,
    entity_count: entities.length,
    observation_count: totalObservations,
    data,
    message: `Exported ${entities.length} entities with ${totalObservations} observations.`,
  };
}

export function deduplicateRelationships(entitiesData: EntityData[]): RelationshipWithNames[] {
  const seen = new Set<string>();
  const unique: RelationshipWithNames[] = [];

  for (const { relationships } of entitiesData) {
    for (const rel of relationships) {
      if (!seen.has(rel.id)) {
        seen.add(rel.id);
        unique.push(rel);
      }
    }
  }

  return unique;
}

/** Compact context file — entities grouped by type, observations as bullets. */
export function formatClaudeMd(entitiesData: EntityData[]): string {
  const grouped = new Map<string, EntityData[]>();

  for (const ed of entitiesData) {
    const typeLabel = ed.entity.type ?? 'general';
    if (!grouped.has(typeLabel)) {
      grouped.set(typeLabel, []);
    }
    grouped.get(typeLabel)!.push(ed);
  }

  const lines: string[] = ['# Memory Export', ''];

  for (const [typeLabel, group] of grouped) {
    lines.push(`## ${capitalize(typeLabel)}`, '');

    for (const { entity, observations } of group) {
      lines.push(`### ${entity.name}`);
      for (const obs of observations) {
        lines.push(`- ${obs.content}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

/** Full readable export with metadata. */
export function formatMarkdown(entitiesData: EntityData[], allRelationships: RelationshipWithNames[]): string {
  const lines: string[] = [
    '# Hippocampus Memory Export',
    `Generated: ${new Date().toISOString()}`,
    '',
  ];

  for (const { entity, observations, relationships } of entitiesData) {
    const typeStr = entity.type ? ` (${entity.type})` : '';
    lines.push(`## ${entity.name}${typeStr}`);

    for (const obs of observations) {
      const meta: string[] = [];
      if (obs.created_at) meta.push(obs.created_at.split('T')[0] ?? obs.created_at);
      if (obs.source) meta.push(`source: ${obs.source}`);
      const suffix = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
      lines.push(`- ${obs.content}${suffix}`);
    }

    // Show relationships for this entity
    if (relationships.length > 0) {
      lines.push('', '### Relationships');
      for (const rel of relationships) {
        lines.push(`- ${rel.from_name} → ${rel.relation_type} → ${rel.to_name}`);
      }
    }

    lines.push('', '---', '');
  }

  return lines.join('\n').trimEnd() + '\n';
}

// Structured JSON for portability/backup
function formatJson(entitiesData: EntityData[], allRelationships: RelationshipWithNames[]): string {
  const exportData = {
    exported_at: new Date().toISOString(),
    entities: entitiesData.map(({ entity, observations }) => ({
      name: entity.name,
      type: entity.type,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
      observations: observations.map(obs => ({
        id: obs.id,
        content: obs.content,
        source: obs.source,
        created_at: obs.created_at,
      })),
    })),
    relationships: allRelationships.map(rel => ({
      from: rel.from_name,
      to: rel.to_name,
      relation_type: rel.relation_type,
      created_at: rel.created_at,
    })),
  };

  return JSON.stringify(exportData, null, 2);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
