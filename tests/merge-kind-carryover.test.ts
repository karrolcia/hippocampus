/**
 * Regression tests for the `merge()` metadata loss found by the 2026-08-09
 * dreaming pass.
 *
 * `merge.ts` called `createObservation(entityId, content, source)` — three of
 * the five parameters — so every merged observation was written with
 * `kind -> null` and `importance -> 1.0` regardless of its sources. Same
 * defect that `tests/observation-scoping.test.ts` pins for `update()`; merge
 * never got the fix. Blast radius when found: all 15 compress groups in that
 * digest and all 1,025 compress candidates.
 *
 * The multi-kind case is a deliberate REJECT rather than a silent winner —
 * the curated tier is kind-load-bearing (`skill:*` trigger/content,
 * `block:*` idea/seed) and a wrong kind fails silently, since the text
 * survives and only the classification dies.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-merge-kind-${Date.now()}.db`);

// Must set env before importing project modules (config.ts reads eagerly)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-merge-kind';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { merge } = await import('../src/mcp/tools/merge.js');
const { findEntityByName } = await import('../src/db/entities.js');
const { getObservationsByEntity } = await import('../src/db/observations.js');

before(() => {
  initDatabase();
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
  }
});

function obsFor(entityName: string) {
  const entity = findEntityByName(entityName);
  assert.ok(entity, `entity ${entityName} should exist`);
  return getObservationsByEntity(entity!.id);
}

describe('merge preserves observation metadata', () => {
  test('a uniform kind survives the merge, and importance takes the max', async () => {
    await remember({
      entity: 'skill:test-merge-uniform',
      content: 'Hub-and-spoke internal linking builds topical authority across category pages.',
      kind: 'content',
      importance: 0.8,
    });
    await remember({
      entity: 'skill:test-merge-uniform',
      content: 'Breadcrumb navigation should mirror the canonical URL hierarchy exactly.',
      kind: 'content',
      importance: 0.6,
    });

    const ids = obsFor('skill:test-merge-uniform').map(o => o.id);
    assert.equal(ids.length, 2, 'both observations should have been stored');

    const result = await merge({
      observation_ids: ids,
      content: 'Internal linking: hub-and-spoke for authority, breadcrumbs mirroring canonical hierarchy.',
    });
    assert.equal(result.success, true);
    // The sources are gone after a merge, so the result is the only place a
    // caller can check what classification survived (mirrors update()).
    assert.equal(result.kind, 'content', 'result discloses the carried kind');
    assert.equal(result.importance, 0.8, 'result discloses the carried (max) importance');

    const [merged] = obsFor('skill:test-merge-uniform');
    assert.equal(merged.kind, 'content', 'kind must survive the merge');
    assert.equal(merged.importance, 0.8, 'importance takes the max of the sources, not the 1.0 default');
  });

  test('a uniformly de-prioritised group is not silently promoted to 1.0', async () => {
    await remember({
      entity: 'skill:test-merge-lowimp',
      content: 'Sitemap ping endpoints were deprecated by Google in 2023 and can be dropped.',
      kind: 'content',
      importance: 0.4,
    });
    await remember({
      entity: 'skill:test-merge-lowimp',
      content: 'Legacy meta keywords tags carry no ranking weight in any major engine.',
      kind: 'content',
      importance: 0.4,
    });

    const ids = obsFor('skill:test-merge-lowimp').map(o => o.id);
    await merge({
      observation_ids: ids,
      content: 'Deprecated signals: sitemap ping endpoints and meta keywords both carry no weight.',
    });

    const [merged] = obsFor('skill:test-merge-lowimp');
    assert.equal(merged.importance, 0.4, '1.0 is the schema ceiling, not a neutral default');
  });

  test('null is "no opinion", not a third kind — [null, kind] carries the kind', async () => {
    await remember({
      entity: 'skill:test-merge-nullkind',
      content: 'Run the audit before proposing any template changes to the client.',
      kind: 'trigger',
    });
    await remember({
      entity: 'skill:test-merge-nullkind',
      content: 'An unclassified stray note that was filed without any kind at all.',
    });

    const ids = obsFor('skill:test-merge-nullkind').map(o => o.id);
    assert.equal(ids.length, 2);

    await merge({
      observation_ids: ids,
      content: 'Audit first, then propose template changes; the stray note is folded in here.',
    });

    const [merged] = obsFor('skill:test-merge-nullkind');
    assert.equal(merged.kind, 'trigger', 'a single non-null kind still wins over nulls');
  });

  test('all-null sources merge to a null kind without crashing', async () => {
    await remember({
      entity: 'test-merge-allnull',
      content: 'The kitchen tap was replaced in March and is still under its warranty.',
    });
    await remember({
      entity: 'test-merge-allnull',
      content: 'Gutter clearing is scheduled for late autumn once the leaves are down.',
    });

    const ids = obsFor('test-merge-allnull').map(o => o.id);
    const result = await merge({
      observation_ids: ids,
      content: 'Home tasks: tap replaced in March under warranty; gutters cleared late autumn.',
    });

    assert.equal(result.success, true);
    const [merged] = obsFor('test-merge-allnull');
    assert.equal(merged.kind, null);
  });
});

describe('merge rejects a multi-kind group', () => {
  test('two distinct kinds throw, and the message names both', async () => {
    await remember({
      entity: 'skill:test-merge-conflict',
      content: 'Use this skill when the user asks to plan a programmatic SEO build.',
      kind: 'trigger',
    });
    await remember({
      entity: 'skill:test-merge-conflict',
      content: 'Step one: enumerate the data assets. Step two: map them to search intent.',
      kind: 'content',
    });

    const ids = obsFor('skill:test-merge-conflict').map(o => o.id);
    assert.equal(ids.length, 2);

    await assert.rejects(
      () => merge({
        observation_ids: ids,
        content: 'Trigger plus procedure, collapsed into a single blob.',
      }),
      (err: Error) => {
        assert.match(err.message, /different kinds/i);
        assert.match(err.message, /"trigger"/);
        assert.match(err.message, /"content"/);
        return true;
      }
    );
  });

  test('a rejected merge deletes nothing — the sources survive intact', async () => {
    await remember({
      entity: 'block:test-merge-nondestructive',
      content: 'Idea: a weekly digest that only surfaces what changed since the last read.',
      kind: 'idea',
      importance: 0.9,
    });
    await remember({
      entity: 'block:test-merge-nondestructive',
      content: 'Seed: could the same digest engine power a public changelog page later?',
      kind: 'seed',
      importance: 0.5,
    });

    const before = obsFor('block:test-merge-nondestructive');
    assert.equal(before.length, 2);

    await assert.rejects(() => merge({
      observation_ids: before.map(o => o.id),
      content: 'Digest idea and its downstream seed, collapsed.',
    }));

    const after = obsFor('block:test-merge-nondestructive');
    assert.equal(after.length, 2, 'a rejected merge must not delete its sources');
    assert.deepEqual(
      after.map(o => o.kind).sort(),
      ['idea', 'seed'],
      'both kinds still present and unchanged'
    );
    assert.deepEqual(
      after.map(o => o.importance).sort(),
      [0.5, 0.9],
      'importance untouched by the rejected merge'
    );
  });
});

describe('remember dedup-replace carries the deleted observation metadata', () => {
  test('a longer same-day near-duplicate written without kind/importance inherits both', async () => {
    // Found in the D18 review: the dedup-replace branch of remember() DELETES the
    // matched observation and wrote the caller's (absent) metadata over it, so a
    // plain restatement of a skill trigger silently became kind null / importance 1.0.
    await remember({
      entity: 'skill:test-replace-carry',
      content: 'Use this skill when the user asks to plan a programmatic SEO build.',
      kind: 'trigger',
      importance: 0.3,
    });
    const second = await remember({
      entity: 'skill:test-replace-carry',
      content: 'Use this skill when the user asks to plan a programmatic SEO build, or to audit one.',
    });
    // The test must exercise the replace path, not pass vacuously on a fresh insert.
    assert.equal(second.replaced, true, 'the longer near-duplicate must take the dedup-replace path');

    const after = obsFor('skill:test-replace-carry');
    assert.equal(after.length, 1, 'replace leaves exactly one observation');
    assert.equal(after[0].kind, 'trigger', 'kind inherited from the deleted observation');
    assert.equal(after[0].importance, 0.3, 'importance inherited from the deleted observation');
  });

  test('an explicit kind/importance on the replacing write still wins', async () => {
    await remember({
      entity: 'skill:test-replace-explicit',
      content: 'Trigger: the user wants a landing page audited for conversion.',
      kind: 'trigger',
      importance: 0.4,
    });
    const second = await remember({
      entity: 'skill:test-replace-explicit',
      content: 'Trigger: the user wants a landing page audited for conversion or accessibility.',
      kind: 'content',
      importance: 0.9,
    });
    assert.equal(second.replaced, true);
    const after = obsFor('skill:test-replace-explicit');
    assert.equal(after[0].kind, 'content');
    assert.equal(after[0].importance, 0.9);
  });
});
