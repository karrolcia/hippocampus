/**
 * Regression tests for D11 — `consolidate` must not propose consolidating
 * append-only log entities.
 *
 * D10 stopped `remember` from silently evicting dated log entries. It did not
 * touch `consolidate`, which proposes and whose proposals `merge`,
 * `merge_entities` and `update` execute:
 *   - observations mode clusters consecutive harvest entries (measured 0.948,
 *     well over the 0.8 default) and says "use merge to consolidate";
 *   - sleep mode buckets every never-recalled old observation as `prune`,
 *     which is the entire ops:daily-log:* history;
 *   - entities mode scores ops:daily-log:codesea against
 *     ops:daily-log:rsl-content at 0.688 — a whisker under the 0.7 default, so
 *     one threshold tweak from proposing a cross-project log merge.
 *
 * Each test below pairs the exclusion with a control on a non-append-only
 * entity (or via include_append_only), so it fails if the fixture stopped
 * being something consolidate would have proposed in the first place.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-consolidate-ao-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-consolidate-append-only';
process.env.HIPPO_DB_PATH = DB_PATH;
delete process.env.HIPPO_APPEND_ONLY_PREFIXES;

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { consolidate } = await import('../src/mcp/tools/consolidate.js');
const type = await import('../src/mcp/tools/consolidate.js');

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

/** Sleep mode only looks at observations older than age_days and counts recalls. */
function ageObservation(observationId: string, days: number, recallCount = 0): void {
  getDatabase()
    .prepare(
      `UPDATE observations
       SET created_at = datetime('now', ?), recall_count = ?
       WHERE id = ?`
    )
    .run(`-${days} days`, recallCount, observationId);
}

/**
 * Writes the two harvest entries three weeks apart, as they were written in
 * life. The backdating is load-bearing on the CONTROL entities: these two score
 * 0.948, so on an ordinary entity written the same day D10's own dedup replaces
 * the first with the second, and the control silently degrades to a single
 * observation — which is neither a cluster nor a two-entry prune list.
 */
async function seedPair(entity: string): Promise<string[]> {
  const ids: string[] = [];
  for (const content of [HARVEST_JULY, HARVEST_AUGUST]) {
    const result = await remember({ entity, content });
    ids.push(result.observationId);
    if (ids.length === 1) ageObservation(result.observationId, 21);
  }
  return ids;
}

describe('consolidate: observations mode', () => {
  test('a log entity yields no merge proposal, and says why', async () => {
    await seedPair('ops:daily-log:consolidate-probe');

    const result = (await consolidate({
      entity: 'ops:daily-log:consolidate-probe',
    })) as type.ConsolidateResult;

    assert.equal(result.clusters.length, 0, 'must not propose merging dated log entries');
    assert.equal(result.excluded_append_only, 2, 'the drop must be counted, never silent');
    assert.match(result.message, /append-only/);
    assert.doesNotMatch(result.message, /use merge to consolidate/);
    // The misleading-all-clear shape: a bare "no observations" would read as
    // "nothing here" rather than "these are protected".
    assert.doesNotMatch(result.message, /^No observations found\.$/);
  });

  test('CONTROL: the same pair on an ordinary entity still clusters', async () => {
    // Without this the test above could pass on a pair consolidate would never
    // have grouped, and would prove nothing.
    await seedPair('project:consolidate-control');

    const result = (await consolidate({
      entity: 'project:consolidate-control',
    })) as type.ConsolidateResult;

    assert.equal(result.clusters.length, 1, 'fixture must be a real cluster candidate');
    assert.equal(result.clusters[0].observations.length, 2);
    assert.ok(result.clusters[0].avg_similarity >= 0.8);
    assert.equal(result.excluded_append_only, 0);
    assert.match(result.message, /use merge to consolidate/);
  });

  test('include_append_only re-opens it, with members flagged', async () => {
    const result = (await consolidate({
      entity: 'ops:daily-log:consolidate-probe',
      include_append_only: true,
    })) as type.ConsolidateResult;

    assert.equal(result.clusters.length, 1, 'the escape hatch must actually restore detection');
    assert.equal(result.excluded_append_only, 0);
    assert.ok(
      result.clusters[0].observations.every(o => o.append_only === true),
      'members must still be marked as append-only'
    );
  });
});

