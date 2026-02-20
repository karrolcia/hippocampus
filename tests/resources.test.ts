import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-resources-${Date.now()}.db`);

// Must set env before importing project modules (config.ts reads eagerly)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-resources';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { findOrCreateEntity, listEntities, findEntityByName } = await import('../src/db/entities.js');
const { createObservation, getObservationsByEntity } = await import('../src/db/observations.js');
const { createRelationship, getRelationshipsByEntity, getRelatedEntities } = await import('../src/db/relationships.js');
const { formatClaudeMd, gatherEntityData } = await import('../src/mcp/tools/export.js');
const { registerContextResources } = await import('../src/mcp/resources/context.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

describe('MCP Resources — Context', () => {
  before(() => {
    initDatabase();
  });

  after(() => {
    closeDatabase();
    // Clean up temp DB and WAL/SHM files
    for (const suffix of ['', '-wal', '-shm']) {
      const path = DB_PATH + suffix;
      if (existsSync(path)) unlinkSync(path);
    }
  });

  describe('full context (hippocampus://context)', () => {
    test('empty database returns empty claude-md', () => {
      const entities = listEntities({ limit: 10000 });
      assert.equal(entities.length, 0);

      // Matches what the resource callback does for empty state
      const entitiesData = gatherEntityData(entities);
      assert.equal(entitiesData.length, 0);
    });

    test('returns all entities in claude-md format after seeding', () => {
      // Seed entities
      const karolina = findOrCreateEntity('karolina', 'person');
      const hippocampus = findOrCreateEntity('hippocampus', 'project');
      const rebelStrategyLab = findOrCreateEntity('rebel-strategy-lab', 'project');

      // Seed observations
      createObservation(karolina.id, 'PhD atmospheric physics, TU Delft');
      createObservation(karolina.id, 'Based in Helsinki, relocating to Stockholm');
      createObservation(hippocampus.id, 'Open-source MCP memory server');
      createObservation(hippocampus.id, 'SQLCipher encryption at rest');
      createObservation(rebelStrategyLab.id, 'Strategy consulting + leadership coaching');

      // Seed relationships
      createRelationship(karolina.id, hippocampus.id, 'created');
      createRelationship(karolina.id, rebelStrategyLab.id, 'runs');

      // Exercise the same code path as the resource callback
      const entities = listEntities({ limit: 10000 });
      assert.equal(entities.length, 3);

      const entitiesData = gatherEntityData(entities);
      assert.equal(entitiesData.length, 3);

      const markdown = formatClaudeMd(entitiesData);

      // Structural assertions
      assert.ok(markdown.startsWith('# Memory Export\n'));
      assert.ok(markdown.includes('## Person'));
      assert.ok(markdown.includes('## Project'));
      assert.ok(markdown.includes('### karolina'));
      assert.ok(markdown.includes('### hippocampus'));
      assert.ok(markdown.includes('### rebel-strategy-lab'));
      assert.ok(markdown.includes('- PhD atmospheric physics, TU Delft'));
      assert.ok(markdown.includes('- Open-source MCP memory server'));
      assert.ok(markdown.includes('- Strategy consulting + leadership coaching'));
    });
  });

  describe('per-entity context (hippocampus://entity/{name})', () => {
    test('returns observations, relationships, and related entities for known entity', () => {
      const entity = findEntityByName('karolina');
      assert.ok(entity, 'Entity "karolina" should exist');

      const observations = getObservationsByEntity(entity.id);
      assert.equal(observations.length, 2);

      const relationships = getRelationshipsByEntity(entity.id);
      assert.equal(relationships.length, 2);

      const relatedMap = getRelatedEntities(entity.id, 1);
      assert.equal(relatedMap.size, 2); // hippocampus + rebel-strategy-lab

      // Build markdown the same way the resource callback does
      const lines: string[] = [];
      const typeStr = entity.type ? ` (${entity.type})` : '';
      lines.push(`# ${entity.name}${typeStr}`, '');

      if (observations.length > 0) {
        lines.push('## Observations', '');
        for (const obs of observations) {
          lines.push(`- ${obs.content}`);
        }
        lines.push('');
      }

      if (relationships.length > 0) {
        lines.push('## Relationships', '');
        for (const rel of relationships) {
          lines.push(`- ${rel.from_name} → ${rel.relation_type} → ${rel.to_name}`);
        }
        lines.push('');
      }

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

      const markdown = lines.join('\n').trimEnd() + '\n';

      assert.ok(markdown.startsWith('# karolina (person)'));
      assert.ok(markdown.includes('## Observations'));
      assert.ok(markdown.includes('- PhD atmospheric physics, TU Delft'));
      assert.ok(markdown.includes('## Relationships'));
      assert.ok(markdown.includes('karolina → created → hippocampus'));
      assert.ok(markdown.includes('karolina → runs → rebel-strategy-lab'));
      assert.ok(markdown.includes('## Related Entities'));
      assert.ok(markdown.includes('### hippocampus (project)'));
      assert.ok(markdown.includes('- Open-source MCP memory server'));
    });

    test('nonexistent entity returns not found', () => {
      const entity = findEntityByName('does-not-exist');
      assert.equal(entity, undefined);
    });

    test('entity list returns all entities for template discovery', () => {
      const entities = listEntities({ limit: 10000 });
      const resources = entities.map(e => ({
        uri: `hippocampus://entity/${encodeURIComponent(e.name)}`,
        name: e.name,
        description: e.type ? `${e.type}: ${e.name}` : e.name,
      }));

      assert.equal(resources.length, 3);
      assert.ok(resources.some(r => r.name === 'karolina'));
      assert.ok(resources.some(r => r.name === 'hippocampus'));
      assert.ok(resources.some(r => r.name === 'rebel-strategy-lab'));
      assert.ok(resources.some(r => r.uri === 'hippocampus://entity/karolina'));
    });
  });

  describe('resource registration', () => {
    test('registerContextResources does not throw', () => {
      const server = new McpServer({ name: 'test', version: '0.0.1' });
      assert.doesNotThrow(() => registerContextResources(server));
    });
  });
});
