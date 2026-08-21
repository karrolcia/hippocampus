/**
 * Regression tests for the dedup-on-write data-loss path (D10).
 *
 * `remember()` deletes an existing observation when a new one scores >= 0.85
 * cosine similarity against it and is longer. On append-only log entities that
 * silently destroyed real entries — four confirmed instances, e.g. 2026-08-21,
 * where a 9,197-char harvest entry evicted the 2026-07-31 harvest entry on
 * `ops:daily-log:hippocampus`. The two were written three weeks apart and were
 * substantively unrelated; they cleared 0.85 purely on the shared log skeleton.
 *
 * Two guards now stand in the way:
 *   1. append-only entities (configured name prefixes) are exempt from dedup;
 *   2. dedup only ever considers observations from the SAME UTC calendar day.
 *
 * Every survival test below asserts the measured similarity actually clears
 * DEDUP_THRESHOLD first — otherwise the test would "pass" on a pair the old
 * code would never have touched, and prove nothing.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-append-only-${Date.now()}.db`);

// Must set env before importing project modules (config.ts reads eagerly)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-append-only';
process.env.HIPPO_DB_PATH = DB_PATH;
delete process.env.HIPPO_APPEND_ONLY_PREFIXES; // exercise the shipped defaults

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember, isAppendOnlyEntity, DEDUP_THRESHOLD } = await import('../src/mcp/tools/remember.js');
const { update } = await import('../src/mcp/tools/update.js');
const { findEntityByName } = await import('../src/db/entities.js');
const { getObservationsByEntity } = await import('../src/db/observations.js');
const { generateEmbedding } = await import('../src/embeddings/embedder.js');
const { cosineSimilarity } = await import('../src/embeddings/similarity.js');

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

/**
 * `createObservation` hardcodes datetime('now'), so a different-day fixture has
 * to be backdated in SQL. `getEmbeddingsByEntity` reads created_at off the
 * observations join, so this is the only copy that needs moving.
 */
function backdateObservation(observationId: string, day: string): void {
  getDatabase()
    .prepare('UPDATE observations SET created_at = ? WHERE id = ?')
    .run(`${day} 09:14:16`, observationId);
}

function observationsFor(entityName: string) {
  const entity = findEntityByName(entityName);
  assert.ok(entity, `entity ${entityName} should exist`);
  return getObservationsByEntity(entity!.id);
}

async function assertWouldHaveDeduped(a: string, b: string): Promise<number> {
  const [va, vb] = await Promise.all([generateEmbedding(a), generateEmbedding(b)]);
  const sim = cosineSimilarity(va, vb);
  assert.ok(
    sim >= DEDUP_THRESHOLD,
    `fixture pair must clear the dedup threshold to be a meaningful regression ` +
      `(got ${sim.toFixed(3)}, need >= ${DEDUP_THRESHOLD})`
  );
  return sim;
}

// Two knowledge-harvest log entries three weeks apart: different windows,
// different entities harvested, same skeleton. This is the 2026-08-21 shape.
const HARVEST_JULY =
  '2026-07-31 knowledge harvest. Idempotency guard: checkpoint found, skipping if already run today. ' +
  'Window: 2026-07-24 to 2026-07-31. HARVESTED: ops:daily-log:hippocampus, ops:daily-log:rsl-content, ' +
  'ops:daily-log:gallant. NOT HARVESTED: ops:daily-log:puffin (no new observations in window), ' +
  'ops:daily-log:room (parked). Coverage limits: recall index capped at 50 entities per pass.';

const HARVEST_AUGUST =
  '2026-08-21 knowledge harvest. Idempotency guard: checkpoint found, skipping if already run today. ' +
  'Window: 2026-08-14 to 2026-08-21. HARVESTED: ops:daily-log:codesea, ops:daily-log:job-search, ' +
  'ops:daily-log:bookkeeping, synthesis:ingest-backlog. NOT HARVESTED: ops:daily-log:in-kitchen ' +
  '(no new observations in window). Coverage limits: recall index capped at 50 entities per pass, ' +
  'and long log entities are read by index rather than in full.';