describe('consolidate: sleep mode', () => {
  test('log entries are never prune, compress or refresh candidates', async () => {
    const ids = await seedPair('ops:daily-log:sleep-probe');
    // Old + never recalled = the exact prune signature, and the natural state of
    // every historical daily-log entry.
    for (const id of ids) ageObservation(id, 200, 0);

    const result = (await consolidate({
      entity: 'ops:daily-log:sleep-probe',
      mode: 'sleep',
    })) as type.SleepResult;

    assert.equal(result.prune.length, 0, 'the log history must not be a delete proposal');
    assert.equal(result.compress.length, 0);
    assert.equal(result.refresh.length, 0);
    assert.equal(result.excluded_append_only, 2);
    assert.match(result.message, /append-only/);
  });

  test('CONTROL: identical age and recall shape on an ordinary entity IS pruned', async () => {
    const ids = await seedPair('project:sleep-control');
    for (const id of ids) ageObservation(id, 200, 0);

    const result = (await consolidate({
      entity: 'project:sleep-control',
      mode: 'sleep',
    })) as type.SleepResult;

    assert.equal(result.prune.length, 2, 'fixture must be a real prune candidate');
    assert.equal(result.excluded_append_only, 0);
  });

  test('a store-wide pass excludes log entities without excluding everything else', async () => {
    // This is the shape the fortnightly dreaming pass actually runs.
    const result = (await consolidate({ mode: 'sleep' })) as type.SleepResult;

    assert.ok(result.excluded_append_only >= 4, 'both log entities seeded above are excluded');
    assert.ok(result.prune.length > 0, 'genuine candidates must still surface');
    assert.ok(
      result.prune.every(o => !o.entity.startsWith('ops:daily-log:')),
      'no log entry may appear in a store-wide prune list'
    );
  });
});

describe('consolidate: contradictions mode', () => {
  // The contradiction predicate needs high embedding similarity AND low lexical
  // overlap, which pull against each other: two log entries worded differently
  // enough to clear jaccard < 0.3 also drift apart in embedding space. This pair
  // measures 0.521 / 0.000, so the test sets threshold 0.45 to reach the pairing
  // it wants to prove is suppressed. Asserting pairs.length === 0 at the 0.6
  // default would pass whether or not the filter existed.
  const CLEAN = '2026-08-01 nightly check. All contexts wrote daily logs. Zero gaps.';
  const DIRTY = '2026-08-02 session sweep. Multiple projects skipped their write. Several holes.';

  test('log entries are not paired as contradictions', async () => {
    for (const content of [CLEAN, DIRTY]) {
      await remember({ entity: 'ops:daily-log:contradiction-probe', content });
    }

    const result = (await consolidate({
      entity: 'ops:daily-log:contradiction-probe',
      mode: 'contradictions',
      threshold: 0.45,
    })) as type.ContradictionResult;

    assert.equal(result.pairs.length, 0);
    assert.equal(result.excluded_append_only, 2);
    assert.match(result.message, /append-only/);
  });

  test('CONTROL: the same pair does get flagged when included', async () => {
    const result = (await consolidate({
      entity: 'ops:daily-log:contradiction-probe',
      mode: 'contradictions',
      threshold: 0.45,
      include_append_only: true,
    })) as type.ContradictionResult;

    assert.equal(result.pairs.length, 1, 'fixture must be a real contradiction candidate');
    assert.equal(result.excluded_append_only, 0);
    assert.ok(result.pairs[0].observations.every(o => o.append_only === true));
  });
});

describe('consolidate: entities mode', () => {
  test('log entities are not proposed as the same entity', async () => {
    // ops:daily-log:codesea <-> ops:daily-log:rsl-content measures 0.688, so it
    // clusters at any threshold below the 0.7 default. Merging them would fold
    // two projects' logs into one entity.
    await remember({ entity: 'ops:daily-log:codesea', content: 'CodeSea log entry for today' });
    await remember({ entity: 'ops:daily-log:rsl-content', content: 'RSL content log entry for today' });

    const excluded = (await consolidate({
      mode: 'entities',
      threshold: 0.65,
    })) as type.EntityResolutionResult;

    const names = excluded.clusters.flatMap(c => c.entities.map(e => e.name));
    assert.ok(
      !names.includes('ops:daily-log:codesea') && !names.includes('ops:daily-log:rsl-content'),
      'log entities must not be merge_entities candidates'
    );
    assert.ok(excluded.excluded_append_only >= 2);
    assert.match(excluded.message, /append-only/);

    // CONTROL: they genuinely do cluster at this threshold — the exclusion is
    // doing the work, not the threshold.
    const included = (await consolidate({
      mode: 'entities',
      threshold: 0.65,
      include_append_only: true,
    })) as type.EntityResolutionResult;

    const includedNames = included.clusters.flatMap(c => c.entities.map(e => e.name));
    assert.ok(
      includedNames.includes('ops:daily-log:codesea'),
      'fixture must be a real entity-cluster candidate'
    );
    assert.equal(included.excluded_append_only, 0);

    // merge_entities DELETES the source entity, so a cluster surfaced through the
    // hatch must still carry the marker onboard's never-merge exception reads.
    const logCluster = included.clusters.find(c =>
      c.entities.some(e => e.name === 'ops:daily-log:codesea')
    );
    assert.ok(
      logCluster!.entities.every(e => e.append_only === true),
      'append-only members must be marked, not silently listed as merge candidates'
    );
  });
});
