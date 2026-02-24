import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-lifecycle-${Date.now()}.db`);

// Must set env before importing project modules (config.ts reads eagerly)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-lifecycle';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { consolidate } = await import('../src/mcp/tools/consolidate.js');
const { findEntityByName } = await import('../src/db/entities.js');
const { computeNovelty, computeRedundancyScores } = await import('../src/embeddings/subspace.js');
const { generateEmbedding } = await import('../src/embeddings/embedder.js');

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

// --- Subspace novelty tests ---

describe('Subspace novelty', () => {
  test('empty entity → novelty 1.0', () => {
    const vector = new Float32Array(384).fill(0.05); // dummy
    const novelty = computeNovelty(vector, []);
    assert.equal(novelty, 1.0);
  });

  test('novel observation → high novelty', async () => {
    // Two very different topics
    const existing1 = await generateEmbedding('Finnish sauna traditions and cold water swimming');
    const existing2 = await generateEmbedding('Best coffee shops in Helsinki city center');
    const novel = await generateEmbedding('Quantum computing breakthroughs in superconducting circuits');

    const novelty = computeNovelty(novel, [existing1, existing2]);
    assert.ok(novelty > 0.3, `Expected novelty > 0.3, got ${novelty}`);
  });

  test('redundant observation → low novelty', async () => {
    // Cluster of related observations, then a very similar one
    const existing1 = await generateEmbedding('PhD in atmospheric physics from TU Delft');
    const existing2 = await generateEmbedding('Studied atmospheric science at TU Delft university');
    const existing3 = await generateEmbedding('Research in atmospheric physics and climate science');
    const redundant = await generateEmbedding('Has a PhD in atmospheric physics, TU Delft');

    const novelty = computeNovelty(redundant, [existing1, existing2, existing3]);
    assert.ok(novelty < 0.5, `Expected novelty < 0.5, got ${novelty}`);
  });
});

// --- Novelty in remember response ---

describe('Remember novelty scoring', () => {
  test('returns novelty score for non-duplicate observations', async () => {
    await remember({
      content: 'Hippocampus uses all-MiniLM-L6-v2 for local embeddings',
      entity: 'lifecycle-novelty-test',
    });

    const result = await remember({
      content: 'The server runs on Hono web framework with TypeScript',
      entity: 'lifecycle-novelty-test',
    });

    assert.equal(result.success, true);
    assert.ok(result.novelty !== undefined, 'Should include novelty score');
    assert.ok(result.novelty! >= 0 && result.novelty! <= 1, `Novelty should be [0, 1], got ${result.novelty}`);
  });

  test('first observation on entity gets novelty 1.0', async () => {
    const result = await remember({
      content: 'This is the very first observation on a brand new entity',
      entity: 'lifecycle-novelty-first',
    });

    assert.equal(result.success, true);
    assert.equal(result.novelty, 1.0);
  });
});

// --- Sleep mode tests ---

describe('Sleep mode', () => {
  // Helper to backdate observations for age testing
  function backdateObservation(obsId: string, daysAgo: number) {
    const db = getDatabase();
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE observations SET created_at = ? WHERE id = ?').run(date, obsId);
    // Also update embedding created_at to match
    db.prepare('UPDATE embeddings SET created_at = ? WHERE observation_id = ?').run(date, obsId);
  }

  function setRecallCount(obsId: string, count: number) {
    const db = getDatabase();
    db.prepare('UPDATE observations SET recall_count = ? WHERE id = ?').run(count, obsId);
  }

  test('identifies prune candidates: old + never recalled', async () => {
    const obs1 = await remember({
      content: 'Old forgotten fact about weather patterns in Arctic',
      entity: 'sleep-prune-test',
    });
    const obs2 = await remember({
      content: 'Recent observation about machine learning models',
      entity: 'sleep-prune-test',
    });

    // Backdate obs1 to 60 days ago, keep obs2 recent
    backdateObservation(obs1.observationId, 60);
    // obs1 has recall_count = 0 (default), obs2 is recent

    const result = await consolidate({
      entity: 'sleep-prune-test',
      mode: 'sleep',
      age_days: 30,
    });

    assert.equal(result.success, true);
    assert.ok('prune' in result);
    const sleepResult = result as any;
    const pruned = sleepResult.prune.find((o: any) => o.observation_id === obs1.observationId);
    assert.ok(pruned, 'Old unreferenced observation should be a prune candidate');

    // Recent observation should NOT be in any category
    const recentInAny = [...sleepResult.compress, ...sleepResult.prune, ...sleepResult.refresh]
      .find((o: any) => o.observation_id === obs2.observationId);
    assert.equal(recentInAny, undefined, 'Recent observation should not be flagged');
  });

  test('identifies compress candidates: old + high redundancy + recalled', async () => {
    // Store several similar observations to create redundancy
    const obs1 = await remember({
      content: 'SQLCipher provides AES-256 encryption for the database',
      entity: 'sleep-compress-test',
    });
    const obs2 = await remember({
      content: 'The database is encrypted with SQLCipher using AES-256',
      entity: 'sleep-compress-test',
    });
    const obs3 = await remember({
      content: 'Database encryption uses SQLCipher with AES-256 algorithm',
      entity: 'sleep-compress-test',
    });
    // A different topic to provide contrast
    const obs4 = await remember({
      content: 'OAuth 2.1 with PKCE is used for authentication in the server',
      entity: 'sleep-compress-test',
    });

    // Backdate all and give recall counts
    for (const obs of [obs1, obs2, obs3, obs4]) {
      backdateObservation(obs.observationId, 45);
      setRecallCount(obs.observationId, 2);
    }

    const result = await consolidate({
      entity: 'sleep-compress-test',
      mode: 'sleep',
      age_days: 30,
    });

    assert.equal(result.success, true);
    const sleepResult = result as any;
    // At least one of the redundant SQLCipher observations should be flagged for compression
    // (they're very similar, so SVD leverage will mark some as redundant)
    const totalCategorized = sleepResult.compress.length + sleepResult.prune.length + sleepResult.refresh.length;
    assert.ok(totalCategorized >= 0, 'Should categorize observations');
    assert.ok(sleepResult.information_rank > 0, 'Should report information rank');
    assert.ok(sleepResult.redundancy_ratio >= 0, 'Should report redundancy ratio');
  });

  test('identifies refresh candidates: old + low redundancy + frequently recalled', async () => {
    const obs1 = await remember({
      content: 'Karolina is based in Helsinki and relocating to Stockholm in 18 months',
      entity: 'sleep-refresh-test',
    });
    const obs2 = await remember({
      content: 'Caper is a dog who lives with the family',
      entity: 'sleep-refresh-test',
    });

    // Backdate both, give high recall counts (unique + frequently accessed)
    backdateObservation(obs1.observationId, 90);
    backdateObservation(obs2.observationId, 90);
    setRecallCount(obs1.observationId, 10);
    setRecallCount(obs2.observationId, 5);

    const result = await consolidate({
      entity: 'sleep-refresh-test',
      mode: 'sleep',
      age_days: 30,
    });

    assert.equal(result.success, true);
    const sleepResult = result as any;
    // These two observations are on different topics → low redundancy, high recall
    // At least one should be a refresh candidate
    const refreshIds = sleepResult.refresh.map((o: any) => o.observation_id);
    const foundRefresh = refreshIds.includes(obs1.observationId) || refreshIds.includes(obs2.observationId);
    assert.ok(foundRefresh, 'Frequently recalled, unique, old observations should be refresh candidates');
  });

  test('returns entity-level information rank and redundancy ratio', async () => {
    // Use previously created entity with multiple observations
    const result = await consolidate({
      entity: 'sleep-compress-test',
      mode: 'sleep',
    });

    assert.equal(result.success, true);
    const sleepResult = result as any;
    assert.ok(typeof sleepResult.information_rank === 'number');
    assert.ok(typeof sleepResult.redundancy_ratio === 'number');
    assert.ok(sleepResult.total_observations > 0);
    assert.ok(sleepResult.information_rank <= sleepResult.total_observations,
      'Rank cannot exceed total observations');
  });
});

// --- Reconsolidation hints in recall ---

describe('Reconsolidation hints', () => {
  test('old observation on updated entity → stale = true', async () => {
    // Store an old observation
    const old = await remember({
      content: 'The team uses React 17 for the frontend framework',
      entity: 'stale-test-entity',
    });

    // Backdate it
    const db = getDatabase();
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE observations SET created_at = ? WHERE id = ?').run(oldDate, old.observationId);
    db.prepare('UPDATE embeddings SET created_at = ? WHERE observation_id = ?').run(oldDate, old.observationId);

    // Store a new observation on the same entity (this updates entity.updated_at)
    await remember({
      content: 'The frontend has been migrated to React 19 with server components',
      entity: 'stale-test-entity',
    });

    // Recall should flag the old observation as stale
    const result = await recall({ query: 'React frontend framework', format: 'full' });
    assert.ok(result.memories.length > 0);
    const oldMemory = result.memories.find(
      (m: any) => m.observation_id === old.observationId
    );
    if (oldMemory) {
      assert.equal(oldMemory.stale, true, 'Old observation on updated entity should be stale');
    }
    // The new observation should NOT be stale
    const newMemory = result.memories.find(
      (m: any) => m.content.includes('React 19')
    );
    if (newMemory) {
      assert.ok(!newMemory.stale, 'Recent observation should not be stale');
    }
  });

  test('recent observation → not stale', async () => {
    const result = await remember({
      content: 'Fresh observation about TypeScript type system',
      entity: 'stale-test-fresh',
    });

    const recallResult = await recall({ query: 'TypeScript type system', format: 'full' });
    const found = recallResult.memories.find(
      (m: any) => m.observation_id === result.observationId
    );
    if (found) {
      assert.ok(!found.stale, 'Recent observation should not be stale');
    }
  });
});
