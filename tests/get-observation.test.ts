/**
 * Tests for `get_observation` — the bounded read-by-id (D23).
 *
 * The gap: observation ids are handed out by `remember`, `recall` and `export`,
 * and both tools that ACCEPT an id destroy rows (`forget` deletes; `merge`
 * deletes every source and keeps only the caller's text). There was no
 * id-taking read, so a caller holding a destruction key could not see what it
 * addressed without `recall` — which is unbounded in practice, ranks badly at
 * `limit: 1`, and is itself a WRITE.
 *
 * Every bound below carries a positive control: an assertion that the fixture
 * WOULD have blown the bound under the alternative it replaces. A guard test
 * without one passes while proving nothing, which this repo has now had four
 * times (see CLAUDE.md and the D11 control tests).
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-get-observation-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-get-observation';
process.env.HIPPO_DB_PATH = DB_PATH;
delete process.env.HIPPO_APPEND_ONLY_PREFIXES; // exercise the shipped defaults

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { forget } = await import('../src/mcp/tools/forget.js');
const { getObservation } = await import('../src/mcp/tools/get-observation.js');
const { findEntityByName } = await import('../src/db/entities.js');
const { getObservationsByEntity, getObservationsByIds, createObservation } = await import('../src/db/observations.js');
const { exportMemories } = await import('../src/mcp/tools/export.js');
const { createMcpServer } = await import('../src/mcp/server.js');
const { onboard } = await import('../src/mcp/tools/onboard.js');

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

/** Serialize exactly as the tool handler in src/mcp/server.ts does. */
function wireSize(result: unknown): number {
  return JSON.stringify(result, null, 2).length;
}

const OBSERVATION_CHARS = 45_000;

/**
 * The same shape as the near-match fixture that motivated the cap: parts share
 * a header (which is what carries them over the near-match threshold, exactly
 * as real harvest entries do) and differ in the bulk after it.
 */
function ledgerPart(part: number): string {
  const header =
    'RESEARCH LEDGER — EO market formation, sequel run. Structure: sources, extraction notes, ' +
    'contradictions flagged for review, open threads, and the running confidence table. ' +
    'Each part continues the previous one; numbering is sequential and the format is fixed. ';
  return (header + `Part ${part} findings. `).padEnd(OBSERVATION_CHARS, `part-${part}-payload `);
}

/** `createObservation` hardcodes datetime('now'), so distinct days need SQL. */
function backdate(observationId: string, day: string): void {
  getDatabase()
    .prepare("UPDATE observations SET created_at = ? || ' 12:00:00' WHERE id = ?")
    .run(day, observationId);
}

function rowById(id: string) {
  const [row] = getObservationsByIds([id]);
  assert.ok(row, `fixture row ${id} must exist`);
  return row!;
}

// ---------------------------------------------------------------------------
// The bound, measured against the alternative it replaces
// ---------------------------------------------------------------------------