describe('append-only entities are exempt from dedup', () => {
  test('two similar log entries written on different days both survive', async () => {
    const sim = await assertWouldHaveDeduped(HARVEST_JULY, HARVEST_AUGUST);

    const first = await remember({
      entity: 'ops:daily-log:hippocampus',
      content: HARVEST_JULY,
    });
    assert.equal(first.success, true);
    backdateObservation(first.observationId, '2026-07-31');

    const second = await remember({
      entity: 'ops:daily-log:hippocampus',
      content: HARVEST_AUGUST,
    });

    assert.equal(second.success, true);
    assert.equal(second.replaced, false, 'must not delete anything');
    assert.equal(second.replaced_observation, undefined);
    assert.equal(second.deduplicated, undefined, 'must not swallow the new entry');
    assert.equal(second.append_only, true);
    assert.notEqual(second.observationId, first.observationId);

    const observations = observationsFor('ops:daily-log:hippocampus');
    assert.equal(observations.length, 2, `both entries must survive (similarity ${sim.toFixed(3)})`);
    const contents = observations.map(o => o.content);
    assert.ok(contents.includes(HARVEST_JULY), 'the July entry must still be there');
    assert.ok(contents.includes(HARVEST_AUGUST));
  });

  test('the suppressed high-similarity match is reported in near_matches, not hidden', async () => {
    // The old failure mode: >= 0.85 matches never appeared in near_matches, so a
    // caller checking that field saw an empty list at the exact moment data died.
    const first = await remember({
      entity: 'ops:session-check',
      content: HARVEST_JULY,
    });
    backdateObservation(first.observationId, '2026-07-31');

    const second = await remember({
      entity: 'ops:session-check',
      content: HARVEST_AUGUST,
    });

    assert.ok(second.near_matches && second.near_matches.length > 0, 'overlap must be surfaced');
    assert.ok(
      second.near_matches!.some(m => m.similarity >= DEDUP_THRESHOLD),
      'the >= 0.85 match must be visible to the caller'
    );
    assert.equal(observationsFor('ops:session-check').length, 2);
  });

  test('a correction quoting its target at length does not evict the target', async () => {
    // 2026-08-14: a correction written to synthesis:ingest-backlog evicted the
    // very observation it was correcting (sim 0.867). Same day, so only the
    // append-only exemption can save this one.
    const target =
      'Ingest backlog as of 2026-08-13: 42 research findings pending, 6 granola transcripts unmatched, ' +
      'oldest item 2026-07-02. Blocked on the sync script hitting a Keychain timeout mid-run.';
    // Quotes the target in full, then corrects it — the shape that scored 0.867
    // in the real incident. Measured at ~0.893 here.
    const correction =
      'CORRECTION. ' + target + ' The Keychain blocker in that note is wrong — it was fixed on 2026-08-09.';

    const sim = await assertWouldHaveDeduped(target, correction);
    assert.ok(correction.length > target.length, 'correction must be the longer one (the replace path)');

    const first = await remember({ entity: 'synthesis:ingest-backlog', content: target });
    const second = await remember({ entity: 'synthesis:ingest-backlog', content: correction });

    assert.equal(second.replaced, false, `must not delete the target (similarity ${sim.toFixed(3)})`);
    assert.equal(second.deduplicated, undefined);

    const observations = observationsFor('synthesis:ingest-backlog');
    assert.equal(observations.length, 2);
    assert.ok(observations.some(o => o.content === target), 'the corrected observation must survive');
  });

  test('a reported near_match cannot be handed back as a delete key', async () => {
    // The guard preserves the entry, and then the response has to not invite the
    // caller to remove it by hand. near_matches content is otherwise
    // byte-identical to the stored observation, which is exactly what `update`
    // matches on — and onboard's standing instruction is "high overlap + low
    // novelty -> update or merge". Previews break that chain.
    const entity = 'ops:daily-log:preview';
    const first = await remember({ entity, content: HARVEST_JULY });
    backdateObservation(first.observationId, '2026-07-31');
    const second = await remember({ entity, content: HARVEST_AUGUST });

    const reported = second.near_matches?.[0];
    assert.ok(reported, 'the overlap must still be reported');
    assert.ok(HARVEST_JULY.length > 200, 'fixture must be long enough to be truncated');
    assert.notEqual(reported!.content, HARVEST_JULY, 'must not echo the stored content verbatim');
    assert.ok(reported!.content.length <= 201, 'preview only');
    assert.match(second.message, /Do NOT consolidate/);
    assert.doesNotMatch(second.message, /consider consolidating/);

    // The whole point: feeding it back into update() fails safe.
    const attempted = await update({
      entity,
      old_content: reported!.content,
      new_content: 'merged harvest entry',
    });
    assert.equal(attempted.success, false);
    assert.equal(observationsFor(entity).length, 2, 'both entries must still be there');
  });

  test('a leading-whitespace entity name is still protected', async () => {
    // Entity names are stored verbatim (the content sanitizer deliberately keeps
    // \t, \n, \r) and looked up by exact match, so " synthesis:x" is a distinct
    // entity. Before trim(), one stray space reopened the delete path.
    const entity = ' synthesis:whitespace-name';
    const target =
      'Ingest backlog as of 2026-08-13: 42 research findings pending, 6 granola transcripts unmatched, ' +
      'oldest item 2026-07-02. Blocked on the sync script hitting a Keychain timeout mid-run.';
    const correction =
      'CORRECTION. ' + target + ' The Keychain blocker in that note is wrong — it was fixed on 2026-08-09.';

    assert.equal(isAppendOnlyEntity(entity), true, 'the guard must trim before matching');

    await remember({ entity, content: target });
    const second = await remember({ entity, content: correction });

    assert.equal(second.replaced, false);
    assert.equal(observationsFor(entity).length, 2);
  });

  test('isAppendOnlyEntity matches configured prefixes, case-insensitively', () => {
    assert.equal(isAppendOnlyEntity('ops:daily-log:hippocampus'), true);
    assert.equal(isAppendOnlyEntity('ops:session-check'), true);
    assert.equal(isAppendOnlyEntity('synthesis:ingest-backlog'), true);
    assert.equal(isAppendOnlyEntity('OPS:Daily-Log:Hippocampus'), true);
    assert.equal(isAppendOnlyEntity('user'), false);
    assert.equal(isAppendOnlyEntity('project:hippocampus'), false);
    assert.equal(isAppendOnlyEntity('ops:active-threads'), false);
  });
});

