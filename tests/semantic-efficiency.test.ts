import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-semeff-${Date.now()}.db`);

// Must set env before importing project modules (config.ts reads eagerly)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-semeff';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { consolidate } = await import('../src/mcp/tools/consolidate.js');
const { formatClaudeMd, budgetTrim, gatherEntityData } = await import('../src/mcp/tools/export.js');
const { getObservationsByEntity } = await import('../src/db/observations.js');
const { findEntityByName, listEntities } = await import('../src/db/entities.js');
const { getSchemaVersion } = await import('../src/db/schema.js');
const { getDatabase } = await import('../src/db/index.js');

before(() => {
  initDatabase();
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

// ─── Feature 2: Compact Recall Format ───

describe('Compact recall format', () => {
  test('compact groups by entity and returns text not memories', async () => {
    await remember({ content: 'PhD atmospheric physics, TU Delft', entity: 'compact-person', type: 'person' });
    await remember({ content: 'Based in Helsinki', entity: 'compact-person', type: 'person' });
    await remember({ content: 'Open-source MCP memory server', entity: 'compact-project', type: 'project' });

    const result = await recall({ query: 'atmospheric physics Helsinki MCP', format: 'compact' });

    assert.equal(result.success, true);
    assert.ok(result.count > 0);
    assert.ok('text' in result, 'Compact result should have text field');
    assert.ok(!('memories' in result), 'Compact result should not have memories field');
  });

  test('full format unchanged (backward compat)', async () => {
    const result = await recall({ query: 'atmospheric physics', format: 'full' }) as { success: boolean; memories: Array<{ observation_id: string; entity: string; content: string }>; count: number };

    assert.equal(result.success, true);
    assert.ok('memories' in result, 'Full result should have memories field');
    assert.ok(!('text' in result), 'Full result should not have text field');
    assert.ok(result.memories.length > 0);
    // Full result has observation_id, entity, type, content, source, remembered_at
    const m = result.memories[0];
    assert.ok('observation_id' in m);
    assert.ok('entity' in m);
    assert.ok('content' in m);
  });

  test('compact contains no UUIDs or ISO dates', async () => {
    const result = await recall({ query: 'atmospheric physics Helsinki', format: 'compact' }) as { success: boolean; count: number; text: string };

    // UUID pattern: 8-4-4-4-12 hex
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    // ISO date pattern: YYYY-MM-DDTHH:MM:SS
    const isoPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

    assert.ok(!uuidPattern.test(result.text), 'Compact output should not contain UUIDs');
    assert.ok(!isoPattern.test(result.text), 'Compact output should not contain ISO dates');
  });

  test('empty compact results return empty string', async () => {
    const result = await recall({ query: 'xyzzy_nonexistent_query_42', format: 'compact' }) as { success: boolean; count: number; text: string };

    assert.equal(result.count, 0);
    assert.equal(result.text, '');
  });

  test('default format is full (no format param)', async () => {
    const result = await recall({ query: 'atmospheric physics' });

    assert.ok('memories' in result, 'Default should be full format');
  });
});

// ─── Feature 3: Budgeted Context ───

describe('Budgeted context', () => {
  test('budgetTrim limits total observations', async () => {
    // Create entities with known observation counts
    for (let i = 0; i < 10; i++) {
      await remember({ content: `Budget entity A observation ${i}`, entity: 'budget-a', type: 'test' });
    }
    for (let i = 0; i < 10; i++) {
      await remember({ content: `Budget entity B observation ${i}`, entity: 'budget-b', type: 'test' });
    }
    for (let i = 0; i < 10; i++) {
      await remember({ content: `Budget entity C observation ${i}`, entity: 'budget-c', type: 'test' });
    }

    const entities = listEntities({ type: 'test' });
    const budgetEntities = entities.filter(e => e.name.startsWith('budget-'));
    const data = gatherEntityData(budgetEntities);

    const trimmed = budgetTrim(data, 15);
    let totalObs = 0;
    for (const ed of trimmed) totalObs += ed.observations.length;

    assert.ok(totalObs <= 15, `Expected <= 15 observations, got ${totalObs}`);
    assert.ok(totalObs > 0, 'Should have some observations');
  });

  test('partial entity inclusion at budget boundary', async () => {
    // Use existing budget entities from previous test
    const entities = listEntities({ type: 'test' });
    const budgetEntities = entities.filter(e => e.name.startsWith('budget-'));
    const data = gatherEntityData(budgetEntities);

    // Budget of 12: first entity (10) fits fully, second gets partial (2)
    const trimmed = budgetTrim(data, 12);
    let totalObs = 0;
    for (const ed of trimmed) totalObs += ed.observations.length;

    assert.ok(totalObs <= 12, `Expected <= 12 observations, got ${totalObs}`);
    assert.ok(trimmed.length >= 1, 'Should include at least one entity');
  });

  test('no budget arg passes all observations through', () => {
    const mockData = [
      {
        entity: { id: '1', name: 'test', type: null, created_at: '', updated_at: '' },
        observations: [
          { id: 'o1', entity_id: '1', content: 'a', source: null, created_at: '', last_recalled_at: null, recall_count: 0, importance: 1.0 },
          { id: 'o2', entity_id: '1', content: 'b', source: null, created_at: '', last_recalled_at: null, recall_count: 0, importance: 1.0 },
        ],
        relationships: [],
      },
    ];

    // formatClaudeMd without maxObservations should include everything
    const output = formatClaudeMd(mockData);
    assert.ok(output.includes('- a'));
    assert.ok(output.includes('- b'));
  });
});

// ─── Feature 4: Access Tracking ───

describe('Access tracking', () => {
  test('schema is version 4', () => {
    const db = getDatabase();
    const version = getSchemaVersion(db);
    assert.equal(version, 4);
  });

  test('observations table has recall tracking and importance columns', () => {
    const db = getDatabase();
    const columns = db.prepare("PRAGMA table_info('observations')").all() as Array<{ name: string }>;
    const colNames = columns.map(c => c.name);
    assert.ok(colNames.includes('last_recalled_at'), 'Should have last_recalled_at column');
    assert.ok(colNames.includes('recall_count'), 'Should have recall_count column');
    assert.ok(colNames.includes('importance'), 'Should have importance column');
  });

  test('recall increments recall_count on matched observations', async () => {
    const obs1 = await remember({ content: 'Access tracking test observation alpha', entity: 'access-test' });
    const obs2 = await remember({ content: 'Access tracking test observation beta', entity: 'access-test' });
    const obs3 = await remember({ content: 'Completely unrelated content about quantum physics experiments', entity: 'access-unrelated' });

    // Recall something that should match obs1 and obs2
    await recall({ query: 'access tracking test observation' });

    const entity = findEntityByName('access-test');
    assert.ok(entity);
    const observations = getObservationsByEntity(entity.id);

    // All matched observations should have recall_count >= 1
    for (const obs of observations) {
      assert.ok(obs.recall_count >= 1, `Observation "${obs.content}" should have recall_count >= 1, got ${obs.recall_count}`);
      assert.ok(obs.last_recalled_at !== null, 'last_recalled_at should be set');
    }

    // Unrelated observation should still be 0
    const unrelatedEntity = findEntityByName('access-unrelated');
    assert.ok(unrelatedEntity);
    const unrelatedObs = getObservationsByEntity(unrelatedEntity.id);
    const unmatched = unrelatedObs.find(o => o.content.includes('quantum physics'));
    assert.ok(unmatched);
    assert.equal(unmatched.recall_count, 0, 'Unmatched observation should have recall_count 0');
  });

  test('recall same query twice increments to 2', async () => {
    await remember({ content: 'Double recall tracking test content zeta', entity: 'access-double' });

    await recall({ query: 'double recall tracking test zeta' });
    await recall({ query: 'double recall tracking test zeta' });

    const entity = findEntityByName('access-double');
    assert.ok(entity);
    const observations = getObservationsByEntity(entity.id);
    const match = observations.find(o => o.content.includes('zeta'));
    assert.ok(match);
    assert.equal(match.recall_count, 2, `Expected recall_count 2, got ${match.recall_count}`);
  });
});

// ─── Feature 5: Entity Resolution ───

describe('Entity resolution', () => {
  test('similar entity names cluster together', async () => {
    await remember({ content: 'Person lives in Helsinki', entity: 'karolina', type: 'person' });
    await remember({ content: 'Person has a PhD', entity: 'Karolina Sarna', type: 'person' });

    const result = await consolidate({ mode: 'entities', threshold: 0.5 });

    assert.equal(result.success, true);
    assert.ok('total_entities' in result);
    // At low threshold, karolina and Karolina Sarna should cluster
    const entityResult = result as { clusters: Array<{ entities: Array<{ name: string }> }> };
    const cluster = entityResult.clusters.find(c =>
      c.entities.some(e => e.name === 'karolina') &&
      c.entities.some(e => e.name === 'Karolina Sarna')
    );
    assert.ok(cluster, 'karolina and Karolina Sarna should cluster together');
  });

  test('dissimilar entity names do not cluster', async () => {
    await remember({ content: 'A test memory', entity: 'entity-alpha-unique', type: 'test' });
    await remember({ content: 'Another test memory', entity: 'entity-zeta-distinct', type: 'test' });

    const result = await consolidate({ mode: 'entities', threshold: 0.9 });

    assert.equal(result.success, true);
    const entityResult = result as { clusters: Array<{ entities: Array<{ name: string }> }> };
    // At high threshold, these very different names should not cluster
    const badCluster = entityResult.clusters.find(c =>
      c.entities.some(e => e.name === 'entity-alpha-unique') &&
      c.entities.some(e => e.name === 'entity-zeta-distinct')
    );
    assert.ok(!badCluster, 'Dissimilar entity names should not cluster');
  });

  test('entity clusters include observation_count', async () => {
    const result = await consolidate({ mode: 'entities', threshold: 0.5 });

    assert.equal(result.success, true);
    const entityResult = result as { clusters: Array<{ entities: Array<{ name: string; observation_count: number }> }> };
    if (entityResult.clusters.length > 0) {
      for (const cluster of entityResult.clusters) {
        for (const entity of cluster.entities) {
          assert.ok(typeof entity.observation_count === 'number', 'Each entity should have observation_count');
          assert.ok(entity.observation_count >= 0);
        }
      }
    }
  });

  test('default mode (no param) runs observation consolidation', async () => {
    const result = await consolidate({});

    assert.equal(result.success, true);
    // Observation mode returns total_observations, not total_entities
    assert.ok('total_observations' in result, 'Default should be observation mode');
  });
});

// ─── Feature 6: Decay-Weighted Retrieval ───

describe('Decay-weighted retrieval', () => {
  test('frequently recalled observations rank higher', async () => {
    // Use unique marker words to avoid cross-test interference
    const obsA = await remember({ content: 'Xylophone zephyr: the crimson foxglove blooms in alpine meadows', entity: 'decay-boosted', type: 'decay' });
    const obsB = await remember({ content: 'Xylophone zephyr: the scarlet foxglove blooms in alpine meadows', entity: 'decay-unboosted', type: 'decay' });

    // Directly set recall_count on obsA via DB to avoid side effects from recall() touching other observations
    const db = getDatabase();
    db.prepare('UPDATE observations SET recall_count = 50 WHERE id = ?').run(obsA.observationId);

    // Search with a neutral query — both observations are near-identical semantically
    const result = await recall({ query: 'xylophone zephyr foxglove blooms alpine meadows', format: 'full', limit: 50 }) as {
      success: boolean;
      memories: Array<{ content: string; observation_id: string }>;
    };

    const crimsonIdx = result.memories.findIndex(m => m.content.includes('crimson foxglove'));
    const scarletIdx = result.memories.findIndex(m => m.content.includes('scarlet foxglove'));
    assert.ok(crimsonIdx >= 0 && scarletIdx >= 0, 'Both observations should appear');
    assert.ok(crimsonIdx < scarletIdx, 'Frequently recalled observation should rank higher');
  });

  test('zero recall_count gets neutral boost (no penalty)', async () => {
    await remember({ content: 'Zero recall test: photosynthesis in chloroplasts', entity: 'decay-neutral', type: 'test' });

    const result = await recall({ query: 'photosynthesis chloroplasts', format: 'full' }) as {
      success: boolean;
      memories: Array<{ content: string; observation_id: string }>;
    };

    assert.ok(result.memories.length > 0, 'Should return results');
    const match = result.memories.find(m => m.content.includes('photosynthesis'));
    assert.ok(match, 'Zero-recall observation should still be found');
  });
});

// ─── Feature 7: Observation Importance ───

describe('Observation importance', () => {
  test('high importance outranks low importance', async () => {
    // Create low-importance observation first
    await remember({
      content: 'Low importance: minor detail about weather patterns',
      entity: 'importance-test',
      type: 'test',
      importance: 0.3,
    });
    // Create high-importance observation
    await remember({
      content: 'High importance: critical detail about weather systems',
      entity: 'importance-test',
      type: 'test',
      importance: 1.0,
    });

    const result = await recall({ query: 'weather patterns systems detail', format: 'full' }) as {
      success: boolean;
      memories: Array<{ content: string }>;
    };

    assert.ok(result.memories.length >= 2, 'Should return at least 2 results');
    const highIdx = result.memories.findIndex(m => m.content.includes('High importance'));
    const lowIdx = result.memories.findIndex(m => m.content.includes('Low importance'));
    assert.ok(highIdx >= 0 && lowIdx >= 0, 'Both observations should appear');
    assert.ok(highIdx < lowIdx, 'High importance should rank above low importance');
  });

  test('default importance is 1.0', async () => {
    await remember({
      content: 'Default importance: no param specified for testing',
      entity: 'importance-default',
      type: 'test',
    });

    const entity = findEntityByName('importance-default');
    assert.ok(entity);
    const observations = getObservationsByEntity(entity.id);
    const obs = observations.find(o => o.content.includes('Default importance'));
    assert.ok(obs);
    assert.equal(obs.importance, 1.0, 'Default importance should be 1.0');
  });
});

// ─── Feature 8: Entity Merge ───

const { mergeEntities } = await import('../src/mcp/tools/merge-entities.js');
const { findEntityByName: findEntity } = await import('../src/db/entities.js');
const { createRelationship } = await import('../src/db/relationships.js');

describe('Entity merge', () => {
  test('merge 2 source entities into target', async () => {
    await remember({ content: 'Source A observation: cats are mammals', entity: 'merge-source-a', type: 'test' });
    await remember({ content: 'Source B observation: dogs are mammals', entity: 'merge-source-b', type: 'test' });

    const result = mergeEntities({
      source_entities: ['merge-source-a', 'merge-source-b'],
      target_entity: 'merge-target',
      target_type: 'test',
    });

    assert.equal(result.success, true);
    assert.equal(result.merged_count, 2);
    assert.equal(result.observations_moved, 2);
    assert.ok(result.deleted_entities.includes('merge-source-a'));
    assert.ok(result.deleted_entities.includes('merge-source-b'));

    // Source entities should be gone
    assert.equal(findEntity('merge-source-a'), undefined);
    assert.equal(findEntity('merge-source-b'), undefined);

    // Target should have all observations
    const target = findEntity('merge-target');
    assert.ok(target);
    const obs = getObservationsByEntity(target.id);
    assert.equal(obs.length, 2);
  });

  test('self-merge rejected', () => {
    assert.throws(
      () => mergeEntities({
        source_entities: ['some-entity'],
        target_entity: 'some-entity',
      }),
      /self-merge/
    );
  });

  test('source entity not found throws', async () => {
    assert.throws(
      () => mergeEntities({
        source_entities: ['nonexistent-entity-xyz'],
        target_entity: 'any-target',
      }),
      /not found/
    );
  });

  test('relationships correctly moved and deduplicated', async () => {
    await remember({ content: 'Entity R1 data', entity: 'merge-rel-1', type: 'test' });
    await remember({ content: 'Entity R2 data', entity: 'merge-rel-2', type: 'test' });
    await remember({ content: 'Entity R3 other data', entity: 'merge-rel-3', type: 'test' });

    const r1 = findEntity('merge-rel-1')!;
    const r2 = findEntity('merge-rel-2')!;
    const r3 = findEntity('merge-rel-3')!;

    // Create relationships: R1→R3, R2→R3
    createRelationship(r1.id, r3.id, 'relates_to');
    createRelationship(r2.id, r3.id, 'relates_to');

    // Merge R1 and R2 into R2 (R2 is both source and target won't work, so merge into new)
    const result = mergeEntities({
      source_entities: ['merge-rel-1', 'merge-rel-2'],
      target_entity: 'merge-rel-combined',
      target_type: 'test',
    });

    assert.equal(result.success, true);
    assert.ok(result.relationships_updated > 0, 'Relationships should have been updated');
  });

  test('merged observations still searchable via recall', async () => {
    await remember({ content: 'Searchable after merge: quantum entanglement theory', entity: 'merge-search-src', type: 'test' });

    mergeEntities({
      source_entities: ['merge-search-src'],
      target_entity: 'merge-search-dest',
      target_type: 'test',
    });

    const result = await recall({ query: 'quantum entanglement theory', format: 'full' }) as {
      success: boolean;
      memories: Array<{ content: string; entity: string }>;
    };

    const match = result.memories.find(m => m.content.includes('quantum entanglement'));
    assert.ok(match, 'Merged observation should still be searchable');
  });
});