describe('get_observation is bounded where the prescribed recall re-read is not', () => {
  const entity = 'raw:research:fetch-bound';
  const ids: string[] = [];

  before(async () => {
    for (let part = 1; part <= 5; part++) {
      const written = await remember({ entity, content: ledgerPart(part) });
      backdate(written.observationId, `2026-09-0${part}`);
      ids.push(written.observationId);
    }
    // Same-UTC-day dedup would collapse these into one and the test would
    // measure a one-row store while claiming to measure five.
    assert.equal(
      getObservationsByEntity(findEntityByName(entity)!.id).length,
      5,
      'all five parts must be stored separately'
    );
  });

  test('returns exactly the row named, at roughly the size of that row', () => {
    const target = ids[2]; // part 3 — deliberately not the top-ranked sibling
    const result = getObservation({ observation_id: target });

    assert.equal(result.success, true);
    assert.equal(result.observation!.observation_id, target);
    assert.equal(result.observation!.content, rowById(target).content);

    // Bound the PROPERTY, not the fixture. An earlier version asserted
    // `size < rowChars * 1.2`, which passed only because ledgerPart() pads with
    // characters JSON never escapes — it pinned the fixture's escape density
    // rather than the tool. Measured on 45,000-char inputs: 1.003x on real
    // prose, 1.014x on a log with a newline every ~70 chars, 1.20x on a
    // synthetic newline-every-5 string, and a 2.01x ceiling on quotes or
    // backslashes. (An earlier draft of this comment called the 1.20x stress
    // input "what a real harvest entry actually is", which is an order of
    // magnitude out — it was corrected in DECISIONS.md and the tool's own doc
    // and survived here, which is why D23 says to sweep the whole surface.)
    // The real claim is "the row it was asked for, plus a small fixed
    // envelope", and escaping belongs to the row.
    const size = wireSize(result);
    const escapedRowChars = JSON.stringify(rowById(target).content).length;
    const envelope = size - escapedRowChars;
    assert.ok(
      envelope > 0 && envelope < 2048,
      `response (${size}) must be the escaped row (${escapedRowChars}) plus a small envelope, got ${envelope}`
    );
  });

  test('the bound survives content that JSON escaping inflates', () => {
    // The escape-density case the assertion above used to be blind to. Same
    // tool, same claim, content that doubles under JSON.stringify.
    const entity = 'project:fetch-escape-dense';
    const dense = '"\n'.repeat(20_000); // every character escapes
    return (async () => {
      const written = await remember({ entity, content: dense });
      const result = getObservation({ observation_id: written.observationId });
      assert.equal(result.observation!.observation_id, written.observationId);
      assert.equal(result.observation!.content, dense, 'content must survive verbatim');

      const size = wireSize(result);
      const escapedRowChars = JSON.stringify(dense).length;
      // CONTROL: this fixture must actually exercise inflation, or it is just
      // another prose case wearing a different name.
      assert.ok(
        escapedRowChars > dense.length * 1.5,
        `CONTROL: fixture must inflate under escaping (${dense.length} -> ${escapedRowChars})`
      );
      const envelope = size - escapedRowChars;
      assert.ok(
        envelope > 0 && envelope < 2048,
        `envelope must stay small regardless of escape density, got ${envelope}`
      );
    })();
  });

  test('CONTROL: the recall re-read this replaces returns the whole entity, and misses at limit 1', async () => {
    // Without this control the bound above is vacuous — it would pass on a
    // fixture where recall also returned one row, proving nothing about the
    // problem get_observation exists to solve.
    const target = ids[2];
    const preview = `${rowById(target).content.slice(0, 200)}…`;

    const wide = await recall({ query: preview.slice(0, 200), limit: 10, spread: false, format: 'full' });
    const wideSize = wireSize(wide);
    assert.ok(
      wideSize > wireSize(getObservation({ observation_id: target })) * 3,
      `recall at the default limit (${wideSize}) must dwarf the single-row fetch`
    );

    // And narrowing recall to one row does not fix it: the preview is shared by
    // every sibling (that is the near-match mechanism), so ranking, not the
    // similarity floor, decides which row comes back.
    const narrow = await recall({ query: preview.slice(0, 200), limit: 1, spread: false, format: 'full' });
    const returned = (narrow as { memories: Array<{ observation_id: string }> }).memories[0];
    assert.notEqual(
      returned.observation_id,
      target,
      'CONTROL PREMISE: limit:1 must miss the target here — if it starts hitting it, ' +
        'this fixture no longer demonstrates the ranking problem and needs rebuilding'
    );
  });
});

// ---------------------------------------------------------------------------
// It is a read. This is the property that distinguishes it from `recall`.
// ---------------------------------------------------------------------------

