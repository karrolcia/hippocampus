import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(tmpdir(), `hippo-test-mcp-session-${Date.now()}.db`);

// Env must be set before importing config (eager load). No OAuth issuer —
// bearerAuth falls through to the agent-token path, same as auth.test.ts.
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-mcp-session';
process.env.HIPPO_DB_PATH = DB_PATH;
const AGENT_TOKEN = 'a'.repeat(64);
process.env.HIPPO_AGENT_TOKEN = AGENT_TOKEN;

// bearerAuth checks the OAuth access-token store before the agent token, so
// the DB must be initialized before any /mcp request.
const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { app } = await import('../src/index.js');

before(() => {
  initDatabase();
});

after(() => {
  closeDatabase();
});

// Headers the Streamable HTTP transport requires on POST, plus bearer auth
// for the /mcp middleware chain (rate limit + bearerAuth run before the route).
function mcpHeaders(sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${AGENT_TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return headers;
}

describe('/mcp stale session handling', () => {
  test('unknown mcp-session-id returns 404 with JSON-RPC -32001 (client re-init signal)', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders('00000000-0000-4000-8000-00000000dead'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.code, -32001);
    assert.equal(body.error.message, 'Session not found');
    assert.equal(body.id, null);
  });

  test('request without a session id takes the fresh-transport path, not the 404 branch', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'regression-test', version: '0.0.0' },
        },
      }),
    });

    assert.notEqual(res.status, 404);
    assert.equal(res.status, 200);
    // A fresh transport was created and registered — the transport assigns a
    // session id on initialize.
    const newSessionId = res.headers.get('mcp-session-id');
    assert.ok(newSessionId, 'initialize response should carry mcp-session-id');

    // Companion check: the id we just got back is a KNOWN session, so reusing
    // it must not hit the 404 branch either.
    const followUp = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders(newSessionId!),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.notEqual(followUp.status, 404);
  });
});