describe('dedup is scoped to the same UTC calendar day', () => {
  test('similar entries on different days survive even on a non-exempt entity', async () => {
    // The general guard: protects log entities nobody remembered to list.
    const sim = await assertWouldHaveDeduped(HARVEST_JULY, HARVEST_AUGUST);

    const first = await remember({ entity: 'project:unlisted-log', content: HARVEST_JULY });
    backdateObservation(first.observationId, '2026-07-31');

    const second = await remember({ entity: 'project:unlisted-log', content: HARVEST_AUGUST });

    assert.equal(second.replaced, false, `must not delete anything (similarity ${sim.toFixed(3)})`);
    assert.equal(second.deduplicated, undefined);
    assert.equal(second.append_only, undefined, 'this entity is not append-only');
    assert.ok(
      second.near_matches?.some(m => m.similarity >= DEDUP_THRESHOLD),
      'the out-of-day >= 0.85 match must still be reported'
    );
    assert.equal(observationsFor('project:unlisted-log').length, 2);
  });

  test('non-append-only entities keep full near_match content', async () => {
    // Consolidation IS the intended workflow off the log entities ("consolidate =
    // clustering only, the AI does the merging"), and it needs the exact content
    // as an update key. The preview truncation must not leak into that path.
    const first = await remember({ entity: 'project:full-near-match', content: HARVEST_JULY });
    backdateObservation(first.observationId, '2026-07-31');
    const second = await remember({ entity: 'project:full-near-match', content: HARVEST_AUGUST });

    assert.equal(second.near_matches?.[0].content, HARVEST_JULY);
    assert.match(second.message, /consider consolidating/);
  });

  test('yesterday counts as a different day', async () => {
    const first = await remember({ entity: 'project:yesterday-log', content: HARVEST_JULY });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    backdateObservation(first.observationId, yesterday);

    const second = await remember({ entity: 'project:yesterday-log', content: HARVEST_AUGUST });

    assert.equal(second.replaced, false);
    assert.equal(observationsFor('project:yesterday-log').length, 2);
  });
});

