/**
 * Regression tests for the two silent-success paths in `scripts/sync-agents.ts`
 * (D17), the repo's own consumer of `recall`.
 *
 * Both are the same shape as D16 one layer out — a success signal that is not
 * measuring success:
 *
 * 1. An MCP tool failure is IN-BAND: HTTP 200, a normal content array, and
 *    `isError: true` beside it. `call()` never looked at that flag, so the
 *    error TEXT fell through to `JSON.parse`, failed to parse, and was returned
 *    as a plain string. `cmdPush` wraps these calls in try/catch and counts
 *    `ok++` on no-throw — so a `remember` the server REJECTED printed a tick and
 *    the run exited 0 having written nothing.
 * 2. `recall` reports a failed semantic leg as `degraded: true` (D16). This
 *    script's agent index IS its work list, so a degraded index is a silently
 *    shorter list of agents, and every count printed afterwards is measured
 *    against it.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { HippoClient, describeDegradation } = await import('../scripts/sync-agents.ts');

// A tool result as the MCP layer actually shapes it: the JSON-RPC envelope the
// script's `fetch` unwraps, with `result.content[0].text` holding the tool's
// own return value as a string.
function toolResponse(payload: unknown, isError = false) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
      ...(isError ? { isError: true } : {}),
    },
  };
}

const realFetch = globalThis.fetch;
let nextResponse: unknown = null;

before(() => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json', 'mcp-session-id': 'test-session' }),
    json: async () => nextResponse,
    text: async () => JSON.stringify(nextResponse),
  })) as unknown as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

function client() {
  const c = new HippoClient('http://test.invalid/mcp', 'test-token');
  (c as unknown as { sessionId: string }).sessionId = 'test-session';
  return c;
}

describe('call() treats an in-band tool error as a failure', () => {
  test('an isError response rejects instead of returning the error text', async () => {
    nextResponse = toolResponse('Error: Semantic search failed and the keyword fallback matched nothing.', true);
    await assert.rejects(
      () => client().call('recall', { query: 'x' }),
      (err: Error) => {
        assert.match(err.message, /tool recall failed/);
        // The cause has to survive: before the fix the only trace was a
        // downstream `undefined.matchAll` with the real reason discarded.
        assert.match(err.message, /Semantic search failed/);
        return true;
      }
    );
  });

  test('a rejected write cannot be counted as a successful push', async () => {
    // The consequential half. `cmdPush` counts `ok++` whenever `call` does not
    // throw, so this rejection IS the push failure counter.
    nextResponse = toolResponse('Error: entity name too long', true);
    await assert.rejects(() => client().call('remember', { entity: 'agent:x', content: 'y' }));
  });

  test('a healthy response is still parsed, not broken by the new check', async () => {
    // The negative control: the fix must not turn success into failure.
    nextResponse = toolResponse({ success: true, count: 2, text: '#I 2 results, 2 entities' });
    const result = await client().call<{ success: boolean; count: number }>('recall', { query: 'x' });
    assert.equal(result.success, true);
    assert.equal(result.count, 2);
  });

  test('a non-JSON success body still falls through to plain text', async () => {
    // Pre-existing behaviour, pinned so the isError branch is not mistaken for
    // a general "unparseable means error" rule.
    nextResponse = toolResponse('plain text result');
    assert.equal(await client().call('onboard', {}), 'plain text result');
  });
});

describe('describeDegradation reads D16 flag', () => {
  test('degraded: true with a reason is reported with the reason', () => {
    const msg = describeDegradation({
      success: true, count: 1, text: '#I 1', degraded: true, degraded_reason: 'Error: model load failed',
    });
    assert.ok(msg);
    assert.match(msg, /model load failed/);
  });

  test('degraded: true without a reason still reports', () => {
    assert.ok(describeDegradation({ success: true, count: 1, text: '#I 1', degraded: true }));
  });

  test('degraded: false is not a warning', () => {
    assert.equal(describeDegradation({ success: true, count: 1, text: '#I 1', degraded: false }), null);
  });

  test('an absent flag is treated as healthy, not as degraded', () => {
    // Deliberate: an older server does not send the field at all, and this
    // script has to keep working against a server it did not deploy. The
    // asymmetry with the server's own "absence is not the all-clear" rule is
    // intentional — there the field is guaranteed present, here it is not.
    assert.equal(describeDegradation({ success: true, count: 1, text: '#I 1' }), null);
  });
});
