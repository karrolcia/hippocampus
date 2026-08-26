/**
 * Regression tests for the silent-zero in `recall`'s `since` parameter,
 * measured against the live server 2026-08-26 (D13).
 *
 * Same query, same limit, only the spelling of the bound varying:
 *
 *   since: "2026-08-25"            -> 37 results
 *   since: "2026-08-25 00:00:00"   -> 37 results
 *   since: "2026-08-25 10:36:55"   -> 19 results
 *   since: "2026-08-25T10:36:55"   ->  0 results, success: true, no error
 *   since: "2026-08-25T00:00:00"   ->  0 results, success: true, no error
 *
 * The ISO-8601 `T` separator — the exact spelling the tool's own schema
 * documented — returned the empty set. `created_at` is TEXT holding SQLite's
 * `datetime('now')` output, so `created_at >= ?` is a string comparison, and
 * `T` (0x54) sorts above both the space (0x20) and every digit. The bound
 * exceeded every stored row.
 *
 * It failed toward absence, which is why it survived: every scheduled agent
 * sweeping "what landed since my last run" got `success: true` with nothing in
 * it and concluded nothing had happened.
 */
// Must precede every import: Node applies a runtime TZ change to Date, and a
// UTC host would make the parseStoredTimestamp assertions below vacuous —
// local and UTC would agree and a regression would still pass. Helsinki is
// +02/+03, so the two readings differ all year. The 'TZ override took effect'
// test below fails loudly if this stops working, rather than letting the
// suite go quiet.
process.env.TZ = 'Europe/Helsinki';

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-recall-since-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-recall-since';
process.env.HIPPO_DB_PATH = DB_PATH;
// Pinned rather than inherited: the fixture below writes three deliberately
// similar observations to one entity on one UTC day, which is exactly what
// dedup-on-write deletes (D10). An append-only entity is exempt, so all three
// survive — and it is also the faithful fixture, since the callers this bug
// actually silenced were agents sweeping `ops:daily-log:*` for "what landed
// since my last run".
process.env.HIPPO_APPEND_ONLY_PREFIXES = 'ops:daily-log:';

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { normalizeSinceBound, parseStoredTimestamp, SINCE_CONTRACT_ERROR } = await import('../src/db/timestamps.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { searchObservations } = await import('../src/db/observations.js');
const { findEntityByName } = await import('../src/db/entities.js');
const {
  getEmbeddingsByEntity,
  generateEmbedding,
  semanticSearch,
  semanticSearchWithVector,
} = await import('../src/embeddings/embedder.js');
const { createRelationship } = await import('../src/db/relationships.js');
const { createMcpServer } = await import('../src/mcp/server.js');

const QUERY = 'satellite';
const ENTITY = 'ops:daily-log:test-recall-since';

// Three observations at known UTC instants, spanning a day boundary and
// straddling the 10:36:55 bound used in the live reproduction.
const SEEDED: Array<{ content: string; at: string }> = [
  { content: 'satellite ground segment note alpha', at: '2026-08-24 22:00:00' },
  { content: 'satellite ground segment note bravo', at: '2026-08-25 08:00:00' },
  { content: 'satellite ground segment note charlie', at: '2026-08-25 12:00:00' },
];

before(async () => {
  initDatabase();

  // Seed through `remember` so embeddings exist: the semantic and keyword legs
  // apply `since` in two separate SQL statements, and a fixture with no
  // embeddings would silently test only half the fix.
  for (const { content } of SEEDED) {
    await remember({ entity: ENTITY, content });
  }

  // Backdate to fixed instants — `datetime('now')` would put everything in the
  // same second and no bound could distinguish the rows.
  const db = getDatabase();
  const entity = findEntityByName(ENTITY);
  assert.ok(entity, 'seed entity should exist');
  const rows = db
    .prepare('SELECT id, content FROM observations WHERE entity_id = ? ORDER BY content')
    .all(entity!.id) as Array<{ id: string; content: string }>;
  assert.equal(
    rows.length,
    SEEDED.length,
    'all seeds should have been stored — a short count means dedup-on-write ate one, ' +
      'so the append-only exemption this fixture relies on is not in force'
  );
  for (const row of rows) {
    const seed = SEEDED.find(s => s.content === row.content);
    assert.ok(seed, `unexpected seeded content: ${row.content}`);
    db.prepare('UPDATE observations SET created_at = ? WHERE id = ?').run(seed!.at, row.id);
  }

  assert.equal(
    getEmbeddingsByEntity(entity!.id).length,
    SEEDED.length,
    'fixture must have embeddings or the semantic leg of the filter goes untested'
  );
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

// ---------------------------------------------------------------------------
// The mechanism itself
// ---------------------------------------------------------------------------

describe('the lexicographic trap this fix removes', () => {
  test('an ISO T bound sorts above every stored row', () => {
    // Not an implementation detail — this ordering IS the bug. If it ever stops
    // holding, the rest of these tests are asserting against a phantom.
    assert.ok('T' > ' ', 'T must sort above the stored separator');
    assert.ok('T' > '9', 'T must sort above every digit');
    assert.ok(
      '2026-08-25T00:00:00' >= '2026-08-25 23:59:59',
      'the T-form midnight bound excluded even end-of-day rows from its own day'
    );
  });

  test('normalization removes it — the same instant now compares correctly', () => {
    const bound = normalizeSinceBound('2026-08-25T00:00:00');
    assert.ok(bound <= '2026-08-25 23:59:59', 'normalized bound must include its own day');
    assert.ok(bound <= '2026-08-25 00:00:00', 'and the boundary row itself');
  });
});

// ---------------------------------------------------------------------------
// normalizeSinceBound — accepted spellings
// ---------------------------------------------------------------------------

describe('normalizeSinceBound accepts every documented spelling', () => {
  const accepted: Array<[string, string]> = [
    ['2026-08-25', '2026-08-25 00:00:00'],
    ['2026-08-25 10:36:55', '2026-08-25 10:36:55'],
    ['2026-08-25T10:36:55', '2026-08-25 10:36:55'],
    ['2026-08-25T10:36:55Z', '2026-08-25 10:36:55'],
    ['2026-08-25t10:36:55z', '2026-08-25 10:36:55'],
    ['2026-08-25T10:36', '2026-08-25 10:36:00'],
    ['  2026-08-25T10:36:55Z  ', '2026-08-25 10:36:55'],
  ];

  for (const [input, expected] of accepted) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(normalizeSinceBound(input), expected);
    });
  }

  test('fractional seconds are truncated, not rejected', () => {
    // `new Date().toISOString()` is the likeliest shape a scheduled agent sends.
    assert.equal(normalizeSinceBound('2026-08-25T10:36:55.123Z'), '2026-08-25 10:36:55');
    assert.equal(normalizeSinceBound('2026-08-25T10:36:55.123456789Z'), '2026-08-25 10:36:55');
    // Precision beyond nanoseconds is still a valid instant, not a parse error.
    assert.equal(normalizeSinceBound('2026-08-25T10:36:55.9999999999Z'), '2026-08-25 10:36:55');
  });

  test('a fraction with no seconds is rejected, not silently read as :00', () => {
    // ISO reads the .5 in "10:36.5" as thirty seconds. Accepting it and
    // discarding the fraction would move the bound by 30s without saying so.
    assert.throws(() => normalizeSinceBound('2026-08-25T10:36.5'), /Invalid "since" value/);
    assert.throws(() => normalizeSinceBound('2026-08-25T10:36.5Z'), /Invalid "since" value/);
  });

  test('an offset that pushes the instant out of range is rejected, not widened', () => {
    // `Date` widens past year 9999 to an expanded form (`+010000-01-01`), which
    // sorts BELOW every stored row — so it would match everything rather than
    // erroring. The same bug as the one this module removes, sign flipped.
    assert.throws(() => normalizeSinceBound('9999-12-31T23:00:00-05:00'), /Invalid "since" value/);
    assert.throws(() => normalizeSinceBound('0000-01-01T00:00:00+05:00'), /Invalid "since" value/);
  });

  test('every accepted value comes back in the stored form, exactly', () => {
    for (const input of [
      '2026-08-25',
      '2026-08-25 10:36:55',
      '2026-08-25T10:36:55',
      '2026-08-25T10:36:55.5Z',
      '2026-08-25T13:36:55+03:00',
      '2026-08-25T05:36:55-05:00',
      '0001-01-01T00:00:00Z',
      '9999-12-31T23:59:59Z',
    ]) {
      assert.match(
        normalizeSinceBound(input),
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
        `${input} did not normalize to the stored form`
      );
    }
  });

  test('an offset is converted to UTC, not stripped', () => {
    // Stripping would read 13:36:55+03:00 as 13:36:55Z — three hours of rows
    // silently dropped, the same failure direction in miniature.
    assert.equal(normalizeSinceBound('2026-08-25T13:36:55+03:00'), '2026-08-25 10:36:55');
    assert.equal(normalizeSinceBound('2026-08-25T05:36:55-05:00'), '2026-08-25 10:36:55');
    assert.equal(normalizeSinceBound('2026-08-25T13:36:55+0300'), '2026-08-25 10:36:55');
  });

  test('an offset that crosses midnight moves the date', () => {
    assert.equal(normalizeSinceBound('2026-08-25T01:36:55+03:00'), '2026-08-24 22:36:55');
  });

  test('is idempotent — normalizing its own output changes nothing', () => {
    for (const [input] of accepted) {
      const once = normalizeSinceBound(input);
      assert.equal(normalizeSinceBound(once), once, `not idempotent for ${input}`);
    }
  });

  test('every spelling of one instant normalizes to one bound', () => {
    const sameInstant = [
      '2026-08-25 10:36:55',
      '2026-08-25T10:36:55',
      '2026-08-25T10:36:55Z',
      '2026-08-25T10:36:55.500Z',
      '2026-08-25T13:36:55+03:00',
      '2026-08-25T05:36:55-05:00',
    ].map(normalizeSinceBound);
    assert.equal(new Set(sameInstant).size, 1, `diverged: ${JSON.stringify(sameInstant)}`);
  });
});

