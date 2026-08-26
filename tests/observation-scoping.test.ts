/**
 * Regression tests for the two observation-scoping bugs found 2026-07-27
 * while syncing edited pseo skills:
 *
 * 1. `update` silently dropped the old observation's `kind` (and `importance`)
 *    when creating the replacement — a kind:"content" observation came back
 *    kind:null, and passing kind explicitly was stripped by Zod.
 * 2. `forget` with a `content` argument deleted the ENTIRE entity — the
 *    unknown key was silently stripped, leaving `{entity}`, which widened a
 *    scoped delete into a whole-entity delete.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-obs-scoping-${Date.now()}.db`);

// Must set env before importing project modules (config.ts reads eagerly)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-obs-scoping';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { update } = await import('../src/mcp/tools/update.js');
const { forget } = await import('../src/mcp/tools/forget.js');
const { findEntityByName } = await import('../src/db/entities.js');
const { getObservationsByEntity } = await import('../src/db/observations.js');
const { getEmbeddingsByEntity } = await import('../src/embeddings/embedder.js');
const { normalizeParams } = await import('../src/mcp/param-normalization.js');

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

function obsFor(entityName: string) {
  const entity = findEntityByName(entityName);
  assert.ok(entity, `entity ${entityName} should exist`);
  return getObservationsByEntity(entity!.id);
}

describe('update preserves observation metadata', () => {
  test('kind and importance survive an update by default', async () => {
    await remember({
      entity: 'skill:test-update-kind',
      content: 'Full skill prompt about programmatic SEO internal linking structures',
      kind: 'content',
      importance: 0.8,
    });

    const result = await update({
      entity: 'skill:test-update-kind',
      old_content: 'Full skill prompt about programmatic SEO internal linking structures',
      new_content: 'Revised skill prompt covering hub-and-spoke breadcrumb navigation',
    });

    assert.equal(result.success, true);
    assert.equal(result.kind, 'content');
    const [obs] = obsFor('skill:test-update-kind');
    assert.equal(obs.kind, 'content');
    assert.equal(obs.importance, 0.8);
  });

  test('explicit kind param overrides the old kind', async () => {
    await remember({
      entity: 'skill:test-update-kind-set',
      content: 'Short trigger description for when to use this skill',
      kind: 'trigger',
    });

    const result = await update({
      entity: 'skill:test-update-kind-set',
      old_content: 'Short trigger description for when to use this skill',
      new_content: 'Completely rewritten trigger description with new scope',
      kind: 'content',
    });

    assert.equal(result.success, true);
    assert.equal(result.kind, 'content');
    const [obs] = obsFor('skill:test-update-kind-set');
    assert.equal(obs.kind, 'content');
  });

  test('re-tagging: old_content === new_content sets kind without touching content', async () => {
    // The migration path for observations stranded at kind=null.
    const text = 'Skill body that was rebuilt before the kind fix landed';
    await remember({ entity: 'skill:test-retag', content: text });
    assert.equal(obsFor('skill:test-retag')[0].kind, null);

    const result = await update({
      entity: 'skill:test-retag',
      old_content: text,
      new_content: text,
      kind: 'content',
    });

    assert.equal(result.success, true);
    const observations = obsFor('skill:test-retag');
    assert.equal(observations.length, 1);
    assert.equal(observations[0].content, text);
    assert.equal(observations[0].kind, 'content');
  });
});

describe('forget with content is scoped to one observation', () => {
  test('deletes only the matching observation, never the entity', async () => {
    const keep = 'Trigger: use when auditing pSEO output quality thresholds';
    const remove = 'Content: the full quality-guard validation prompt with all checks';
    await remember({ entity: 'skill:test-forget-scoped', content: keep, kind: 'trigger' });
    await remember({ entity: 'skill:test-forget-scoped', content: remove, kind: 'content' });
    assert.equal(obsFor('skill:test-forget-scoped').length, 2);

    const result = forget({ entity: 'skill:test-forget-scoped', content: remove });

    assert.equal(result.success, true);
    assert.equal(result.deleted.entity, false);
    assert.equal(result.deleted.observations, 1);
    assert.equal(result.deleted.embeddings, 1);

    const entity = findEntityByName('skill:test-forget-scoped');
    assert.ok(entity, 'entity must survive a content-scoped forget');
    const observations = getObservationsByEntity(entity!.id);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].content, keep);
    assert.equal(getEmbeddingsByEntity(entity!.id).length, 1);
  });

  test('no content match deletes NOTHING (does not widen to entity delete)', async () => {
    await remember({
      entity: 'skill:test-forget-miss',
      content: 'The only observation on this entity, precious and irreplaceable',
    });

    const result = forget({
      entity: 'skill:test-forget-miss',
      content: 'Some content that does not exist on this entity at all',
    });

    assert.equal(result.success, false);
    assert.deepEqual(result.deleted, {
      observations: 0,
      embeddings: 0,
      relationships: 0,
      entity: false,
    });
    assert.ok(findEntityByName('skill:test-forget-miss'), 'entity must be untouched');
    assert.equal(obsFor('skill:test-forget-miss').length, 1);
  });

  test('content without entity fails closed', () => {
    const result = forget({ content: 'orphan content with no entity to scope it' });
    assert.equal(result.success, false);
    assert.match(result.message, /content requires an entity/);
    assert.equal(result.deleted.entity, false);
  });

  test('entity-only forget still deletes the whole entity (existing contract)', async () => {
    await remember({ entity: 'skill:test-forget-whole', content: 'Doomed observation one about sauna culture' });
    await remember({ entity: 'skill:test-forget-whole', content: 'Doomed observation two about coffee roasting' });

    const result = forget({ entity: 'skill:test-forget-whole' });

    assert.equal(result.success, true);
    assert.equal(result.deleted.entity, true);
    assert.equal(result.deleted.observations, 2);
    assert.equal(findEntityByName('skill:test-forget-whole'), undefined);
  });

  test('forget by observation_id refreshes the entity version hash', async () => {
    await remember({ entity: 'skill:test-forget-hash', content: 'First observation, stays put' });
    await remember({ entity: 'skill:test-forget-hash', content: 'Second observation, gets deleted by id' });
    const beforeEntity = findEntityByName('skill:test-forget-hash')!;
    const target = getObservationsByEntity(beforeEntity.id).find(
      o => o.content === 'Second observation, gets deleted by id'
    )!;

    const result = forget({ observation_id: target.id });

    assert.equal(result.success, true);
    const afterEntity = findEntityByName('skill:test-forget-hash')!;
    assert.notEqual(afterEntity.version_hash, beforeEntity.version_hash);
  });
});

describe('forget rejects unknown arguments loudly', () => {
  test('unknown key on forget throws instead of being stripped', () => {
    assert.throws(
      () => normalizeParams('forget', { entity: 'skill:x', contnet: 'typo of content' }),
      /forget: unrecognized argument "contnet"/
    );
  });

  test('error names the key but never the value', () => {
    try {
      normalizeParams('forget', { entity: 'skill:x', payload: 'SECRET-OBSERVATION-TEXT' });
      assert.fail('expected normalizeParams to throw');
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(!e.message.includes('SECRET-OBSERVATION-TEXT'), 'value must not leak into the error');
    }
  });

  test('canonical, aliased, and case-variant forget args still pass', () => {
    assert.deepEqual(
      normalizeParams('forget', { entity_name: 'skill:x', content: 'c' }),
      { entity: 'skill:x', content: 'c' }
    );
    assert.deepEqual(
      normalizeParams('forget', { entityName: 'skill:x', observationId: 'id-1' }),
      { entity: 'skill:x', observation_id: 'id-1' }
    );
  });

  test('non-strict tools still pass unknown keys through', () => {
    // Was `recall`, which joined forget in STRICT_TOOLS under D14 — its
    // optional params are all narrowing filters, so a stripped one silently
    // widens the answer. `export` stays non-strict: returning a superset is
    // its documented default rather than a scoped answer in disguise.
    assert.deepEqual(
      normalizeParams('export', { format: 'json', bogus: 1 }),
      { format: 'json', bogus: 1 }
    );
  });
});
