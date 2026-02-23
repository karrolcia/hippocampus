import { listEntities, findEntityByName, type Entity } from '../../db/entities.js';
import { getObservationsByEntity, type Observation } from '../../db/observations.js';
import { getRelationshipsByEntity, type RelationshipWithNames } from '../../db/relationships.js';

export interface ExportInput {
  format: 'claude-md' | 'markdown' | 'json' | 'wire' | 'obsidian';
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
    case 'wire':
      data = formatExportWire(entitiesData, allRelationships);
      break;
    case 'obsidian':
      data = formatObsidian(entitiesData, allRelationships);
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

/**
 * Trim entities data to fit within an observation budget.
 * Entities are already sorted by updated_at DESC from listEntities.
 * Includes full entities until budget is hit, then partial-includes the
 * last entity (newest observations first, since getObservationsByEntity
 * returns created_at DESC).
 */
export function budgetTrim(entitiesData: EntityData[], maxObservations: number): EntityData[] {
  const result: EntityData[] = [];
  let remaining = maxObservations;

  for (const ed of entitiesData) {
    if (remaining <= 0) break;

    if (ed.observations.length <= remaining) {
      result.push(ed);
      remaining -= ed.observations.length;
    } else {
      // Partial include — take first `remaining` observations (already ordered newest-first)
      result.push({
        entity: ed.entity,
        observations: ed.observations.slice(0, remaining),
        relationships: ed.relationships,
      });
      remaining = 0;
    }
  }

  return result;
}

/** Compact context file — entities grouped by type, observations as bullets. */
export function formatClaudeMd(entitiesData: EntityData[], maxObservations?: number): string {
  const trimmed = maxObservations !== undefined
    ? budgetTrim(entitiesData, maxObservations)
    : entitiesData;

  const grouped = new Map<string, EntityData[]>();

  for (const ed of trimmed) {
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
        kind: obs.kind,
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

/** Minimal wire format — lowest tokens. */
function formatExportWire(entitiesData: EntityData[], allRelationships: RelationshipWithNames[]): string {
  const sections: string[] = [];

  for (const { entity, observations } of entitiesData) {
    const typeStr = entity.type ? `|${entity.type}` : '';
    const lines = [`#E ${entity.name}${typeStr}`];
    for (const obs of observations) {
      lines.push(`- ${obs.content}`);
    }
    sections.push(lines.join('\n'));
  }

  if (allRelationships.length > 0) {
    const relLines: string[] = [];
    for (const rel of allRelationships) {
      relLines.push(`#R ${rel.from_name}\u2192${rel.relation_type}\u2192${rel.to_name}`);
    }
    sections.push(relLines.join('\n'));
  }

  return sections.join('\n\n');
}

/** Obsidian vault export — returns JSON with files array. */
function formatObsidian(entitiesData: EntityData[], allRelationships: RelationshipWithNames[]): string {
  const files: Array<{ path: string; content: string }> = [];

  // Build relationship lookup: entity name → list of relationship descriptions
  const relsByEntity = new Map<string, string[]>();
  for (const rel of allRelationships) {
    const fromList = relsByEntity.get(rel.from_name) ?? [];
    fromList.push(`- ${rel.relation_type} [[${slugify(rel.to_name)}|${rel.to_name}]]`);
    relsByEntity.set(rel.from_name, fromList);

    const toList = relsByEntity.get(rel.to_name) ?? [];
    toList.push(`- ${rel.relation_type} (from [[${slugify(rel.from_name)}|${rel.from_name}]])`);
    relsByEntity.set(rel.to_name, toList);
  }

  for (const { entity, observations } of entitiesData) {
    const created = entity.created_at?.split('T')[0] ?? '';
    const updated = entity.updated_at?.split('T')[0] ?? '';

    const lines: string[] = [
      '---',
      ...(entity.type ? [`type: ${entity.type}`] : []),
      ...(created ? [`created: ${created}`] : []),
      ...(updated ? [`updated: ${updated}`] : []),
      `observations: ${observations.length}`,
      '---',
      '',
      `# ${entity.name}`,
      '',
    ];

    for (const obs of observations) {
      lines.push(`- ${obs.content}`);
    }

    const rels = relsByEntity.get(entity.name);
    if (rels && rels.length > 0) {
      lines.push('', '## Relationships', '');
      for (const r of rels) {
        lines.push(r);
      }
    }

    files.push({
      path: `${slugify(entity.name)}.md`,
      content: lines.join('\n') + '\n',
    });
  }

  return JSON.stringify({ files }, null, 2);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