// ---------------------------------------------------------------------------
// normalizeSinceBound — rejection. The whole point: never an empty result set.
// ---------------------------------------------------------------------------

describe('normalizeSinceBound rejects rather than filtering everything out', () => {
  const rejected = [
    ['2026-13-01', 'month out of range'],
    ['2026-02-30', 'day out of range for the month'],
    ['2026-02-29', 'day out of range for a non-leap year'],
    ['2026-08-25T25:00:00', 'hour out of range'],
    ['2026-08-25T10:70:00', 'minute out of range'],
    ['2026-08-25T10:36:55+25:00', 'offset out of range'],
    ['2026-8-5', 'unpadded components'],
    ['25-08-2026', 'wrong component order'],
    ['yesterday', 'not a date at all'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['1787654215', 'epoch seconds'],
  ];

  for (const [input, why] of rejected) {
    test(`rejects ${JSON.stringify(input)} (${why})`, () => {
      assert.throws(
        () => normalizeSinceBound(input),
        /Invalid "since" value/,
        `${JSON.stringify(input)} must throw, not silently match nothing`
      );
    });
  }

  test('well-shaped but impossible dates are the ones that matter most', () => {
    // These pass a format regex. Without the round-trip check they would
    // normalize to a bound that matches nothing — the silent zero, one layer in.
    for (const input of ['2026-13-01', '2026-02-30', '2026-08-25T25:00:00']) {
      assert.throws(() => normalizeSinceBound(input), /Invalid "since" value/);
    }
  });

  test('the error names the accepted forms so a caller can fix the call', () => {
    try {
      normalizeSinceBound('yesterday');
      assert.fail('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /YYYY-MM-DD/);
      assert.match(message, /ISO-8601/);
      assert.match(message, /empty result set/);
    }
  });

  test('the echoed value is bounded — the field takes an arbitrary string', () => {
    const huge = 'x'.repeat(5000);
    try {
      normalizeSinceBound(huge);
      assert.fail('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      assert.ok(message.length < 400, `error message unbounded: ${message.length} chars`);
      assert.ok(message.includes('…'), 'long values should be visibly truncated');
    }
  });
});

// ---------------------------------------------------------------------------
// recall() end to end — the contract the task actually cares about
// ---------------------------------------------------------------------------

type FullRecall = { success: boolean; count: number; memories: Array<{ observation_id: string }> };

async function recallSince(since?: string): Promise<FullRecall> {
  const result = await recall({
    query: QUERY,
    limit: 50,
    spread: false,
    format: 'full',
    ...(since === undefined ? {} : { since }),
  } as Parameters<typeof recall>[0]);
  return result as FullRecall;
}

function idsOf(result: FullRecall): string[] {
  return result.memories.map(m => m.observation_id).sort();
}

describe('recall(since) filters by time rather than by spelling', () => {
  test('no bound returns every seeded observation', async () => {
    const result = await recallSince();
    assert.equal(result.success, true);
    assert.equal(result.count, SEEDED.length);
  });

  test('the T form returns exactly what the space form returns', async () => {
    // The headline regression. Before the fix the left side was 0 and the right
    // side was everything, with success: true on both.
    for (const [tForm, spaceForm] of [
      ['2026-08-25T00:00:00', '2026-08-25 00:00:00'],
      ['2026-08-25T10:36:55', '2026-08-25 10:36:55'],
      ['2026-08-24T00:00:00', '2026-08-24 00:00:00'],
    ]) {
      const t = await recallSince(tForm);
      const space = await recallSince(spaceForm);
      assert.deepEqual(idsOf(t), idsOf(space), `${tForm} diverged from ${spaceForm}`);
      assert.equal(t.count, space.count);
    }
  });

  test('a T-form bound is not empty when rows exist after it', async () => {
    // deepEqual above would also pass if BOTH sides returned nothing, which is
    // precisely the bug. Assert presence explicitly.
    const result = await recallSince('2026-08-25T00:00:00');
    assert.equal(result.count, 2, 'bravo and charlie are on 2026-08-25');
    assert.ok(result.count > 0, 'a bound with rows after it must never return empty');
  });

  test('every spelling of one instant returns one result set', async () => {
    const spellings = [
      '2026-08-25 08:00:00',
      '2026-08-25T08:00:00',
      '2026-08-25T08:00:00Z',
      '2026-08-25T08:00:00.000Z',
      '2026-08-25T11:00:00+03:00',
      '2026-08-25T03:00:00-05:00',
    ];
    const sets = await Promise.all(spellings.map(async s => idsOf(await recallSince(s)).join(',')));
    assert.equal(new Set(sets).size, 1, `spellings diverged: ${JSON.stringify(sets)}`);
    assert.equal(sets[0].split(',').length, 2, 'bravo (at the bound) and charlie');
  });

  test('the bound is inclusive and actually excludes what precedes it', async () => {
    assert.equal((await recallSince('2026-08-24 00:00:00')).count, 3);
    assert.equal((await recallSince('2026-08-25 00:00:00')).count, 2);
    assert.equal((await recallSince('2026-08-25 12:00:00')).count, 1, 'inclusive at the boundary');
    assert.equal((await recallSince('2026-08-26 00:00:00')).count, 0, 'genuinely nothing after');
  });

  test('the date-only form still means midnight UTC that day', async () => {
    assert.deepEqual(
      idsOf(await recallSince('2026-08-25')),
      idsOf(await recallSince('2026-08-25 00:00:00'))
    );
  });

  test('an unparseable bound throws instead of returning success with nothing', async () => {
    await assert.rejects(() => recallSince('not-a-date'), /Invalid "since" value/);
    await assert.rejects(() => recallSince('2026-13-01'), /Invalid "since" value/);
  });
});


// ---------------------------------------------------------------------------
// spread: true. Spreading walks relationships and reads embeddings directly, so
// it bypasses both SQL statements — `since` has to be re-applied by hand there.
// Found in review of the first cut of this fix.
// ---------------------------------------------------------------------------

const SPREAD_ENTITY = 'ops:daily-log:test-recall-since-related';

describe('spread: true honours the since bound', () => {
  before(async () => {
    // A related entity whose observations sit far outside any bound used here,
    // linked to the seeded entity so spreading reaches them.
    for (const suffix of ['delta', 'echo', 'foxtrot']) {
      await remember({ entity: SPREAD_ENTITY, content: `satellite ground segment note ${suffix}` });
    }
    const db = getDatabase();
    const related = findEntityByName(SPREAD_ENTITY);
    const seeded = findEntityByName(ENTITY);
    assert.ok(related && seeded, 'both entities should exist');
    db.prepare('UPDATE observations SET created_at = ? WHERE entity_id = ?')
      .run('2020-01-01 00:00:00', related!.id);
    createRelationship(seeded!.id, related!.id, 'related_to');
  });

  async function spreadRecall(since: string | undefined, limit: number) {
    return (await recall({
      query: QUERY,
      limit,
      spread: true,
      format: 'full',
      ...(since === undefined ? {} : { since }),
    } as Parameters<typeof recall>[0])) as FullRecall & {
      memories: Array<{ observation_id: string; remembered_at: string }>;
    };
  }

  test('spreading reaches the related entity at all (else this suite proves nothing)', async () => {
    const result = await spreadRecall(undefined, 50);
    assert.ok(
      result.memories.some(m => m.remembered_at.startsWith('2020-01-01')),
      'the fixture must actually spread, or the filter assertions below are vacuous'
    );
  });

  test('out-of-window observations are not returned', async () => {
    const result = await spreadRecall('2026-08-25 00:00:00', 50);
    const stale = result.memories.filter(m => m.remembered_at < '2026-08-25');
    assert.deepEqual(stale, [], 'spread results must respect the bound like every other leg');
  });

  test('the T form and the space form agree under spread too', async () => {
    const t = await spreadRecall('2026-08-25T00:00:00', 50);
    const space = await spreadRecall('2026-08-25 00:00:00', 50);
    assert.deepEqual(idsOf(t), idsOf(space));
    assert.ok(t.count > 0, 'and neither is empty');
  });

  test('spread with a bad since errors rather than quietly spreading unfiltered', async () => {
    await assert.rejects(() => spreadRecall('not-a-date', 10), /Invalid "since" value/);
  });

  test('without a bound, spreading still reaches everything', async () => {
    const result = await spreadRecall(undefined, 50);
    assert.ok(result.count > SEEDED.length, 'no bound means no filtering');
  });
});


// ---------------------------------------------------------------------------
// Both SQL legs. recall() merges two independent queries; a bound normalized in
// only one of them would return half an answer and look like a ranking quirk.
// ---------------------------------------------------------------------------

describe('both search legs apply the same bound', () => {
  test('keyword leg (searchObservations)', () => {
    const t = searchObservations({ query: QUERY, limit: 50, since: normalizeSinceBound('2026-08-25T00:00:00') });
    const space = searchObservations({ query: QUERY, limit: 50, since: normalizeSinceBound('2026-08-25 00:00:00') });
    assert.equal(t.length, 2);
    assert.deepEqual(t.map(o => o.id).sort(), space.map(o => o.id).sort());
  });

  test('semantic leg (semanticSearchWithVector)', async () => {
    const vector = await generateEmbedding(QUERY);
    const t = semanticSearchWithVector(vector, { limit: 50, since: normalizeSinceBound('2026-08-25T00:00:00') });
    const space = semanticSearchWithVector(vector, { limit: 50, since: normalizeSinceBound('2026-08-25 00:00:00') });
    assert.equal(t.length, 2, 'semantic leg must filter, not drop everything');
    assert.deepEqual(t.map(r => r.observation_id).sort(), space.map(r => r.observation_id).sort());
  });
});

// ---------------------------------------------------------------------------
// The pre-normalized precondition, held structurally (D14). Until this landed,
// an un-normalized bound reaching either function returned zero rows with no
// error — and a test pinned that as expected behaviour, which meant the next
// caller to forward a raw caller-supplied date would have reintroduced D13's
// silent zero with the suite's blessing. These two functions run the
// lexicographic SQL; the bound's shape is now checked where it is used.
// ---------------------------------------------------------------------------

const UN_NORMALIZED = /un-normalized "since" bound/;

describe('both search legs reject an un-normalized bound instead of matching nothing', () => {

  test('keyword leg throws on a raw ISO T bound', () => {
    assert.throws(
      () => searchObservations({ query: QUERY, limit: 50, since: '2026-08-25T00:00:00' }),
      UN_NORMALIZED,
      'the T form sorts above every stored row — silently, which is the whole defect'
    );
  });

  test('semantic leg throws on a raw ISO T bound', async () => {
    const vector = await generateEmbedding(QUERY);
    assert.throws(
      () => semanticSearchWithVector(vector, { limit: 50, since: '2026-08-25T00:00:00' }),
      UN_NORMALIZED
    );
  });

  test('the throw names the function that received it, not just the value', async () => {
    // Both legs, because the label is a copy-pasted string literal: a third
    // search function that clones the assert line and keeps the wrong name
    // sends the next debugger to the wrong file, and nothing else would notice.
    const vector = await generateEmbedding(QUERY);
    assert.throws(
      () => searchObservations({ query: QUERY, limit: 50, since: 'not-a-date' }),
      /searchObservations/,
      'a precondition failure has to point at the call site to fix'
    );
    assert.throws(
      () => semanticSearchWithVector(vector, { limit: 50, since: 'not-a-date' }),
      /semanticSearchWithVector/
    );
  });

  test('an empty bound throws rather than silently dropping the filter', () => {
    // `if (options.since)` treats '' as "no bound" and returns everything — an
    // unset caller variable read as "everything is new". Same lie, opposite sign.
    assert.throws(
      () => searchObservations({ query: QUERY, limit: 50, since: '' }),
      UN_NORMALIZED
    );
  });

  test('a partial date throws — it is a truncation bug, not a prefix', () => {
    assert.throws(() => searchObservations({ query: QUERY, limit: 50, since: '2026-08' }), UN_NORMALIZED);
  });

  test('normalizeSinceBound output always satisfies the assertion', () => {
    // The two are a pair: if normalization could emit a shape the assertion
    // rejects, every recall with a bound would throw in production.
    for (const input of ['2026-08-25', '2026-08-25T00:00:00', '2026-08-25T13:36:55+03:00', '2026-08-25 10:36:55.9Z']) {
      const bound = normalizeSinceBound(input);
      assert.doesNotThrow(() => searchObservations({ query: QUERY, limit: 50, since: bound }), `rejected its own output for ${input}`);
    }
  });

  test('no bound at all is still no bound', async () => {
    const vector = await generateEmbedding(QUERY);
    assert.doesNotThrow(() => searchObservations({ query: QUERY, limit: 50 }));
    assert.doesNotThrow(() => semanticSearchWithVector(vector, { limit: 50 }));
  });

  test('a well-shaped bound that is not a real instant throws', () => {
    // The shape is the proxy; the instant is the precondition. `2026-02-30`
    // passes any reasonable regex and lexicographically excludes every late-Feb
    // row while admitting March — a silently WRONG window, not an empty one.
    // It is also what string surgery produces (JS months are zero-based), i.e.
    // what a caller who skipped the normalizer would most plausibly build.
    for (const bogus of ['2026-02-30 00:00:00', '2026-13-01 00:00:00', '2026-08-25 25:00:00', '0000-00-00 00:00:00']) {
      assert.throws(
        () => searchObservations({ query: QUERY, limit: 50, since: bogus }),
        UN_NORMALIZED,
        `${bogus} is well-shaped and meaningless — shape alone must not admit it`
      );
      assert.throws(() => normalizeSinceBound(bogus), /Invalid "since" value/, `and the normalizer rejects it too, so this is unreachable via recall()`);
    }
  });

  test('a non-string bound yields the diagnostic, not a TypeError', () => {
    // Types forbid it and zod rejects it at the MCP boundary, but a null lands
    // on `.length` one line into the failure path if the echo is not defensive.
    assert.throws(
      () => searchObservations({ query: QUERY, limit: 50, since: null as unknown as string }),
      UN_NORMALIZED
    );
  });

  test('the contract error is named, so callers can tell it from a search failure', () => {
    assert.throws(
      () => searchObservations({ query: QUERY, limit: 50, since: 'nope' }),
      (err: unknown) => (err as Error).name === SINCE_CONTRACT_ERROR,
      'recall.ts keys its rethrow off the name, not the message text'
    );
  });
});

// ---------------------------------------------------------------------------
// recall() degrades to an empty semantic leg when the embedder fails, and that
// catch would otherwise swallow the assert. The rethrow there keys off the
// error's NAME surviving the async boundary — which is what this pins. Being
// honest about the limit: recall()'s own rethrow cannot be exercised, because
// recall() normalizes before either leg sees the bound, so no un-normalized
// value can reach it. Untestable and unreachable are the same fact here, and it
// is the same fact as the assert itself: both exist for the next caller.
// ---------------------------------------------------------------------------

describe('a contract violation stays identifiable across the async leg', () => {
  test('semanticSearch rejects, and the rejection is still named', async () => {
    await assert.rejects(
      () => semanticSearch(QUERY, { limit: 50, since: '2026-08-25T00:00:00' }),
      (err: unknown) => {
        assert.match((err as Error).message, UN_NORMALIZED);
        assert.equal((err as Error).name, SINCE_CONTRACT_ERROR, 'recall.ts:90 keys its rethrow off this');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// parseStoredTimestamp — stored timestamps are UTC, `new Date()` reads local
// ---------------------------------------------------------------------------

describe('parseStoredTimestamp reads stored timestamps as UTC', () => {
  test('TZ override took effect (else the assertions below prove nothing)', () => {
    assert.notEqual(
      new Date().getTimezoneOffset(),
      0,
      'expected a non-UTC test TZ — process.env.TZ = Europe/Helsinki did not take effect'
    );
  });

  test('the stored form is read as UTC, not local wall-clock', () => {
    const stored = '2026-08-25 10:36:55';
    assert.equal(parseStoredTimestamp(stored), Date.parse('2026-08-25T10:36:55Z'));
    assert.notEqual(
      parseStoredTimestamp(stored),
      new Date(stored).getTime(),
      'a bare new Date() must not agree here, or this test is not discriminating'
    );
  });

  test('a zone-less T form is also UTC (ES2015+ would read it as local)', () => {
    assert.equal(parseStoredTimestamp('2026-08-25T10:36:55'), Date.parse('2026-08-25T10:36:55Z'));
  });

  test('a value that already carries a zone is respected, not double-marked', () => {
    assert.equal(parseStoredTimestamp('2026-08-25T10:36:55Z'), Date.parse('2026-08-25T10:36:55Z'));
    assert.equal(parseStoredTimestamp('2026-08-25T13:36:55+03:00'), Date.parse('2026-08-25T10:36:55Z'));
  });

  test('an unparseable value returns NaN rather than a plausible wrong instant', () => {
    assert.ok(Number.isNaN(parseStoredTimestamp('not-a-timestamp')));
  });
});

// ---------------------------------------------------------------------------
// MCP dispatch. Unit-testing the throw leaves the server.ts wiring assumed, and
// the wiring is the contract every client actually sees.
// ---------------------------------------------------------------------------

type ToolCallRequest = {
  jsonrpc: '2.0';
  id: number;
  method: 'tools/call';
  params: { name: string; arguments: unknown };
};
type ToolCallResult = { content: { type: string; text: string }[]; isError?: boolean };
type WrappedHandler = (request: ToolCallRequest, extra: unknown) => Promise<ToolCallResult>;

let callId = 0;
async function callRecall(args: Record<string, unknown>) {
  const server = createMcpServer();
  const handlers = (server as unknown as {
    server: { _requestHandlers: Map<string, WrappedHandler> };
  }).server._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('tools/call handler missing — install order regression');
  const result = await handler(
    { jsonrpc: '2.0', id: ++callId, method: 'tools/call', params: { name: 'recall', arguments: args } },
    { signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => ({}) }
  );
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

describe('recall over MCP dispatch', () => {
  test('a T-form since returns results, not a successful nothing', async () => {
    const result = await callRecall({ query: QUERY, limit: 50, since: '2026-08-25T00:00:00' });
    assert.equal(result.isError, false, result.text);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.success, true);
    assert.equal(parsed.count, 2);
  });

  test('a bad since surfaces as isError, never as success with count 0', async () => {
    const result = await callRecall({ query: QUERY, since: 'whenever' });
    assert.equal(result.isError, true, `expected an error, got: ${result.text}`);
    assert.match(result.text, /Invalid "since" value/);

    // The specific shape this fix exists to make impossible.
    assert.doesNotMatch(result.text, /"success": true/);
    assert.doesNotMatch(result.text, /"count": 0/);
  });
});
