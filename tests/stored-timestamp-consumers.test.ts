/**
 * Regression tests for the consumers of `parseStoredTimestamp` and `datePart`.
 *
 * Round-2 review of D13 found these three fixes shipping with no coverage
 * between them: reverting all three at once left the suite fully green.
 * `parseStoredTimestamp` was unit-tested, but nothing asserted that `recall`
 * and `consolidate` actually CALL it, and the sleep-mode NaN guard and
 * `export`'s date formatting had no test at all. The NaN guard in particular
 * protects a delete-candidate bucket.
 *
 * Isolated database: these fixtures corrupt timestamps and drive `consolidate`,
 * neither of which belongs in a store other tests count rows in.
 */
// Before every import. Node applies a runtime TZ change to Date, and on a UTC
// host the local-vs-UTC assertions below would be vacuous. Helsinki is +02/+03
// year-round, and the 'TZ override took effect' test below fails if this
// stops working.
process.env.TZ = 'Europe/Helsinki';

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-stored-ts-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-stored-timestamps';
process.env.HIPPO_DB_PATH = DB_PATH;
process.env.HIPPO_APPEND_ONLY_PREFIXES = 'ops:daily-log:';

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { consolidate } = await import('../src/mcp/tools/consolidate.js');
const { exportMemories } = await import('../src/mcp/tools/export.js');
const { findEntityByName } = await import('../src/db/entities.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The stored form, in UTC, for a given instant. */
function storedForm(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

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

test('TZ override took effect (else every assertion below is vacuous)', () => {
  assert.notEqual(
    new Date().getTimezoneOffset(),
    0,
    'expected a non-UTC test TZ — process.env.TZ = Europe/Helsinki did not take effect'
  );
});

// ---------------------------------------------------------------------------
// recall's staleness hint reads created_at as UTC
// ---------------------------------------------------------------------------

describe('recall staleness is computed in UTC, not host local time', () => {
  const ENTITY = 'test:stale-boundary';

  before(async () => {
    // Placed just INSIDE the 30-day window — 29d23h old. Reading the stored form
    // as local time makes the instant look one offset earlier, tipping it over
    // the threshold: `stale` is false under the correct UTC reading and true
    // under a bare `new Date()`.
    //
    // The cushion must be SMALLER than the host's UTC offset or the test stops
    // discriminating. Helsinki is +03 in summer but +02 from late October to
    // late March, so a 2h cushion would collapse the margin to the milliseconds
    // of test-execution time for half the year — a test that quietly goes
    // marginal on a calendar date. 1h leaves a full hour at the worst offset.
    await remember({ entity: ENTITY, content: 'boundary observation about arctic sea ice extent' });
    // A later write so the entity has newer information — the other half of the
    // stale condition, without which nothing is ever flagged.
    await remember({ entity: ENTITY, content: 'follow-up note on arctic sea ice extent trends' });

    const db = getDatabase();
    const entity = findEntityByName(ENTITY);
    assert.ok(entity, 'fixture entity should exist');
    const rows = db
      .prepare('SELECT id FROM observations WHERE entity_id = ? ORDER BY content')
      .all(entity!.id) as Array<{ id: string }>;
    assert.equal(rows.length, 2, 'both fixture observations should be stored');

    const now = Date.now();
    db.prepare('UPDATE observations SET created_at = ? WHERE id = ?')
      .run(storedForm(now - (30 * DAY - 1 * HOUR)), rows[0].id);
    db.prepare('UPDATE entities SET updated_at = ? WHERE id = ?')
      .run(storedForm(now), entity!.id);
  });

  test('an observation just inside the 30-day window is not flagged stale', async () => {
    const result = (await recall({
      query: 'arctic sea ice extent',
      limit: 50,
      spread: false,
      format: 'full',
    } as Parameters<typeof recall>[0])) as {
      memories: Array<{ content: string; stale?: boolean; remembered_at: string }>;
    };

    const boundary = result.memories.find(m => m.content.startsWith('boundary observation'));
    assert.ok(boundary, 'the boundary observation should be recalled');

    // Guards the fixture itself: if the age drifts outside 28-30 days the test
    // is no longer sitting on the boundary and proves nothing.
    const ageDays = (Date.now() - Date.parse(`${boundary!.remembered_at.replace(' ', 'T')}Z`)) / DAY;
    assert.ok(ageDays > 29.9 && ageDays < 30, `fixture off the boundary: ${ageDays} days`);

    assert.notEqual(
      boundary!.stale,
      true,
      'a 29d22h-old observation read as local time looks 30d1h old and is wrongly flagged stale'
    );
  });
});

// ---------------------------------------------------------------------------
// consolidate sleep mode: an unknown age must not become a delete candidate
// ---------------------------------------------------------------------------

describe('consolidate sleep mode and unparseable timestamps', () => {
  const ENTITY = 'test:sleep-nan';

  before(async () => {
    await remember({ entity: ENTITY, content: 'observation whose timestamp will be corrupted' });
    const db = getDatabase();
    const entity = findEntityByName(ENTITY);
    assert.ok(entity);
    db.prepare('UPDATE observations SET created_at = ? WHERE entity_id = ?')
      .run('not-a-timestamp', entity!.id);
  });

  test('an unparseable created_at is not proposed for deletion', async () => {
    const result = (await consolidate({ entity: ENTITY, mode: 'sleep', age_days: 0 })) as {
      prune?: Array<{ observation_id: string; entity: string }>;
      compress?: Array<{ entity: string }>;
      refresh?: Array<{ entity: string }>;
    };

    // NaN age is falsy against every threshold, so without the guard it slips
    // past the too-young check and lands in `prune` — proposed for deletion
    // precisely because its age could not be established.
    for (const bucket of ['prune', 'compress', 'refresh'] as const) {
      const hits = (result[bucket] ?? []).filter(o => o.entity === ENTITY);
      assert.deepEqual(hits, [], `unparseable-timestamp observation appeared in ${bucket}`);
    }
  });

  test('a NULL created_at does not throw the whole pass', async () => {
    // `created_at` carries no NOT NULL, so this is reachable — and before the
    // null guard it was a TypeError out of the entire consolidate call.
    const nullEntity = 'test:sleep-null';
    await remember({ entity: nullEntity, content: 'observation with a null timestamp' });
    const db = getDatabase();
    const entity = findEntityByName(nullEntity);
    assert.ok(entity);
    db.prepare('UPDATE observations SET created_at = NULL WHERE entity_id = ?').run(entity!.id);

    const result = (await consolidate({ entity: nullEntity, mode: 'sleep', age_days: 0 })) as {
      success?: boolean;
      prune?: Array<{ entity: string }>;
    };
    assert.deepEqual(
      (result.prune ?? []).filter(o => o.entity === nullEntity),
      [],
      'a null timestamp must not become a delete candidate either'
    );
  });

  test('recall survives a NULL created_at rather than throwing', async () => {
    const result = (await recall({
      query: 'observation with a null timestamp',
      limit: 10,
      spread: false,
      format: 'full',
    } as Parameters<typeof recall>[0])) as { success: boolean };
    assert.equal(result.success, true, 'one null row must not take out the whole call');
  });
});

// ---------------------------------------------------------------------------
// export prints the DATE half of a stored timestamp
// ---------------------------------------------------------------------------

describe('export formats stored timestamps as dates', () => {
  const ENTITY = 'test:export-dates';

  before(async () => {
    await remember({ entity: ENTITY, content: 'exported observation about tidal gauges' });
    const db = getDatabase();
    const entity = findEntityByName(ENTITY);
    assert.ok(entity);
    db.prepare('UPDATE observations SET created_at = ? WHERE entity_id = ?')
      .run('2026-08-25 10:36:55', entity!.id);
    db.prepare('UPDATE entities SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2026-08-24 09:00:00', '2026-08-25 10:36:55', entity!.id);
  });

  test('markdown export shows a date, not the whole timestamp', () => {
    const result = exportMemories({ format: 'markdown', entity: ENTITY });
    assert.equal(result.success, true);
    assert.match(result.data, /\[2026-08-25\]/, 'expected a bare date in the observation meta');
    assert.doesNotMatch(
      result.data,
      /2026-08-25 10:36:55/,
      'splitting on "T" left the whole space-separated timestamp in place'
    );
  });

  test('obsidian export frontmatter dates are dates', () => {
    const result = exportMemories({ format: 'obsidian', entity: ENTITY });
    assert.equal(result.success, true);
    assert.doesNotMatch(result.data, /created: 2026-08-24 09:00:00/);
    assert.doesNotMatch(result.data, /updated: 2026-08-25 10:36:55/);
    assert.match(result.data, /created: 2026-08-24\b/);
    assert.match(result.data, /updated: 2026-08-25\b/);
  });

  test('an ISO-form timestamp still yields a date (both separators handled)', () => {
    const isoEntity = 'test:export-dates-iso';
    const db = getDatabase();
    return remember({ entity: isoEntity, content: 'iso-stamped observation about tidal gauges' })
      .then(() => {
        const entity = findEntityByName(isoEntity);
        assert.ok(entity);
        db.prepare('UPDATE observations SET created_at = ? WHERE entity_id = ?')
          .run('2026-08-25T10:36:55.000Z', entity!.id);
        const result = exportMemories({ format: 'markdown', entity: isoEntity });
        assert.match(result.data, /\[2026-08-25\]/);
      });
  });
});