describe('get_observation performs no write', () => {
  const entity = 'project:fetch-read-only';

  test('recall_count and last_recalled_at are untouched, where recall moves both', async () => {
    const written = await remember({ entity, content: 'Deploy target is the Hetzner box at /opt/hippocampus.' });
    const id = written.observationId;

    const before = rowById(id);
    assert.equal(before.recall_count, 0, 'fixture starts unrecalled');
    assert.equal(before.last_recalled_at, null);

    for (let i = 0; i < 3; i++) getObservation({ observation_id: id });

    const afterFetch = rowById(id);
    assert.equal(afterFetch.recall_count, 0, 'three fetches must not bump recall_count');
    assert.equal(afterFetch.last_recalled_at, null, 'three fetches must not set last_recalled_at');

    // CONTROL: the same row, reached the other way, DOES move — so the
    // assertions above are pinning a real difference and not a dead column.
    await recall({ query: 'Hetzner deploy target', limit: 10, spread: false, format: 'full' });
    const afterRecall = rowById(id);
    assert.ok(
      afterRecall.recall_count > 0,
      'CONTROL: recall must bump recall_count, or the no-write assertions prove nothing'
    );
    assert.ok(afterRecall.last_recalled_at !== null, 'CONTROL: recall must set last_recalled_at');
  });

  test('the response discloses the telemetry it declines to move', async () => {
    const written = await remember({ entity, content: 'Caddy runs as a host systemd service, not a container.' });
    await recall({ query: 'Caddy systemd host service', limit: 10, spread: false, format: 'full' });

    const result = getObservation({ observation_id: written.observationId });
    const row = rowById(written.observationId);
    // CONTROL: without this the assertions below compare 0 === 0 and prove
    // nothing about disclosure the moment the query stops matching.
    assert.ok(row.recall_count > 0, 'CONTROL: the recall above must have bumped the row');
    assert.equal(result.observation!.recall_count, row.recall_count);
    assert.equal(result.observation!.last_recalled_at, row.last_recalled_at);
    assert.match(result.message, /did not change recall_count/);
  });
});

// ---------------------------------------------------------------------------
// Failure shapes: loud, specific, never empty-but-successful
// ---------------------------------------------------------------------------

describe('get_observation fails loudly on an id it cannot resolve', () => {
  test('an unknown id is success:false, not an empty success', () => {
    const result = getObservation({ observation_id: '00000000-0000-4000-8000-000000000000' });
    assert.equal(result.success, false);
    assert.equal(result.observation, undefined);
    assert.match(result.message, /not found/i);
  });

  test('a deleted id reports not-found rather than returning stale content', async () => {
    const written = await remember({
      entity: 'project:fetch-deleted',
      content: 'Rate limiting returns 429 at request 61.',
    });
    assert.equal(getObservation({ observation_id: written.observationId }).success, true);

    forget({ observation_id: written.observationId });

    const after = getObservation({ observation_id: written.observationId });
    assert.equal(after.success, false, 'a forgotten row must not still be readable');
    assert.equal(after.observation, undefined);
  });
});

// ---------------------------------------------------------------------------
// Append-only disclosure — the D10/D11/D12 line, one tool over
// ---------------------------------------------------------------------------

describe('get_observation discloses append-only rows', () => {
  test('append_only is true with a do-not-consolidate message', async () => {
    const written = await remember({
      entity: 'ops:daily-log:hippocampus',
      content: '2026-09-09. Reviewed the read-by-id gap; measured the recall re-read at 272K chars.',
    });

    const result = getObservation({ observation_id: written.observationId });
    assert.equal(result.success, true);
    assert.equal(result.append_only, true);
    assert.match(result.message, /do NOT update, merge or otherwise consolidate/);
    // The content itself is NOT withheld. This tool is called with an id the
    // caller already holds, which is a different shape from `remember` offering
    // an unrequested handle beside a consolidation nudge — `near_matches`
    // previews content on every entity and withholds the ID on append-only
    // ones. Reading a log entry is exactly what this tool is for; the
    // do-not-consolidate notice is what keeps the read from reading as licence.
    assert.ok(result.observation!.content.includes('272K chars'), 'content is returned in full');
  });

  test('append_only is present and false on ordinary entities', async () => {
    // Absence must never be the all-clear — the same rule as `replaced: false`
    // (D10) and `degraded: false` (D16). A field that appears only in the
    // dangerous case is indistinguishable from an older server without it.
    const written = await remember({
      entity: 'project:fetch-ordinary',
      content: 'SQLCipher encrypts the whole database, embeddings included.',
    });
    const result = getObservation({ observation_id: written.observationId });
    // Identity first: without it this passes while the tool returns some other
    // row entirely, which a round-2 mutation demonstrated.
    assert.equal(result.observation!.observation_id, written.observationId);
    assert.equal(result.append_only, false);
    assert.ok(Object.hasOwn(result, 'append_only'), 'append_only must be present, not merely falsy');
  });
});

