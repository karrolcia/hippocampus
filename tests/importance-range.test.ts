import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-importance-range-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-importance-range';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { findOrCreateEntity } = await import('../src/db/entities.js');
const {
  createObservation,
  IMPORTANCE_MAX,
  IMPORTANCE_MIN,
  IMPORTANCE_NEUTRAL,
  getObservationsByEntity,
} = await import('../src/db/observations.js');
const { onboard } = await import('../src/mcp/tools/onboard.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { createMcpServer } = await import('../src/mcp/server.js');
const { generateEmbedding } = await import('../src/embeddings/embedder.js');
const { cosineSimilarity } = await import('../src/embeddings/similarity.js');

// ---------------------------------------------------------------------------
// Harness: drive the registered server the way a client does
// ---------------------------------------------------------------------------

type ToolCallRequest = {
  jsonrpc: '2.0';
  id: number;
  method: 'tools/call';
  params: { name: string; arguments: unknown };
};
type ToolsListRequest = { jsonrpc: '2.0'; id: number; method: 'tools/list'; params: Record<string, never> };
type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

const EXTRA = {
  signal: new AbortController().signal,
  sendNotification: async () => {},
  sendRequest: async () => ({}),
};

let callId = 0;

function getHandler<Req>(server: ReturnType<typeof createMcpServer>, method: string) {
  const handlers = (server as unknown as {
    server: { _requestHandlers: Map<string, (req: Req, extra: unknown) => Promise<unknown>> };
  }).server._requestHandlers;
  const handler = handlers.get(method);
  if (!handler) throw new Error(`${method} handler missing — SDK internals changed`);
  return handler;
}

async function callTool(
  server: ReturnType<typeof createMcpServer>,
  name: string,
  args: Record<string, unknown>
) {
  const handler = getHandler<ToolCallRequest>(server, 'tools/call');
  const result = (await handler(
    { jsonrpc: '2.0', id: ++callId, method: 'tools/call', params: { name, arguments: args } },
    EXTRA
  )) as ToolResult;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

/**
 * The bounds a client's model actually reads. Deliberately taken off
 * `tools/list` rather than off the zod object behind it: the JSON Schema is the
 * wire contract, and the `ZodEffects`/`EMPTY_OBJECT_JSON_SCHEMA` regression in
 * CLAUDE.md is a case where the two disagreed silently.
 */
async function advertisedImportanceBounds(): Promise<{ minimum: number; maximum: number }> {
  const server = createMcpServer('full');
  const handler = getHandler<ToolsListRequest>(server, 'tools/list');
  const { tools } = (await handler(
    { jsonrpc: '2.0', id: ++callId, method: 'tools/list', params: {} },
    EXTRA
  )) as { tools: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] };

  const remember = tools.find(t => t.name === 'remember');
  assert.ok(remember, 'tools/list advertises no `remember` tool');
  const importance = remember.inputSchema?.properties?.importance as
    | { minimum?: unknown; maximum?: unknown }
    | undefined;
  assert.ok(importance, '`remember` advertises no `importance` param');
  assert.equal(typeof importance.minimum, 'number', 'importance advertises no numeric minimum');
  assert.equal(typeof importance.maximum, 'number', 'importance advertises no numeric maximum');
  return { minimum: importance.minimum as number, maximum: importance.maximum as number };
}

// ---------------------------------------------------------------------------
// The drift guard
// ---------------------------------------------------------------------------

/**
 * EVERY number stated on a line that mentions `importance`.
 *
 * Deliberately not a set of shape-aware patterns. The first version of this
 * matched only range prose (`0.0–2.0`) and argument literals (`importance: 2.0`),
 * and appending "Use 3.0 for absolutes" to the guidance line — reinstating the
 * exact bug D21 fixed — passed it, because the surviving range still satisfied
 * every assertion. A guard on prose cannot enumerate the shapes prose will take,
 * so it reads every numeral instead and lets the bounds decide.
 *
 * The cost is the convention this enforces: a number on an importance line MUST
 * be a valid importance value. A count, ratio or date there fails the guard.
 * That is the safe direction — it fails loudly at edit time, in a repo whose
 * recurring injury is the opposite (a check that quietly passes while measuring
 * nothing), and the fix is one line break.
 *
 * A leading minus is part of the number, so `importance: -1` is caught rather
 * than read as `1`. The lookbehind keeps that from misreading the hyphen in a
 * plain-ASCII range: in `0.0-2.0` the `-` follows a digit, so the match starts
 * at `2` and the range is two positive values, not `0.0` and `-2.0`.
 *
 * KNOWN BOUNDARY: the unit is the line. Guidance continued onto a following
 * line that does not itself say "importance" is not seen. Widening to a
 * paragraph would drag in neighbouring bullets, which is the false-failure
 * direction on a guard that already enforces a formatting convention — so the
 * line stays the unit, and the guidance stays on one line.
 */
function extractImportanceNumbers(prompt: string): number[] {
  const found: number[] = [];
  for (const line of prompt.split('\n')) {
    if (!/importance/i.test(line)) continue;
    for (const m of line.matchAll(/(?<![\d.])-?\d+(?:\.\d+)?/g)) found.push(Number(m[0]));
  }
  return found;
}

function outOfBounds(values: number[], minimum: number, maximum: number): number[] {
  return values.filter(v => v < minimum || v > maximum);
}

/**
 * The exact text that shipped before D21: guidance telling the AI to pass
 * 1.5–2.0 against a schema that capped at 1. The positive control for the
 * guard below — if this fixture ever stops producing a violation, the guard has
 * stopped guarding.
 */
const PRE_D21_GUIDANCE =
  '   - `importance`: Pass 1.5–2.0 for identity facts, core principles, and load-bearing decisions. Default 1.0.';

// ---------------------------------------------------------------------------

/** Prompts captured from the real tool, both modes. */
let bootstrapPrompt = '';
let ongoingPrompt = '';

before(async () => {
  initDatabase();

  // Below the bootstrap threshold — an empty store returns the bootstrap prompt.
  bootstrapPrompt = onboard({}).instructions;

  // Cross the 50-observation threshold to reach ongoing mode. Seeded through
  // the DB layer, not `remember`: `onboard` only counts rows, so embedding 50
  // fixtures would buy nothing but runtime. No embeddings also keeps them out
  // of the semantic results the ranking tests below assert on.
  const filler = findOrCreateEntity('seed:bulk-filler', 'test');
  for (let i = 0; i < 60; i++) {
    createObservation(filler.id, `Filler row ${i} — unrelated ballast to cross the onboard threshold.`);
  }
  ongoingPrompt = onboard({}).instructions;

  assert.notEqual(
    bootstrapPrompt,
    ongoingPrompt,
    'both captures returned the same prompt — the mode switch did not happen, so one mode is untested'
  );
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

describe('onboard prompt vs registered schema — importance drift guard', () => {
  // `onboard` returns a prompt an AI follows literally, and `remember`'s zod
  // schema decides whether the resulting call is accepted. Nothing links the
  // two: before D21 the prompt said "pass 1.5–2.0" against a `.max(1)` schema,
  // so an AI doing exactly what it was told had every identity-fact write
  // rejected — in-band, as `isError: true` on an HTTP 200, which a client that
  // only catches exceptions counts as a success (the D17 shape).

  test('tools/list advertises the exported bounds', async () => {
    const { minimum, maximum } = await advertisedImportanceBounds();
    assert.equal(minimum, IMPORTANCE_MIN, 'advertised minimum drifted from IMPORTANCE_MIN');
    assert.equal(maximum, IMPORTANCE_MAX, 'advertised maximum drifted from IMPORTANCE_MAX');
  });

  test('every importance value in both prompts is inside the advertised bounds', async () => {
    const { minimum, maximum } = await advertisedImportanceBounds();

    for (const [mode, prompt] of [
      ['bootstrap', bootstrapPrompt],
      ['ongoing', ongoingPrompt],
    ] as const) {
      const values = extractImportanceNumbers(prompt);
      // Floor, so a prompt reworded past the patterns above cannot pass by
      // stating nothing. Four is the minimum a usable guidance line carries:
      // the hard range and the recommended boost range.
      assert.ok(
        values.length >= 4,
        `${mode} prompt: found only ${values.length} importance values — the guidance was ` +
          `reworded past this guard, which now proves nothing. Update the patterns.`
      );
      assert.deepEqual(
        outOfBounds(values, minimum, maximum),
        [],
        `${mode} prompt instructs an importance value the schema rejects`
      );
      // The neutral point is not in the JSON Schema (the param is optional with
      // no default), so pin the prompt's claim about it against the constant.
      assert.ok(
        prompt.includes(`neutral ${IMPORTANCE_NEUTRAL.toFixed(1)}`),
        `${mode} prompt no longer states the neutral point as ${IMPORTANCE_NEUTRAL.toFixed(1)}`
      );
    }
  });

  test('CONTROL: the same check fails against a max of 1 — today and pre-D21', () => {
    // Without this, the test above could be passing because it measures
    // nothing. Two controls: the prompts as they stand now, and the exact text
    // that shipped before this fix.
    for (const [mode, prompt] of [
      ['bootstrap', bootstrapPrompt],
      ['ongoing', ongoingPrompt],
      ['pre-D21 fixture', PRE_D21_GUIDANCE],
    ] as const) {
      const violations = outOfBounds(extractImportanceNumbers(prompt), 0, 1);
      assert.ok(
        violations.length > 0,
        `${mode}: the guard found nothing above a ceiling of 1, so it would not have caught the D21 bug`
      );
    }
  });

  test('CONTROL: prose with no importance guidance extracts nothing', () => {
    // Which is why the length floor above is load-bearing rather than decorative.
    assert.deepEqual(extractImportanceNumbers('1. Store\n   - `kind`: fact, decision\n'), []);
    // A line that DOES mention importance but states no number is the shape the
    // floor exists to reject — the extractor must return nothing for it too.
    assert.deepEqual(extractImportanceNumbers('   - `importance`: use your judgement.'), []);
    // A leading minus belongs to the number: `-1` must not read as `1` and slip
    // past `.min(0)`. And a plain-ASCII range must not read its hyphen as one.
    assert.deepEqual(extractImportanceNumbers('   - `importance`: -1'), [-1]);
    assert.deepEqual(extractImportanceNumbers('   - `importance`: range 0.0-2.0'), [0.0, 2.0]);
  });
});

describe('importance accepts the range it advertises', () => {
  // Named for what it measures: the advertised ceiling, whatever that is. It
  // deliberately does NOT hardcode 2.0 — a literal here would keep passing if the
  // ceiling were lowered, which is the drift the guard above exists to catch.
  test('the advertised maximum round-trips through the tool boundary', async () => {
    const server = createMcpServer('full');
    const res = await callTool(server, 'remember', {
      content: 'PhD atmospheric physics, TU Delft',
      entity: 'range:boundary-max',
      importance: IMPORTANCE_MAX,
    });
    assert.equal(res.isError, false, `remember rejected the advertised maximum: ${res.text}`);

    const entity = findOrCreateEntity('range:boundary-max');
    const stored = getObservationsByEntity(entity.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].importance, IMPORTANCE_MAX, 'stored importance is not what was passed');
  });

  test('the minimum is accepted and a mid-range boost stores exactly', async () => {
    const server = createMcpServer('full');
    for (const [entity, value] of [
      ['range:boundary-min', IMPORTANCE_MIN],
      ['range:mid-boost', 1.8],
    ] as const) {
      const res = await callTool(server, 'remember', {
        content: `Fixture for ${entity} carrying importance ${value}`,
        entity,
        importance: value,
      });
      assert.equal(res.isError, false, `remember rejected ${value}: ${res.text}`);
      const stored = getObservationsByEntity(findOrCreateEntity(entity).id);
      assert.equal(stored[0].importance, value);
    }
  });

  test('outside the range is still rejected, at both ends', async () => {
    const server = createMcpServer('full');
    for (const value of [IMPORTANCE_MAX + 0.1, IMPORTANCE_MIN - 0.1]) {
      const res = await callTool(server, 'remember', {
        content: `Out-of-range fixture carrying importance ${value}`,
        entity: 'range:rejected',
        importance: value,
      });
      assert.equal(res.isError, true, `remember accepted an out-of-range importance (${value})`);
      assert.match(res.text, /importance/, 'the rejection does not name the offending param');
    }
    // Nothing was written by either rejected call.
    const stored = getObservationsByEntity(findOrCreateEntity('range:rejected').id);
    assert.equal(stored.length, 0, 'a rejected write left an observation behind');
  });

  test('omitting importance stores the neutral value', async () => {
    await remember({ content: 'No importance passed for this fixture', entity: 'range:default' });
    const stored = getObservationsByEntity(findOrCreateEntity('range:default').id);
    assert.equal(stored[0].importance, IMPORTANCE_NEUTRAL);
  });
});

describe('a boost above neutral actually reorders recall', () => {
  // The point of raising the ceiling. Before D21 the default WAS the maximum,
  // so `importance` could only de-prioritise and no value could lift an
  // observation above a more-similar neighbour.
  const QUERY = 'what are the core identity facts about this person';
  const MORE_SIMILAR = 'Identity fact: core biographical detail about this person, load-bearing';
  const LESS_SIMILAR = 'Personal history and where this individual grew up';

  before(async () => {
    // Four observations across four entities. Different entities on purpose:
    // dedup-on-write is per-entity and same-day, so a near-duplicate pair on one
    // entity would silently collapse into one row and every ordering assertion
    // below would measure the wrong thing (CLAUDE.md, "Writing two similar
    // observations to the same non-append-only entity").
    await remember({ content: LESS_SIMILAR, entity: 'rank:boosted', importance: IMPORTANCE_MAX });
    await remember({ content: MORE_SIMILAR, entity: 'rank:neutral-peer' });
    await remember({ content: LESS_SIMILAR, entity: 'rank:control-less' });
    await remember({ content: MORE_SIMILAR, entity: 'rank:control-more' });
  });

  test('PRECONDITION: the fixture pair sits inside the window this test needs', async () => {
    // A boost can only overturn an ordering when the gap it has to close is
    // smaller than the multiplier. If the embedding model moves and the pair
    // drifts outside (1, IMPORTANCE_MAX), the ranking test below would start
    // passing or failing for reasons that have nothing to do with importance.
    const q = await generateEmbedding(QUERY);
    const simMore = cosineSimilarity(q, await generateEmbedding(MORE_SIMILAR));
    const simLess = cosineSimilarity(q, await generateEmbedding(LESS_SIMILAR));

    assert.ok(simLess > 0.15, `LESS_SIMILAR (${simLess}) is below recall's similarity threshold`);

    // `recallBoost` is the third factor in the score and would confound the
    // ordering if it differed across the four rows. It is 1 for all of them
    // today — nothing has recalled them yet — but nothing asserted that, so a
    // future test adding a `recall` earlier in this file could tilt the result
    // without failing anything.
    for (const entity of ['rank:boosted', 'rank:neutral-peer', 'rank:control-less', 'rank:control-more']) {
      const [obs] = getObservationsByEntity(findOrCreateEntity(entity).id);
      assert.equal(obs.recall_count, 0, `${entity} has been recalled already — recallBoost is no longer uniform`);
    }
    const ratio = simMore / simLess;
    assert.ok(
      ratio > 1 && ratio < IMPORTANCE_MAX,
      `fixture ratio ${ratio.toFixed(3)} is outside (1, ${IMPORTANCE_MAX}) — the boosted row is ` +
        `either already more similar or too far behind for a boost to matter. Re-pick the texts.`
    );
  });

  test('a boosted, less-similar observation outranks a neutral, more-similar one', async () => {
    const result = (await recall({ query: QUERY, format: 'full', limit: 50 })) as {
      memories: Array<{ entity: string; similarity?: number }>;
    };
    const index = (entity: string) => result.memories.findIndex(m => m.entity === entity);

    const boosted = index('rank:boosted');
    const peer = index('rank:neutral-peer');
    assert.ok(boosted >= 0 && peer >= 0, 'both observations should be returned');
    assert.ok(boosted < peer, 'the boosted observation did not outrank its more-similar peer');

    // The control, built into the same call: `similarity` is the raw cosine, so
    // this proves the boosted row won on importance and not on similarity.
    const simBoosted = result.memories[boosted].similarity ?? 0;
    const simPeer = result.memories[peer].similarity ?? 0;
    assert.ok(
      simBoosted < simPeer,
      `the boosted row is also the more similar one (${simBoosted} vs ${simPeer}) — this test ` +
        `would pass with importance ignored entirely`
    );

    // And the same two texts, both at neutral, rank by similarity as expected.
    const ctlMore = index('rank:control-more');
    const ctlLess = index('rank:control-less');
    assert.ok(ctlMore >= 0 && ctlLess >= 0, 'both control observations should be returned');
    assert.ok(
      ctlMore < ctlLess,
      'the neutral control pair did not rank by similarity — the fixture, not importance, is doing the work'
    );
  });
});
