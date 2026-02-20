import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listEntities, findEntityByName } from '../../db/entities.js';
import { getObservationsByEntity } from '../../db/observations.js';
import { getRelationshipsByEntity, getRelatedEntities } from '../../db/relationships.js';
import { formatClaudeMd, gatherEntityData } from '../tools/export.js';

export function registerContextResources(server: McpServer): void {
  // Full context — entire knowledge graph in compact claude-md format
  server.resource(
    'memory-context',
    'hippocampus://context',
    {
      description: 'Full memory context — all entities, observations, and relationships. Designed for injection into AI context windows at session start.',
      mimeType: 'text/markdown',
    },
    async () => {
      const entities = listEntities({ limit: 10000 });
      if (entities.length === 0) {
        return {
          contents: [{
            uri: 'hippocampus://context',
            text: '# Memory Export\n\nNo memories stored yet.\n',
            mimeType: 'text/markdown',
          }],
        };
      }

      const entitiesData = gatherEntityData(entities);
      const markdown = formatClaudeMd(entitiesData);

      return {
        contents: [{
          uri: 'hippocampus://context',
          text: markdown,
          mimeType: 'text/markdown',
        }],
      };
    }
  );

  // Per-entity context — single entity with observations, relationships, related entities
  const entityTemplate = new ResourceTemplate(
    'hippocampus://entity/{name}',
    {
      list: async () => {
        const entities = listEntities({ limit: 10000 });
        return {
          resources: entities.map(e => ({
            uri: `hippocampus://entity/${encodeURIComponent(e.name)}`,
            name: e.name,
            description: e.type ? `${e.type}: ${e.name}` : e.name,
            mimeType: 'text/markdown',
          })),
        };
      },
      complete: {
        name: async (value: string) => {
          const entities = listEntities({ limit: 10000 });
          const lower = value.toLowerCase();
          return entities
            .filter(e => e.name.toLowerCase().includes(lower))
            .map(e => e.name)
            .slice(0, 50);
        },
      },
    }
  );

  server.resource(
    'entity-context',
    entityTemplate,
    {
      description: 'Context for a single entity — observations, relationships, and related entities at depth 1.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const name = typeof variables.name === 'string'
        ? decodeURIComponent(variables.name)
        : decodeURIComponent(variables.name[0]);

      const entity = findEntityByName(name);
      if (!entity) {
        return {
          contents: [{
            uri: uri.href,
            text: `# Entity Not Found\n\nNo entity named "${name}" exists.\n`,
            mimeType: 'text/markdown',
          }],
        };
      }

      const observations = getObservationsByEntity(entity.id);
      const relationships = getRelationshipsByEntity(entity.id);
      const relatedMap = getRelatedEntities(entity.id, 1);

      // Build markdown
      const lines: string[] = [];

      const typeStr = entity.type ? ` (${entity.type})` : '';
      lines.push(`# ${entity.name}${typeStr}`, '');

      // Observations
      if (observations.length > 0) {
        lines.push('## Observations', '');
        for (const obs of observations) {
          lines.push(`- ${obs.content}`);
        }
        lines.push('');
      }

      // Relationships
      if (relationships.length > 0) {
        lines.push('## Relationships', '');
        for (const rel of relationships) {
          lines.push(`- ${rel.from_name} → ${rel.relation_type} → ${rel.to_name}`);
        }
        lines.push('');
      }

      // Related entities (depth 1) with their observations
      if (relatedMap.size > 0) {
        lines.push('## Related Entities', '');
        for (const [relId, info] of relatedMap) {
          const relTypeStr = info.type ? ` (${info.type})` : '';
          lines.push(`### ${info.name}${relTypeStr}`);
          const relObs = getObservationsByEntity(relId);
          for (const obs of relObs) {
            lines.push(`- ${obs.content}`);
          }
          lines.push('');
        }
      }

      return {
        contents: [{
          uri: uri.href,
          text: lines.join('\n').trimEnd() + '\n',
          mimeType: 'text/markdown',
        }],
      };
    }
  );
}