// ---------------------------------------------------------------------------
// The workflow it actually completes — and the boundary it does not move
// ---------------------------------------------------------------------------

describe('the ids get_observation advertises are working handles', () => {
  // An earlier version of this suite claimed to exercise `remember`'s
  // `near_matches[].observation_id` at a time when that field did not exist
  // here — D20 was still unlanded, `near_matches` was `{content, similarity}`,
  // and the test read `match.observation_id ?? first.observationId`, so it
  // silently fell through to an id obtained the other way and passed while
  // proving nothing. The shipped tool description advertised the field as fact
  // on the strength of that green test. D20 has since landed and the field is
  // real, which is exactly why these tests pin each source independently rather
  // than through one fallback chain: the id-source invariant in the wire suite
  // below is what ties the description to what `remember` actually emits.
  const entity = 'project:fetch-id-sources';

  test('an id from remember resolves', async () => {
    const written = await remember({ entity, content: 'The session sweep runs on a 30-minute idle timer.' });
    const fetched = getObservation({ observation_id: written.observationId });
    assert.equal(fetched.success, true);
    assert.equal(fetched.observation!.content, 'The session sweep runs on a 30-minute idle timer.');
  });

  test('an id from recall format:full resolves', async () => {
    await remember({ entity, content: 'Stale MCP sessions must answer 404, never 400.' });
    const found = await recall({ query: 'stale MCP session status code', limit: 5, spread: false, format: 'full' });
    const memories = (found as { memories: Array<{ observation_id: string; content: string }> }).memories;
    assert.ok(memories.length > 0, 'PREMISE: recall must return something to take an id from');

    const fetched = getObservation({ observation_id: memories[0].observation_id });
    assert.equal(fetched.success, true, 'a recall id must be a working handle');
    assert.equal(
      fetched.observation!.content,
      memories[0].content,
      'the fetched row must be the row recall described'
    );
  });

  test('an id from export format:json resolves', async () => {
    const dump = exportMemories({ format: 'json', entity });
    const parsed = JSON.parse(dump.data) as {
      entities: Array<{ observations: Array<{ id: string; content: string }> }>;
    };
    const observations = parsed.entities.flatMap(e => e.observations);
    assert.ok(observations.length > 0, 'PREMISE: export must emit observations with ids');

    const fetched = getObservation({ observation_id: observations[0].id });
    assert.equal(fetched.success, true, 'an export id must be a working handle');
    assert.equal(fetched.observation!.content, observations[0].content);
  });
});

describe('the boundary get_observation does NOT move', () => {
  test('merge still caps combined content at 50,000 chars', async () => {
    // D23 claims the honest consolidation boundary is "consolidate only when
    // the combined text fits under 50,000". An earlier version of this test
    // hardcoded `const MERGE_CONTENT_CAP = 50_000` and asserted two rows
    // exceeded it — `merge` was never called and the cap never read, so
    // widening `.max(50000)` to `.max(500000)` left the test green while the
    // decision's load-bearing claim went false. Read the cap off the wire
    // contract instead, which is the thing the claim is actually about.
    const server = createMcpServer('full');
    const handlers = (server.server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<{ tools: Array<{ name: string; inputSchema?: { properties?: Record<string, { maxLength?: number }> } }> }>>;
    })._requestHandlers;
    const listed = await handlers.get('tools/list')!(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      {}
    );
    const mergeTool = listed.tools.find(t => t.name === 'merge');
    assert.ok(mergeTool, 'merge must be advertised');
    assert.equal(
      mergeTool!.inputSchema?.properties?.content?.maxLength,
      50_000,
      'D23 cites 50,000 as the merge cap — if this changed, that decision needs revisiting'
    );

    // And the two-row reality the cap bites on: both readable, not combinable.
    const entity = 'raw:research:fetch-boundary';
    const a = await remember({ entity, content: ledgerPart(1) });
    backdate(a.observationId, '2026-08-10');
    const b = await remember({ entity, content: ledgerPart(2) });
    backdate(b.observationId, '2026-08-11');

    const readA = getObservation({ observation_id: a.observationId });
    const readB = getObservation({ observation_id: b.observationId });
    assert.equal(readA.success, true, 'both rows are readable — that is what the tool buys');
    assert.equal(readB.success, true);
    // Two DISTINCT rows. Without this the combined-length control below is
    // satisfied by the same 45,000-char row counted twice, which is what a
    // round-2 mutation that ignored the requested id actually produced.
    assert.equal(readA.observation!.observation_id, a.observationId);
    assert.equal(readB.observation!.observation_id, b.observationId);
    assert.notEqual(readA.observation!.content, readB.observation!.content);

    const combined = readA.observation!.content.length + readB.observation!.content.length;
    assert.ok(
      combined > 50_000,
      `CONTROL: the two rows (${combined}) must exceed the cap, or this boundary is not being tested`
    );
  });
});

