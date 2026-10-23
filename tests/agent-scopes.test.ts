import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// D28: per-token scopes on HIPPO_AGENT_TOKEN. Every case is driven through the
// real /mcp route (bearerAuth → session → createMcpServer(scope)), so what is
// asserted is what a client on that token would actually see.

const DB_PATH = join(tmpdir(), `hippo-test-agent-scopes-${Date.now()}.db`);

const READ = 'r'.repeat(64);
const WRITE = 'w'.repeat(64);
const BARE = 'f'.repeat(64); // pre-D28 shape: no prefix → full
const UNKNOWN = 'u'.repeat(64); // listed under a label that is not a scope
const SHORT = 's'.repeat(20); // below the 32-char floor once the prefix is off

// Env must be set before importing config (eager load). OAuth issuer set, so
// bearerAuth takes the agent-token path rather than legacy HIPPO_TOKEN.
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-agent-scopes';
process.env.HIPPO_DB_PATH = DB_PATH;
process.env.HIPPO_OAUTH_ISSUER = 'https://test.local';
process.env.HIPPO_OAUTH_USER = 'test';
process.env.HIPPO_OAUTH_PASSWORD_HASH = 'unused';
// Every case opens its own session; the default 60/min /mcp limit would 429.
process.env.RATE_LIMIT_RECALL = '10000';
process.env.HIPPO_AGENT_TOKEN = [
  `read:${READ}`,
  ` write:${WRITE} `,
  BARE,
  `admin:${UNKNOWN}`,
  `read:${SHORT}`,
].join(',');

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { createToken, registerClient } = await import('../src/db/oauth.js');
const { app } = await import('../src/index.js');
const { parseAgentTokens, scopeAllows, TOOL_MIN_SCOPE } = await import('../src/auth/scopes.js');
const { createMcpServer, _internal } = await import('../src/mcp/server.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

before(() => {
  initDatabase();
});

after(() => {
  closeDatabase();
});

const READ_TOOLS = ['check_version', 'consolidate', 'context', 'export', 'get_observation', 'recall'];
const WRITE_TOOLS = [...READ_TOOLS, 'onboard', 'remember'].sort();
const ALL_TOOLS = [...WRITE_TOOLS, 'forget', 'merge', 'merge_entities', 'update'].sort();

function headers(token: string, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

let rpcId = 0;
async function rpc(token: string, sessionId: string | undefined, method: string, params?: unknown) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: headers(token, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

async function openSession(token: string): Promise<string> {
  const init = await rpc(token, undefined, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'scope-test', version: '0.0.0' },
  });
  assert.equal(init.status, 200, `initialize should succeed: ${JSON.stringify(init.body)}`);
  const sid = init.res.headers.get('mcp-session-id');
  assert.ok(sid, 'initialize must return a session id');
  await app.request('/mcp', {
    method: 'POST',
    headers: headers(token, sid),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sid;
}

async function listTools(token: string, sid: string): Promise<string[]> {
  const r = await rpc(token, sid, 'tools/list');
  assert.equal(r.status, 200);
  return (r.body.result.tools as { name: string }[]).map((t) => t.name).sort();
}

async function callTool(token: string, sid: string, name: string, args: Record<string, unknown>) {
  const r = await rpc(token, sid, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, `tools/call transport should succeed: ${JSON.stringify(r.body)}`);
  // In-band failure: check isError explicitly (the transport succeeding is not
  // the tool succeeding — repo CLAUDE.md, D17).
  const result = r.body.result as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

describe('parseAgentTokens', () => {
  test('bare entry is full; prefixes set the scope; whitespace is trimmed', () => {
    const p = parseAgentTokens(`${'a'.repeat(32)}, read:${'b'.repeat(32)} ,write:${'c'.repeat(32)},full:${'d'.repeat(32)}`);
    assert.deepEqual(
      p.entries.map((e) => e.scope),
      ['full', 'read', 'write', 'full']
    );
    assert.equal(p.entries[1].token, 'b'.repeat(32), 'the prefix is not part of the token');
    assert.deepEqual(p.unknownLabels, []);
  });

  test('unknown label: the entry is dropped and only the label is reported', () => {
    const p = parseAgentTokens(`admin:${'x'.repeat(40)}`);
    assert.equal(p.entries.length, 0);
    assert.deepEqual(p.unknownLabels, ['admin']);
    assert.ok(!JSON.stringify(p.unknownLabels).includes('x'.repeat(40)), 'token material must not be reported');
  });

  test('a label that is not word-shaped is never echoed (prefix at the wrong end)', () => {
    const p = parseAgentTokens(`${'a1'.repeat(32)}:read`);
    assert.equal(p.entries.length, 0);
    assert.deepEqual(p.unknownLabels, ['<unrecognized>']);
  });

  test('the 32-char floor applies to the token part, not the whole entry', () => {
    // `write:` + 27 chars is 33 chars overall; the token itself is too short.
    const p = parseAgentTokens(`write:${'z'.repeat(27)}`);
    assert.equal(p.entries.length, 0);
  });

  test('empty and blank input yields no entries', () => {
    assert.equal(parseAgentTokens(undefined).entries.length, 0);
    assert.equal(parseAgentTokens('').entries.length, 0);
    assert.equal(parseAgentTokens(' , ').entries.length, 0);
  });
});

describe('scope table', () => {
  test('TOOL_MIN_SCOPE covers exactly the tools a full server registers (both directions)', async () => {
    const sid = await openSession(BARE);
    assert.deepEqual(await listTools(BARE, sid), Object.keys(TOOL_MIN_SCOPE).sort());
  });

  test('a registered tool with no scope entry fails closed', () => {
    const server = new McpServer({ name: 't', version: '0' });
    server.tool('brand_new_tool', 'not in the scope table', {}, async () => ({ content: [] }));
    assert.throws(() => _internal.applyScope(server, 'full'), /brand_new_tool.*no minimum scope/);
  });

  test('unknown tool names are never allowed, at any scope', () => {
    assert.equal(scopeAllows('full', 'not_a_tool'), false);
    assert.equal(scopeAllows('full', 'constructor'), false);
  });
});

describe('authentication', () => {
  test('an entry under an unknown scope label never authenticates', async () => {
    const r = await rpc(UNKNOWN, undefined, 'tools/list');
    assert.equal(r.status, 401);
  });

  test('a prefixed token below the length floor never authenticates', async () => {
    const r = await rpc(SHORT, undefined, 'tools/list');
    assert.equal(r.status, 401);
  });

  test('the prefix is not part of the credential', async () => {
    const r = await rpc(`read:${READ}`, undefined, 'tools/list');
    assert.equal(r.status, 401);
  });
});

describe('read scope', () => {
  test('tools/list shows only the read tools — no forget, no remember', async () => {
    const sid = await openSession(READ);
    assert.deepEqual(await listTools(READ, sid), READ_TOOLS);
  });

  test('forget is refused with an error naming the tool and both scopes', async () => {
    const sid = await openSession(READ);
    const r = await callTool(READ, sid, 'forget', { entity: 'scope-test:target' });
    assert.equal(r.isError, true);
    assert.match(r.text, /"forget" needs the "full" scope; this token is scoped "read"/);
    assert.ok(!r.text.includes(READ), 'refusal must not echo the token');
  });

  test('remember is refused (write needs the write scope)', async () => {
    const sid = await openSession(READ);
    const r = await callTool(READ, sid, 'remember', { entity: 'scope-test:read', content: 'should not land' });
    assert.equal(r.isError, true);
    assert.match(r.text, /needs the "write" scope/);
    // ...and nothing landed.
    const ctx = await callTool(BARE, await openSession(BARE), 'context', { topic: 'scope-test:read' });
    assert.ok(!ctx.text.includes('should not land'));
  });

  test('scope refusal runs before strict-arg validation', async () => {
    // forget is a STRICT_TOOLS member: an unknown arg would otherwise produce
    // an error listing its accepted arguments.
    const sid = await openSession(READ);
    const r = await callTool(READ, sid, 'forget', { entity: 'x', bogus: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /needs the "full" scope/);
  });

  test('recall works (the positive control for this scope)', async () => {
    const sid = await openSession(READ);
    const r = await callTool(READ, sid, 'recall', { query: 'anything', limit: 1 });
    assert.equal(r.isError, false, r.text);
  });

  test('resources stay readable', async () => {
    const sid = await openSession(READ);
    const r = await rpc(READ, sid, 'resources/read', { uri: 'hippocampus://context' });
    assert.equal(r.status, 200);
    assert.ok(r.body.result?.contents?.length > 0, JSON.stringify(r.body));
  });
});

describe('write scope', () => {
  test('tools/list adds remember and onboard, and nothing destructive', async () => {
    const sid = await openSession(WRITE);
    assert.deepEqual(await listTools(WRITE, sid), WRITE_TOOLS);
  });

  test('remember with replace_kind succeeds (the AppKeep radar push shape)', async () => {
    const sid = await openSession(WRITE);
    const first = await callTool(WRITE, sid, 'remember', {
      entity: 'scope-test:radar',
      content: 'radar state one: eleven open threads',
      kind: 'radar-state',
      replace_kind: true,
    });
    assert.equal(first.isError, false, first.text);
    const second = await callTool(WRITE, sid, 'remember', {
      entity: 'scope-test:radar',
      content: 'radar state two: four open threads, seven closed this week',
      kind: 'radar-state',
      replace_kind: true,
    });
    assert.equal(second.isError, false, second.text);
    assert.equal(JSON.parse(second.text).replaced, true, 'write scope may replace by kind');
  });

  for (const tool of ['forget', 'update', 'merge', 'merge_entities']) {
    test(`${tool} is refused`, async () => {
      const sid = await openSession(WRITE);
      const r = await callTool(WRITE, sid, tool, {});
      assert.equal(r.isError, true);
      assert.match(r.text, new RegExp(`"${tool}" needs the "full" scope; this token is scoped "write"`));
    });
  }
});

describe('full scope (bare, pre-D28 token)', () => {
  test('tools/list shows every tool', async () => {
    const sid = await openSession(BARE);
    assert.deepEqual(await listTools(BARE, sid), ALL_TOOLS);
  });

  test('forget runs (the backwards-compatibility positive control)', async () => {
    const sid = await openSession(BARE);
    const w = await callTool(BARE, sid, 'remember', { entity: 'scope-test:doomed', content: 'to be forgotten' });
    assert.equal(w.isError, false, w.text);
    const f = await callTool(BARE, sid, 'forget', { entity: 'scope-test:doomed' });
    assert.equal(f.isError, false, f.text);
  });
});

describe('session binding', () => {
  test('a read token presenting a full session id is refused with 403', async () => {
    const fullSid = await openSession(BARE);
    const r = await rpc(READ, fullSid, 'tools/call', {
      name: 'forget',
      arguments: { entity: 'scope-test:anything' },
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error.message, /different token scope/);
  });

  test('a full token presenting a read session id is refused too', async () => {
    const readSid = await openSession(READ);
    const r = await rpc(BARE, readSid, 'tools/list');
    assert.equal(r.status, 403);
  });

  test('a refused cross-scope request does not refresh the session (peek before touch)', async () => {
    const fullSid = await openSession(BARE);
    // Through the route this is observable only as "refused, and still alive";
    // that peek leaves the idle timer alone is pinned in session-registry.test.ts.
    const r = await rpc(READ, fullSid, 'tools/list');
    assert.equal(r.status, 403);
    assert.equal((await rpc(BARE, fullSid, 'tools/list')).status, 200);
  });

  test('the same token reusing its own session is fine (control)', async () => {
    const sid = await openSession(WRITE);
    const r = await rpc(WRITE, sid, 'tools/list');
    assert.equal(r.status, 200);
  });
});

describe('createMcpServer at each scope (direct, no HTTP)', () => {
  test('the scope set matches the table for every tool', () => {
    for (const scope of ['read', 'write', 'full'] as const) {
      const server = createMcpServer(scope);
      const registered = (server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })
        ._registeredTools;
      for (const [name, tool] of Object.entries(registered)) {
        assert.equal(tool.enabled, scopeAllows(scope, name), `${scope}/${name}`);
      }
    }
  });
});

describe('OAuth access token', () => {
  test('is full scope through the real route (claude.ai path)', async () => {
    const access = 'oauth-access-' + 'q'.repeat(40);
    registerClient('scope-test-client', ['https://test.local/cb'], 'scope test');
    createToken(access, 'access', 'scope-test-client', null, Date.now() + 60_000);
    const sid = await openSession(access);
    assert.deepEqual(await listTools(access, sid), ALL_TOOLS);
  });
});
