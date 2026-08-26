/**
 * The dangerous half of the `spread: true` + `since` gap, on an isolated
 * database — this fixture is deliberately engineered to out-rank the in-window
 * row, which would skew the count assertions in `recall-since.test.ts` if it
 * shared a store with them.
 *
 * See D13. Found in review of the first cut of that fix.
 */
process.env.TZ = 'Europe/Helsinki';

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-recall-spread-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-recall-spread';
process.env.HIPPO_DB_PATH = DB_PATH;
// Three near-verbatim observations on one entity on one day is exactly what
// dedup-on-write deletes (D10); an append-only entity is exempt.
process.env.HIPPO_APPEND_ONLY_PREFIXES = 'ops:daily-log:';

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { findEntityByName } = await import('../src/db/entities.js');
const { createRelationship } = await import('../src/db/relationships.js');

type FullRecall = { success: boolean; count: number; memories: Array<{ observation_id: string }> };

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
// The dangerous half of the spread gap, on its own fixture.
//
// Unfiltered spread results are merged, re-sorted by score and sliced to
// `limit`, so a damped out-of-window hit can DISPLACE the in-window rows the
// caller asked for. Measured on this fixture before the guard existed:
//
//   limit=1  count=1  inWindow=0   [2020-01-01|0.5]
//   limit=2  count=2  inWindow=0   [2020-01-01|0.535, 2020-01-01|0.441]
//
// A full-looking result set holding nothing but six-year-old rows — worse than
// the empty set this whole change removes, because it reads as a healthy answer.
//
// The fixture needs the out-of-window content to out-score the in-window row by
// more than the 0.5 spread decay, so: near-verbatim matches out of window, and
// one in-window row where the phrase is diluted through unrelated prose.
// ---------------------------------------------------------------------------

const DISPLACE_QUERY = 'orbital telemetry';
const DISPLACE_NEAR = 'ops:daily-log:test-displace-near';
const DISPLACE_FAR = 'ops:daily-log:test-displace-far';

describe('spread results cannot displace in-window rows out of the answer', () => {
  before(async () => {
    await remember({
      entity: DISPLACE_NEAR,
      content:
        'Invoice reconciliation for the Helsinki office lease, catering deposits, ' +
        'three bicycle repairs and a note about orbital telemetry filed under ' +
        'miscellaneous expenses for the quarter.',
    });
    for (const content of ['orbital telemetry', 'orbital telemetry data', 'orbital telemetry stream']) {
      await remember({ entity: DISPLACE_FAR, content });
    }
    const db = getDatabase();
    const near = findEntityByName(DISPLACE_NEAR);
    const far = findEntityByName(DISPLACE_FAR);
    assert.ok(near && far);
    db.prepare('UPDATE observations SET created_at = ? WHERE entity_id = ?')
      .run('2026-08-25 09:00:00', near!.id);
    db.prepare('UPDATE observations SET created_at = ? WHERE entity_id = ?')
      .run('2020-01-01 00:00:00', far!.id);
    createRelationship(near!.id, far!.id, 'related_to');
  });

  async function displaceRecall(limit: number) {
    return (await recall({
      query: DISPLACE_QUERY,
      limit,
      spread: true,
      format: 'full',
      since: '2026-08-25 00:00:00',
    } as Parameters<typeof recall>[0])) as FullRecall & {
      memories: Array<{ observation_id: string; remembered_at: string; similarity?: number }>;
    };
  }

  test('the fixture really does out-score the in-window row (else this proves nothing)', async () => {
    // Without a bound the out-of-window rows must dominate the ranking — that
    // dominance is the mechanism under test. If embeddings ever shift and this
    // stops holding, the assertions below would pass for the wrong reason.
    const unbounded = (await recall({
      query: DISPLACE_QUERY,
      limit: 10,
      spread: true,
      format: 'full',
    } as Parameters<typeof recall>[0])) as FullRecall & {
      memories: Array<{ remembered_at: string }>;
    };
    assert.ok(unbounded.memories.length >= 2, 'fixture should return several rows unbounded');
    assert.ok(
      unbounded.memories[0].remembered_at.startsWith('2020-01-01'),
      'the out-of-window content must rank first, or displacement cannot occur'
    );
  });

  for (const limit of [1, 2, 5]) {
    test(`limit=${limit}: every returned row is in window`, async () => {
      const result = await displaceRecall(limit);
      const displaced = result.memories.filter(m => m.remembered_at < '2026-08-25');
      assert.deepEqual(
        displaced.map(m => m.remembered_at),
        [],
        'out-of-window rows must not be returned at all'
      );
      assert.equal(result.count, 1, 'exactly the one in-window row exists');
      assert.ok(
        result.memories[0].remembered_at.startsWith('2026-08-25'),
        'the row actually asked for must survive the slice'
      );
    });
  }
});