// ---------------------------------------------------------------------------
// The wire path, and the guard for what the shipped description CLAIMS
// ---------------------------------------------------------------------------

describe('get_observation over the real MCP wire path', () => {
  // Every test above calls the function directly, which skips registration,
  // schema validation, param normalization and serialization. Round 1's blocker
  // lived in exactly that gap: the registered DESCRIPTION advertised a field
  // that does not exist, and nothing in the suite could fail.
  type Handler = (req: unknown, extra: unknown) => Promise<Record<string, never>>;
  let handlers: Map<string, Handler>;
  let callId = 0;

  before(() => {
    const server = createMcpServer('full');
    handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  });

  // The SDK wraps user handlers with schema parsing, so the full JSON-RPC shape
  // is required here — see the CLAUDE.md gotcha and tests/param-normalization.
  async function callTool(args: unknown) {
    const handler = handlers.get('tools/call');
    assert.ok(handler, 'tools/call handler missing — SDK internals changed');
    return (await handler!(
      { jsonrpc: '2.0', id: ++callId, method: 'tools/call', params: { name: 'get_observation', arguments: args } },
      {}
    )) as unknown as { isError?: boolean; content: Array<{ text: string }> };
  }

  async function listed() {
    const handler = handlers.get('tools/list');
    const result = (await handler!(
      { jsonrpc: '2.0', id: ++callId, method: 'tools/list', params: {} },
      {}
    )) as unknown as { tools: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }> };
    return result.tools;
  }

  test('is advertised with a real schema, not the EMPTY_OBJECT fallback', async () => {
    const tool = (await listed()).find(t => t.name === 'get_observation');
    assert.ok(tool, 'get_observation must be advertised');
    assert.deepEqual(Object.keys(tool!.inputSchema?.properties ?? {}), ['observation_id']);
    assert.deepEqual(tool!.inputSchema?.required, ['observation_id']);
  });

  test('the description does not advertise a near_matches id unless remember emits one', async () => {
    // The round-1 blocker as an invariant rather than a snapshot. It holds on
    // this branch (no claim, no field) AND on the branch that adds the field
    // (claim, field) — and fails only on the inconsistent state that shipped,
    // where the description promised a handle the caller could not obtain.
    // Whoever lands the near-match preview cap must update the description in
    // the same change, which is precisely what did not happen here.
    const entity = 'project:wire-description-invariant';
    const shared = 'Shared opening that carries these two notes over the near-match threshold. ';
    const first = await remember({ entity, content: `${shared}The first note concerns Caddy on the host.` });
    backdate(first.observationId, '2026-07-01');
    const second = await remember({ entity, content: `${shared}The second note concerns the Docker volume.` });

    const matches = second.near_matches ?? [];
    assert.ok(matches.length > 0, 'PREMISE: the fixture must produce a near match to inspect');
    const emitsId = Object.hasOwn(matches[0] as object, 'observation_id');

    const tool = (await listed()).find(t => t.name === 'get_observation');
    const claimsId = /near_matches/.test(tool!.description ?? '');

    assert.equal(
      claimsId,
      emitsId,
      claimsId
        ? 'the description advertises near_matches as an id source, but remember emits no observation_id there'
        : 'remember now emits near_matches[].observation_id — say so in the tool description'
    );
  });

  test('a canonical call returns the row in-band', async () => {
    const written = await remember({ entity: 'project:wire-call', content: 'Healthcheck takes ~15s after restart.' });
    const res = await callTool({ observation_id: written.observationId });
    assert.notEqual(res.isError, true, 'a successful read must not be flagged isError');
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.success, true);
    assert.equal(body.observation.observation_id, written.observationId);
    assert.equal(body.observation.content, 'Healthcheck takes ~15s after restart.');
  });

  test('observationId — the exact field name remember returns — normalizes', async () => {
    const written = await remember({ entity: 'project:wire-call', content: 'The sweep caps sessions with an LRU.' });
    const res = await callTool({ observationId: written.observationId });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.success, true, 'a caller copying the field name across must not get a validation error');
    assert.equal(body.observation.observation_id, written.observationId);
  });

  test('an unknown id is an in-band success:false, not a transport error', async () => {
    // D17's lesson runs the other way here: not-found is the tool working, so
    // flagging isError would make a legitimate answer look like a malfunction.
    // Matches forget's convention.
    const res = await callTool({ observation_id: '00000000-0000-4000-8000-000000000000' });
    assert.notEqual(res.isError, true);
    assert.equal(JSON.parse(res.content[0].text).success, false);
  });

  test('a missing id is rejected loudly by schema validation', async () => {
    const res = await callTool({}).catch((err: unknown) => ({ isError: true, content: [{ text: String(err) }] }));
    assert.equal(res.isError, true, 'the required param must be enforced, not defaulted');
  });
});

