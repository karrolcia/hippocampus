import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-new-features-${Date.now()}.db`);

// Must set env before importing project modules (config.ts reads eagerly)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-new-features';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { consolidate } = await import('../src/mcp/tools/consolidate.js');
const { exportMemories } = await import('../src/mcp/tools/export.js');
const { searchObservations } = await import('../src/db/observations.js');
const { findEntityByName, findOrCreateEntity } = await import('../src/db/entities.js');
const { createRelationship } = await import('../src/db/relationships.js');
const { createObservation } = await import('../src/db/observations.js');

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
// Observation kind
// ---------------------------------------------------------------------------

describe('Observation kind', () => {
  test('remember stores kind, recall returns it', async () => {
    const result = await remember({
      content: 'Decided to use SQLCipher for full-disk encryption',
      entity: 'kind-test-basic',
      kind: 'decision',
    });
    assert.equal(result.success, true);

    const recalled = await recall({ query: 'SQLCipher full-disk encryption' });
    const match = recalled.memories.find(
      (m: { observation_id: string }) => m.observation_id === result.observationId
    );
    assert.ok(match, 'Should find the observation via recall');
    assert.equal(match.kind, 'decision');
  });

  test('kind filter in recall', async () => {
    await remember({
      content: 'Helsinki averages -5C in January',
      entity: 'kind-test-filter',
      kind: 'fact',
    });
    await remember({
      content: 'Decided to relocate to Stockholm within 18 months',
      entity: 'kind-test-filter',
      kind: 'decision',
    });

    const result = await recall({ query: 'Helsinki Stockholm temperature relocation', kind: 'fact' });
    // Only the fact should be returned
    const entities = result.memories.filter(
      (m: { entity: string }) => m.entity === 'kind-test-filter'
    );
    assert.ok(entities.length >= 1, 'Should return at least the fact');
    for (const m of entities) {
      assert.equal(m.kind, 'fact', 'All returned observations should be facts');
    }
  });

  test('kind defaults to null', async () => {
    const result = await remember({
      content: 'Caper is a good dog who loves walks',
      entity: 'kind-test-null',
    });
    assert.equal(result.success, true);

    const recalled = await recall({ query: 'Caper good dog walks' });
    const match = recalled.memories.find(
      (m: { observation_id: string }) => m.observation_id === result.observationId
    );
    assert.ok(match, 'Should find the observation');
    assert.equal(match.kind, null);
  });

  test('kind in searchObservations', async () => {
    await remember({
      content: 'Prefers strength training over cardio',
      entity: 'kind-test-search',
      kind: 'preference',
    });
    await remember({
      content: 'Cycles year-round in Helsinki',
      entity: 'kind-test-search',
      kind: 'fact',
    });

    const results = searchObservations({ query: 'kind-test-search', kind: 'preference' });
    assert.ok(results.length >= 1, 'Should return at least one result');
    for (const obs of results) {
      assert.equal(obs.kind, 'preference');
    }
  });

  test('kind in JSON export', async () => {
    await remember({
      content: 'Use Hono over Express for lighter footprint',
      entity: 'kind-test-export',
      kind: 'decision',
    });

    const result = exportMemories({ format: 'json', entity: 'kind-test-export' });
    assert.equal(result.success, true);

    const parsed = JSON.parse(result.data);
    assert.ok(parsed.entities.length >= 1);
    const entity = parsed.entities.find(
      (e: { name: string }) => e.name === 'kind-test-export'
    );
    assert.ok(entity);
    assert.ok(entity.observations.length >= 1);
    const obs = entity.observations.find(
      (o: { content: string }) => o.content.includes('Hono over Express')
    );
    assert.ok(obs);
    assert.equal(obs.kind, 'decision');
  });
});

// ---------------------------------------------------------------------------
// Spreading activation
// ---------------------------------------------------------------------------

describe('Spreading activation', () => {
  // Set up a knowledge graph: karolina (person) → hippocampus (project)
  // Use type filter to isolate spreading behavior: base search filtered to 'person'
  // excludes project observations, but spreading follows relationships regardless of type.

  before(async () => {
    const karolina = findOrCreateEntity('spread-karolina', 'person');
    const hippo = findOrCreateEntity('spread-hippocampus', 'project');

    // Karolina: direct match for query
    await remember({
      content: 'PhD atmospheric physics from TU Delft in the Netherlands',
      entity: 'spread-karolina',
      type: 'person',
    });
    // Hippocampus: semantically related to "atmospheric physics" so spread score passes threshold
    await remember({
      content: 'Atmospheric measurement systems and physics sensor calibration tools',
      entity: 'spread-hippocampus',
      type: 'project',
    });

    // Create relationship
    createRelationship(karolina.id, hippo.id, 'created');
  });

  test('spread: false with type filter returns only matching-type results', async () => {
    const result = await recall({
      query: 'atmospheric physics research',
      type: 'person',
      spread: false,
    });

    const personObs = result.memories.filter(
      (m: { entity: string }) => m.entity === 'spread-karolina'
    );
    assert.ok(personObs.length >= 1, 'Should find person-type observation');

    // Type filter excludes project-type observations in base search
    const projectObs = result.memories.filter(
      (m: { entity: string }) => m.entity === 'spread-hippocampus'
    );
    assert.equal(projectObs.length, 0, 'Type filter should exclude project observations');
  });

  test('spread: true includes related entity observations across type boundary', async () => {
    const result = await recall({
      query: 'atmospheric physics research',
      type: 'person',
      spread: true,
    });

    // Should find karolina via base search
    const personObs = result.memories.filter(
      (m: { entity: string }) => m.entity === 'spread-karolina'
    );
    assert.ok(personObs.length >= 1, 'Should find person-type observation');

    // Spreading follows relationships and bypasses type filter
    const projectObs = result.memories.filter(
      (m: { entity: string }) => m.entity === 'spread-hippocampus'
    );
    assert.ok(projectObs.length >= 1, 'Spread should bring in related project observations');
  });

  test('spread results have dampened similarity', async () => {
    const result = await recall({
      query: 'atmospheric physics research',
      type: 'person',
      spread: true,
    });

    const directMatch = result.memories.find(
      (m: { entity: string }) => m.entity === 'spread-karolina'
    );
    const spreadMatch = result.memories.find(
      (m: { entity: string }) => m.entity === 'spread-hippocampus'
    );

    assert.ok(directMatch, 'Should have a direct match');
    assert.ok(spreadMatch, 'Should have a spread match');
    // Spread results get 0.5x decay, so should have lower similarity
    assert.ok(
      spreadMatch.similarity < directMatch.similarity,
      `Spread result (${spreadMatch.similarity}) should be lower than direct match (${directMatch.similarity})`
    );
  });

  test('spread: false is the default', async () => {
    // Call without spread param — should behave like spread: false
    const defaultResult = await recall({
      query: 'atmospheric physics research',
      type: 'person',
    });

    // Should NOT include spread results (project-type observations)
    const projectObs = defaultResult.memories.filter(
      (m: { entity: string }) => m.entity === 'spread-hippocampus'
    );
    assert.equal(projectObs.length, 0, 'Default (no spread param) should not include spread results');
  });
});

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

describe('Contradiction detection', () => {
  test('detects contradictions', async () => {
    // Two observations about the same topic (location) but conflicting claims.
    // Embedding similarity should be moderate-to-high (both about living in a city).
    // Jaccard overlap should be low (mostly different words).
    // Uses shared context word "Helsinki" to boost embedding similarity.
    await remember({
      content: 'Relocated from Helsinki to Stockholm recently',
      entity: 'contradiction-test-detect',
    });
    await remember({
      content: 'Still living in Helsinki with the family',
      entity: 'contradiction-test-detect',
    });

    const result = await consolidate({
      entity: 'contradiction-test-detect',
      mode: 'contradictions',
    });

    assert.equal(result.success, true);
    assert.ok('pairs' in result);
    const pairs = (result as { pairs: Array<{ embedding_similarity: number; lexical_overlap: number }> }).pairs;
    assert.ok(pairs.length >= 1, 'Should detect at least one contradiction pair');

    // Verify the pair structure: embedding similarity above threshold, lexical overlap below 0.3
    const pair = pairs[0];
    assert.ok(typeof pair.embedding_similarity === 'number');
    assert.ok(typeof pair.lexical_overlap === 'number');
    assert.ok(pair.lexical_overlap < 0.3, 'Lexical overlap should be low (different words)');
  });

  test('no contradictions for consistent observations', async () => {
    // Two observations that say essentially the same thing
    await remember({
      content: 'PhD in physics from TU Delft university',
      entity: 'contradiction-test-consistent',
    });
    await remember({
      content: 'Doctoral degree in physics, TU Delft',
      entity: 'contradiction-test-consistent',
    });

    const result = await consolidate({
      entity: 'contradiction-test-consistent',
      mode: 'contradictions',
    });

    assert.equal(result.success, true);
    assert.ok('pairs' in result);
    const pairs = (result as { pairs: Array<unknown> }).pairs;
    // These are semantically similar AND lexically similar — should not be flagged
    assert.equal(pairs.length, 0, 'Consistent observations should not be flagged as contradictions');
  });

  test('nonexistent entity returns success: false', async () => {
    const result = await consolidate({
      entity: 'entity-that-does-not-exist-xyz',
      mode: 'contradictions',
    });

    assert.equal(result.success, false);
    assert.ok('pairs' in result);
    const pairs = (result as { pairs: Array<unknown> }).pairs;
    assert.equal(pairs.length, 0);
  });

  test('single observation returns no pairs', async () => {
    await remember({
      content: 'Only observation for this single-obs entity',
      entity: 'contradiction-test-single',
    });

    const result = await consolidate({
      entity: 'contradiction-test-single',
      mode: 'contradictions',
    });

    assert.equal(result.success, true);
    assert.ok('pairs' in result);
    const pairs = (result as { pairs: Array<unknown> }).pairs;
    assert.equal(pairs.length, 0, 'Single observation cannot have contradictions');
  });

  test('threshold parameter controls sensitivity', async () => {
    await remember({
      content: 'Relocated from Helsinki to Stockholm recently',
      entity: 'contradiction-test-threshold',
    });
    await remember({
      content: 'Still living in Helsinki with the family',
      entity: 'contradiction-test-threshold',
    });

    // Very strict threshold — should find no pairs
    const strict = await consolidate({
      entity: 'contradiction-test-threshold',
      mode: 'contradictions',
      threshold: 0.99,
    });

    assert.equal(strict.success, true);
    assert.ok('pairs' in strict);
    const strictPairs = (strict as { pairs: Array<unknown> }).pairs;
    assert.equal(strictPairs.length, 0, 'Very strict threshold should find no pairs');

    // Default threshold — should find the contradiction
    const normal = await consolidate({
      entity: 'contradiction-test-threshold',
      mode: 'contradictions',
    });

    assert.equal(normal.success, true);
    assert.ok('pairs' in normal);
    const normalPairs = (normal as { pairs: Array<unknown> }).pairs;
    assert.ok(normalPairs.length >= 1, 'Default threshold should detect the contradiction');
  });
});
