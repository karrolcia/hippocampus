import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-versioning-${Date.now()}.db`);

// Must set env before importing project modules (config.ts reads eagerly)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-versioning';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { update } = await import('../src/mcp/tools/update.js');
const { merge } = await import('../src/mcp/tools/merge.js');
const { mergeEntities } = await import('../src/mcp/tools/merge-entities.js');
const { context } = await import('../src/mcp/tools/context.js');
const { checkVersion } = await import('../src/mcp/tools/check-version.js');
const { onboard } = await import('../src/mcp/tools/onboard.js');
const { getEntityVersion, findEntityByName } = await import('../src/db/entities.js');
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

// ---------------------------------------------------------------------------
// Schema V6 migration
// ---------------------------------------------------------------------------

describe('Schema V7 migration', () => {
  test('schema version is 7', () => {
    const db = getDatabase();
    const version = getSchemaVersion(db);
    assert.equal(version, 7);
  });

  test('entities table has version_hash and version_at columns', () => {
    const db = getDatabase();
    const columns = db.prepare("PRAGMA table_info('entities')").all() as Array<{ name: string }>;
    const columnNames = columns.map(c => c.name);
    assert.ok(columnNames.includes('version_hash'), 'Should have version_hash column');
    assert.ok(columnNames.includes('version_at'), 'Should have version_at column');
  });
});

// ---------------------------------------------------------------------------
// Version hash computation
// ---------------------------------------------------------------------------

describe('Version hash computation', () => {
  test('remember returns version_hash', async () => {
    const result = await remember({
      content: 'Version test observation one',
      entity: 'version-test-basic',
    });

    assert.equal(result.success, true);
    assert.ok(result.version_hash, 'Should return a version_hash');
    assert.equal(typeof result.version_hash, 'string');
    assert.equal(result.version_hash!.length, 64, 'SHA-256 hex is 64 chars');
  });

  test('version_hash changes when entity is mutated', async () => {
    const first = await remember({
      content: 'First observation for hash change test',
      entity: 'version-test-changes',
    });
    const hash1 = first.version_hash;
    assert.ok(hash1);

    const second = await remember({
      content: 'Second observation for hash change test',
      entity: 'version-test-changes',
    });
    const hash2 = second.version_hash;
    assert.ok(hash2);

    assert.notEqual(hash1, hash2, 'Hash should change after adding observation');
  });

  test('version_hash is deterministic for same content', async () => {
    await remember({
      content: 'Deterministic hash test content A',
      entity: 'version-test-deterministic',
    });
    await remember({
      content: 'Deterministic hash test content B',
      entity: 'version-test-deterministic',
    });

    const version1 = getEntityVersion('version-test-deterministic');
    const version2 = getEntityVersion('version-test-deterministic');

    assert.ok(version1);
    assert.ok(version2);
    assert.equal(version1.version_hash, version2.version_hash, 'Same observations should produce same hash');
  });

  test('getEntityVersion returns observation_count', async () => {
    await remember({
      content: 'PhD atmospheric physics from TU Delft in the Netherlands',
      entity: 'version-test-count',
    });
    await remember({
      content: 'Favorite programming language is TypeScript for backend development',
      entity: 'version-test-count',
    });

    const version = getEntityVersion('version-test-count');
    assert.ok(version);
    assert.equal(version.observation_count, 2);
  });

  test('getEntityVersion returns null for nonexistent entity', () => {
    const version = getEntityVersion('entity-that-does-not-exist-xyz');
    assert.equal(version, null);
  });
});

// ---------------------------------------------------------------------------
// check_version tool
// ---------------------------------------------------------------------------

describe('check_version tool', () => {
  test('returns current version info without hash param', async () => {
    await remember({
      content: 'Check version test data',
      entity: 'check-version-test',
    });

    const result = checkVersion({ entity: 'check-version-test' });
    assert.equal(result.entity, 'check-version-test');
    assert.ok(result.current_hash);
    assert.ok(result.version_at);
    assert.equal(result.observation_count, 1);
    assert.equal(result.is_current, false, 'Without hash param, is_current should be false');
  });

  test('is_current: true when hash matches', async () => {
    await remember({
      content: 'Matching hash test data',
      entity: 'check-version-match',
    });

    const version = getEntityVersion('check-version-match');
    assert.ok(version?.version_hash);

    const result = checkVersion({
      entity: 'check-version-match',
      version_hash: version.version_hash!,
    });
    assert.equal(result.is_current, true);
  });

  test('is_current: false when hash is stale', async () => {
    const first = await remember({
      content: 'Based in Helsinki, Finland, works in climate technology sector',
      entity: 'check-version-stale',
    });
    const oldHash = first.version_hash;
    assert.ok(oldHash);

    // Add a completely different observation to ensure no dedup
    await remember({
      content: 'Favorite programming language is Rust for systems development',
      entity: 'check-version-stale',
    });

    const result = checkVersion({
      entity: 'check-version-stale',
      version_hash: oldHash!,
    });
    assert.equal(result.is_current, false);
    assert.notEqual(result.current_hash, oldHash);
  });

  test('nonexistent entity returns null hash', () => {
    const result = checkVersion({ entity: 'nonexistent-entity-xyz' });
    assert.equal(result.current_hash, null);
    assert.equal(result.version_at, null);
    assert.equal(result.observation_count, 0);
    assert.equal(result.is_current, false);
  });
});

// ---------------------------------------------------------------------------
// version_hash in mutation tool responses
// ---------------------------------------------------------------------------

describe('version_hash in tool responses', () => {
  test('update returns version_hash', async () => {
    await remember({
      content: 'Update version test original',
      entity: 'version-test-update',
    });

    const result = await update({
      entity: 'version-test-update',
      old_content: 'Update version test original',
      new_content: 'Update version test replaced',
    });

    assert.equal(result.success, true);
    assert.ok(result.version_hash, 'update should return version_hash');
    assert.equal(typeof result.version_hash, 'string');
  });

  test('merge returns version_hash', async () => {
    const obs1 = await remember({
      content: 'Merge version test A',
      entity: 'version-test-merge',
    });
    const obs2 = await remember({
      content: 'Merge version test B',
      entity: 'version-test-merge',
    });

    const result = await merge({
      observation_ids: [obs1.observationId, obs2.observationId],
      content: 'Merge version test A and B combined',
    });

    assert.equal(result.success, true);
    assert.ok(result.version_hash, 'merge should return version_hash');
    assert.equal(typeof result.version_hash, 'string');
  });

  test('merge_entities returns version_hash', async () => {
    await remember({
      content: 'Source entity data for merge',
      entity: 'version-merge-source',
    });

    const result = mergeEntities({
      source_entities: ['version-merge-source'],
      target_entity: 'version-merge-target',
    });

    assert.equal(result.success, true);
    assert.ok(result.version_hash, 'merge_entities should return version_hash');
    assert.equal(typeof result.version_hash, 'string');
  });
});

// ---------------------------------------------------------------------------
// version_hash in recall
// ---------------------------------------------------------------------------

describe('version_hash in recall', () => {
  test('full format includes version_hash per memory', async () => {
    await remember({
      content: 'Recall version test observation for full format',
      entity: 'recall-version-test',
    });

    const result = await recall({
      query: 'recall version test full format',
      format: 'full',
    });

    assert.ok('memories' in result);
    const match = (result as { memories: Array<{ entity: string; version_hash?: string }> })
      .memories.find(m => m.entity === 'recall-version-test');
    assert.ok(match, 'Should find the observation');
    assert.ok(match.version_hash, 'Should include version_hash');
    assert.equal(typeof match.version_hash, 'string');
  });

  test('compact format includes version hash in header', async () => {
    await remember({
      content: 'Recall version test for compact format',
      entity: 'recall-version-compact',
    });

    const result = await recall({
      query: 'recall version compact format',
      format: 'compact',
    });

    assert.ok('text' in result);
    const text = (result as { text: string }).text;
    // Compact format includes [v:XXXXXXXX] after entity header
    assert.ok(text.includes('[v:'), 'Compact format should include version hash prefix');
  });

  test('wire format includes version hash in header', async () => {
    await remember({
      content: 'Recall version test for wire format',
      entity: 'recall-version-wire',
    });

    const result = await recall({
      query: 'recall version wire format',
      format: 'wire',
    });

    assert.ok('text' in result);
    const text = (result as { text: string }).text;
    assert.ok(text.includes('|v:'), 'Wire format should include version hash');
  });

  test('index format includes version hash', async () => {
    await remember({
      content: 'Recall version test for index format',
      entity: 'recall-version-index',
    });

    const result = await recall({
      query: 'recall version index format',
      format: 'index',
    });

    assert.ok('text' in result);
    const text = (result as { text: string }).text;
    assert.ok(text.includes('|v:'), 'Index format should include version hash');
  });
});

// ---------------------------------------------------------------------------
// version_hash in context
// ---------------------------------------------------------------------------

describe('version_hash in context', () => {
  test('context response includes version_hash', async () => {
    await remember({
      content: 'Context version test data point',
      entity: 'context-version-test',
    });

    const result = await context({ topic: 'context-version-test' });
    assert.equal(result.success, true);
    assert.ok(result.entity);
    assert.ok(result.entity.version_hash, 'context entity should include version_hash');
    assert.equal(typeof result.entity.version_hash, 'string');
  });
});

// ---------------------------------------------------------------------------
// onboard tool
// ---------------------------------------------------------------------------

describe('onboard tool', () => {
  test('returns extraction instructions', () => {
    const result = onboard({});
    assert.ok(result.instructions);
    assert.ok(result.instructions.includes('remember'));
    assert.ok(result.instructions.includes('Inventory'));
    assert.ok(Array.isArray(result.existing_entities));
    assert.equal(typeof result.observation_count, 'number');
  });

  test('includes source hint when provided', () => {
    const result = onboard({ source: 'chatgpt' });
    assert.ok(result.instructions.includes('chatgpt'));
  });

  test('lists existing entities', async () => {
    // Entities from prior tests should be present
    const result = onboard({});
    assert.ok(result.existing_entities.length > 0, 'Should list existing entities');
    assert.ok(result.observation_count > 0, 'Should have observations from prior tests');
  });

  test('without source has no source prefix', () => {
    const result = onboard({});
    assert.ok(!result.instructions.startsWith('You are running in'));
  });
});