describe('the preview notice never names a fetch the caller cannot perform', () => {
  test('wherever remember points at get_observation, every reported match carries an id', async () => {
    // remember's PREVIEW_NOTICE used to say the full text was "retrievable with
    // recall", which needs no id; it now names get_observation, which needs one.
    // D20 withholds observation_id on append-only entities, so that edit is only
    // safe if the notice cannot fire there. It cannot — the notice rides the
    // dedup-skip and replace paths, both gated on `dedupEligible = !appendOnly
    // && sameDay` — but that is a reachability argument, and this repo's rule is
    // that a reachability argument gets tested rather than reasoned.
    const entity = 'project:notice-invariant';
    const skeleton = 'Deploy runbook for the box. Push, pull, rebuild, verify the health endpoint. ';

    // Backdated: blocked by the same-UTC-day guard, so it is REPORTED, not deduped.
    const older = await remember({ entity, content: `${skeleton}Variant A, about Caddy on the host.` });
    backdate(older.observationId, '2026-08-01');
    // Same day and near-identical: takes the dedup branch, which attaches the notice.
    await remember({ entity, content: `${skeleton}Variant B, about the session sweep.` });
    const deduped = await remember({ entity, content: `${skeleton}Variant B, about the session sweep.` });

    // CONTROL: the notice must actually fire, or the assertion below is vacuous.
    assert.match(
      deduped.message,
      /get_observation/,
      'CONTROL: this fixture must reach a path that names get_observation'
    );
    const matches = deduped.near_matches ?? [];
    assert.ok(matches.length > 0, 'CONTROL: the notice only means something with matches attached');

    for (const match of matches) {
      assert.equal(
        typeof (match as { observation_id?: string }).observation_id,
        'string',
        'the notice names a fetch by id — every match it describes must carry one'
      );
      const fetched = getObservation({ observation_id: (match as { observation_id: string }).observation_id });
      assert.equal(fetched.success, true, 'and that id must actually resolve');
    }
  });

  test('an append-only overlap is never told to fetch by id', async () => {
    // The other half: append-only matches carry no id, so their message must not
    // prescribe one. D20 branches the message for exactly this reason.
    const entity = 'ops:daily-log:notice-invariant';
    const skeleton = '2026-09-09. Log skeleton shared across dated entries, long enough to clear the threshold. ';
    const first = await remember({ entity, content: `${skeleton}First entry, the deploy path.` });
    backdate(first.observationId, '2026-08-01');
    const second = await remember({ entity, content: `${skeleton}Second entry, the session sweep.` });

    const matches = second.near_matches ?? [];
    assert.ok(matches.length > 0, 'CONTROL: the fixture must produce an append-only overlap');
    assert.ok(!Object.hasOwn(matches[0] as object, 'observation_id'), 'append-only matches carry no id');
    assert.doesNotMatch(
      second.message,
      /get_observation/,
      'a message with no id in the payload must not prescribe a fetch by id'
    );
    assert.match(second.message, /Do NOT consolidate/, 'it says the useful thing instead');
  });
});