describe('same-day dedup still works, and announces deletion', () => {
  const short = 'Karolina has a PhD in atmospheric physics from TU Delft';
  const long = 'Karolina has a PhD in atmospheric physics from TU Delft and works in climate tech';

  test('replacing an observation sets replaced: true with the evicted text and id', async () => {
    const first = await remember({ entity: 'user:dedup-same-day', content: short });
    const second = await remember({ entity: 'user:dedup-same-day', content: long });

    assert.equal(second.replaced, true, 'destruction must be visible as a top-level boolean');
    assert.equal(second.replaced_observation, short, 'evicted text must be recoverable');
    assert.equal(second.replaced_observation_id, first.observationId);
    assert.ok(second.message.includes('DELETED'));
    assert.equal(observationsFor('user:dedup-same-day').length, 1);
  });

  test('skipping a same-day duplicate reports replaced: false', async () => {
    await remember({ entity: 'user:dedup-skip', content: long });
    const second = await remember({ entity: 'user:dedup-skip', content: short });

    assert.equal(second.deduplicated, true);
    assert.equal(second.replaced, false, 'a skip destroys nothing');
    assert.equal(second.replaced_observation, undefined);
    assert.equal(observationsFor('user:dedup-skip').length, 1);
  });

  test('replace_kind reports its deletions too', async () => {
    const first = await remember({
      entity: 'agent:test-checkpoint',
      content: 'last run 2026-08-20T21:47:00Z, 3 contexts written',
      kind: 'checkpoint',
      replace_kind: true,
    });
    assert.equal(first.replaced, false);
    assert.equal(first.replaced_count, 0);

    const second = await remember({
      entity: 'agent:test-checkpoint',
      content: 'last run 2026-08-21T21:47:00Z, 5 contexts written',
      kind: 'checkpoint',
      replace_kind: true,
    });
    assert.equal(second.replaced, true);
    assert.equal(second.replaced_count, 1);
    assert.deepEqual(second.replaced_observations, [
      { observation_id: first.observationId, content: 'last run 2026-08-20T21:47:00Z, 3 contexts written' },
    ]);
    assert.equal(observationsFor('agent:test-checkpoint').length, 1);
  });

  test('replace_kind on an append-only entity returns everything it deleted', async () => {
    // replace_kind is explicit caller intent, so it is not blocked here — but it
    // has the widest blast radius of any remember() path (N observations, not
    // one), so the response has to carry enough to put them back.
    const entries = ['harvest run one, 3 contexts', 'harvest run two, 5 contexts'];
    for (const content of entries) {
      await remember({ entity: 'ops:daily-log:replace-kind', content, kind: 'harvest' });
    }
    assert.equal(observationsFor('ops:daily-log:replace-kind').length, 2);

    const result = await remember({
      entity: 'ops:daily-log:replace-kind',
      content: 'harvest run three, 2 contexts',
      kind: 'harvest',
      replace_kind: true,
    });

    assert.equal(result.replaced, true);
    assert.equal(result.replaced_count, 2);
    assert.equal(result.append_only, true, 'caller must see it bulk-deleted from a log entity');
    assert.deepEqual(
      result.replaced_observations?.map(o => o.content).sort(),
      [...entries].sort(),
      'both deleted entries must be recoverable from the response'
    );
    assert.equal(observationsFor('ops:daily-log:replace-kind').length, 1);
  });
});
