import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-consolidation-${Date.now()}.db`);

// Must set env before importing project modules (config.ts reads eagerly)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-consolidation';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { merge } = await import('../src/mcp/tools/merge.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { getObservationsByEntity } = await import('../src/db/observations.js');
const { findEntityByName } = await import('../src/db/entities.js');

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

describe('Dedup on write', () => {
  test('skips near-duplicate when existing content is longer', async () => {
    // Store a longer observation first
    const first = await remember({
      content: 'Karolina has a PhD in atmospheric physics from TU Delft and works in climate tech',
      entity: 'dedup-test-skip',
    });
    assert.equal(first.success, true);
    assert.equal(first.deduplicated, undefined);

    // Store a shorter near-duplicate — should be skipped
    const second = await remember({
      content: 'Karolina has a PhD in atmospheric physics from TU Delft',
      entity: 'dedup-test-skip',
    });
    assert.equal(second.success, true);
    assert.equal(second.deduplicated, true);
    assert.equal(second.observationId, first.observationId);
    assert.ok(second.message.includes('Deduplicated'));

    // Verify only one observation exists
    const entity = findEntityByName('dedup-test-skip');
    assert.ok(entity);
    const observations = getObservationsByEntity(entity.id);
    assert.equal(observations.length, 1);
    assert.ok(observations[0].content.includes('works in climate tech'));
  });

  test('replaces when new content is longer', async () => {
    // Store a shorter observation first
    const first = await remember({
      content: 'Karolina has a PhD in atmospheric physics from TU Delft',
      entity: 'dedup-test-replace',
    });
    assert.equal(first.success, true);

    // Store a longer near-duplicate — same core content plus more detail
    // (reverse of skip test: shorter first, longer second → triggers replace)
    const second = await remember({
      content: 'Karolina has a PhD in atmospheric physics from TU Delft and works in climate tech',
      entity: 'dedup-test-replace',
    });
    assert.equal(second.success, true);
    assert.ok(second.replaced_observation, 'Should have replaced the shorter observation');
    assert.equal(second.replaced_observation, 'Karolina has a PhD in atmospheric physics from TU Delft');
    assert.ok(second.message.includes('Replaced'));

    // Verify only one observation exists with the longer content
    const entity = findEntityByName('dedup-test-replace');
    assert.ok(entity);
    const observations = getObservationsByEntity(entity.id);
    assert.equal(observations.length, 1);
    assert.ok(observations[0].content.includes('works in climate tech'));
  });

  test('stores dissimilar observations normally', async () => {
    const first = await remember({
      content: 'Karolina lives in Helsinki with her dog Caper',
      entity: 'dedup-test-pass',
    });
    assert.equal(first.success, true);
    assert.equal(first.deduplicated, undefined);

    const second = await remember({
      content: 'Hippocampus uses SQLCipher for database encryption at rest',
      entity: 'dedup-test-pass',
    });
    assert.equal(second.success, true);
    assert.equal(second.deduplicated, undefined);
    assert.equal(second.replaced_observation, undefined);
    assert.notEqual(second.observationId, first.observationId);

    // Verify both observations exist
    const entity = findEntityByName('dedup-test-pass');
    assert.ok(entity);
    const observations = getObservationsByEntity(entity.id);
    assert.equal(observations.length, 2);
  });
});

describe('Merge tool', () => {
  test('merges two observations into one', async () => {
    const obs1 = await remember({
      content: 'Rebel Strategy Lab does strategy consulting',
      entity: 'merge-test-basic',
      source: 'conversation',
    });
    const obs2 = await remember({
      content: 'Rebel Strategy Lab also does leadership coaching',
      entity: 'merge-test-basic',
    });

    const result = await merge({
      observation_ids: [obs1.observationId, obs2.observationId],
      content: 'Rebel Strategy Lab does strategy consulting and leadership coaching for climate tech founders',
    });

    assert.equal(result.success, true);
    assert.equal(result.merged_count, 2);
    assert.equal(result.entity_name, 'merge-test-basic');
    assert.ok(result.new_observation_id);

    // Verify only one observation remains
    const entity = findEntityByName('merge-test-basic');
    assert.ok(entity);
    const observations = getObservationsByEntity(entity.id);
    assert.equal(observations.length, 1);
    assert.ok(observations[0].content.includes('strategy consulting and leadership coaching'));
    // Source should be preserved from the first observation
    assert.equal(observations[0].source, 'conversation');
  });

  test('merges three or more observations', async () => {
    const obs1 = await remember({
      content: 'Gallant is an accounting business',
      entity: 'merge-test-three',
    });
    const obs2 = await remember({
      content: 'Karolina is a board member at Gallant',
      entity: 'merge-test-three',
    });
    const obs3 = await remember({
      content: 'Gallant is expanding into European markets',
      entity: 'merge-test-three',
    });

    const result = await merge({
      observation_ids: [obs1.observationId, obs2.observationId, obs3.observationId],
      content: 'Gallant is an accounting business expanding into European markets. Karolina serves as board member.',
    });

    assert.equal(result.success, true);
    assert.equal(result.merged_count, 3);

    const entity = findEntityByName('merge-test-three');
    assert.ok(entity);
    const observations = getObservationsByEntity(entity.id);
    assert.equal(observations.length, 1);
  });

  test('rejects cross-entity merge', async () => {
    const obs1 = await remember({
      content: 'Entity A observation',
      entity: 'merge-cross-a',
    });
    const obs2 = await remember({
      content: 'Entity B observation',
      entity: 'merge-cross-b',
    });

    await assert.rejects(
      () => merge({
        observation_ids: [obs1.observationId, obs2.observationId],
        content: 'Merged content',
      }),
      (err: Error) => {
        assert.ok(err.message.includes('same entity'));
        return true;
      }
    );
  });

  test('rejects missing observation IDs', async () => {
    const obs1 = await remember({
      content: 'A real observation',
      entity: 'merge-missing',
    });

    await assert.rejects(
      () => merge({
        observation_ids: [obs1.observationId, 'nonexistent-id-12345'],
        content: 'Merged content',
      }),
      (err: Error) => {
        assert.ok(err.message.includes('not found'));
        return true;
      }
    );
  });

  test('merged observation is searchable via recall', async () => {
    const obs1 = await remember({
      content: 'Maven course focuses on self-leadership',
      entity: 'merge-test-search',
    });
    const obs2 = await remember({
      content: 'Maven course working title is The Room You Build',
      entity: 'merge-test-search',
    });

    const mergeResult = await merge({
      observation_ids: [obs1.observationId, obs2.observationId],
      content: 'Maven course on self-leadership, working title "The Room You Build"',
    });

    assert.equal(mergeResult.success, true);

    // Search for the merged content
    const searchResult = await recall({ query: 'Maven self-leadership course' });
    assert.ok(searchResult.memories.length > 0);
    const found = searchResult.memories.find(
      (r: { observation_id: string }) => r.observation_id === mergeResult.new_observation_id
    );
    assert.ok(found, 'Merged observation should be findable via recall');
  });
});