describe('the deduplicated path hands back a row the caller has never seen', () => {
  test('observationId names a pre-existing observation, and onboard says so', async () => {
    // The hazard a merge-gate review found. On `deduplicated: true`, remember
    // returns the PRE-EXISTING row's id (remember.ts, the skip branch) — the
    // caller's own text was never stored. onboard step 2 templates
    // `merge([<this response's observationId>, <near match id>], content)`, so a
    // model composing `content` from what it submitted deletes whatever was
    // unique to the stored row, with success: true at every step. That is the
    // D10 shape: a report authorising a destruction whose target is unseen.
    //
    // Thresholds are not guessable, so this pair was probed with
    // generateEmbedding + cosineSimilarity first: it measures 0.864, over the
    // 0.85 dedup line, with the stored row longer.
    const entity = 'project:dedup-handle-guard';
    const submitted = 'Runbook: push to origin main, then pull and rebuild on the box, then verify the health endpoint.';
    const stored = `${submitted} Volume preserved.`;

    const first = await remember({ entity, content: stored });
    const second = await remember({ entity, content: submitted });

    // CONTROL: the fixture must actually reach the dedup-skip branch. If the
    // embedding model drifts below 0.85 this becomes an ordinary write and every
    // assertion below would pass vacuously against a different code path.
    assert.equal(second.deduplicated, true, 'CONTROL: fixture must take the dedup-skip branch');

    assert.equal(
      second.observationId,
      first.observationId,
      'the returned id is the pre-existing row, not the text just submitted'
    );

    // The point of the tool: that id is now readable, so "unseen" is a choice.
    const fetched = getObservation({ observation_id: second.observationId });
    assert.equal(fetched.success, true);
    assert.ok(
      fetched.observation!.content.includes('Volume preserved'),
      'and it holds text the caller never sent — which is exactly what merge would delete'
    );
    assert.ok(!submitted.includes('Volume preserved'), 'CONTROL: that text really was not submitted');

    // The prompt must warn about it, or the tool being able to read the row
    // does not help a model that never learns it needs to. Step 4 lives in the
    // ONGOING prompt, which onboard serves at BOOTSTRAP_THRESHOLD observations
    // and above — so seed past it rather than asserting against the bootstrap
    // text, where the consolidation sequence does not exist at all.
    const filler = findEntityByName(entity)!;
    for (let i = 0; i < 60; i++) {
      createObservation(filler.id, `Filler observation ${i}: distinct content for the onboard mode threshold.`);
    }
    const onboarded = onboard({}) as { instructions: string; observation_count: number };
    const prompt = onboarded.instructions;
    // CONTROL: prove we are reading the ongoing prompt, not the bootstrap one —
    // step 4 does not exist in the bootstrap text, so without this the two
    // assertions below could fail for the wrong reason (or a reworded bootstrap
    // could one day pass them). NB the field is `instructions`; `.prompt` is
    // undefined and typechecks clean, because a dynamic import lands untyped.
    assert.ok(onboarded.observation_count >= 50, 'CONTROL: must be past BOOTSTRAP_THRESHOLD');
    assert.match(prompt, /established Hippocampus memory store/, 'CONTROL: must be the ongoing prompt');
    assert.match(prompt, /deduplicated: true/, 'onboard must name the path');
    assert.match(
      prompt,
      /re-read EVERY id you will pass to `merge`/,
      'onboard must tell the model to read every merge source, not only the near match'
    );
  });
});
