import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// D29: /mcp reads at most MCP_MAX_REQUEST_BODY_BYTES. The cap must refuse an
// oversized body on BOTH read paths (declared Content-Length, and a streamed
// body with none), and must still admit the largest legitimate call.

const DB_PATH = join(tmpdir(), `hippo-test-mcp-body-limit-${Date.now()}.db`);
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-mcp-body-limit';
process.env.HIPPO_DB_PATH = DB_PATH;
const AGENT_TOKEN = 'b'.repeat(64);
process.env.HIPPO_AGENT_TOKEN = AGENT_TOKEN;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { app, MCP_MAX_REQUEST_BODY_BYTES } = await import('../src/index.js');
const { MAX_TOOL_INPUT_ELEMENTS } = await import('../src/mcp/server.js');
const { DEFAULT_MAX_REQUEST_BODY_SIZE } = await import('@modelcontextprotocol/sdk/server/requestBody.js');

before(() => {
  initDatabase();
});

after(() => {
  closeDatabase();
});

function mcpHeaders(sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${AGENT_TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
    headers['mcp-protocol-version'] = '2025-06-18';
  }
  return headers;
}

async function openSession(): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: mcpHeaders(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'body-limit-test', version: '0.0.0' },
      },
    }),
  });
  assert.equal(res.status, 200);
  const sessionId = res.headers.get('mcp-session-id');
  assert.ok(sessionId, 'initialize returned a session id');
  return sessionId;
}

// A merge whose observation_ids array is padded to `bytes` total: the shape
// that makes zod allocate one issue object per element.
function hostileMergeBody(bytes: number): string {
  const head = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"merge","arguments":{"content":"x","observation_ids":[';
  const tail = ']}}}';
  // n elements joined by commas is 2n - 1 chars; one extra element so the body
  // is never a byte short of `bytes` (a body AT the cap is admitted).
  const n = Math.ceil((bytes - head.length - tail.length) / 2) + 1;
  const body = head + new Array(n).fill('1').join(',') + tail;
  assert.ok(body.length >= bytes, `hostile body is ${body.length} bytes, wanted >= ${bytes}`);
  return body;
}

describe('/mcp request body cap (D29)', () => {
  test('cap is 1 MiB and below the SDK default', () => {
    assert.equal(MCP_MAX_REQUEST_BODY_BYTES, 1024 * 1024);
    assert.ok(MCP_MAX_REQUEST_BODY_BYTES < DEFAULT_MAX_REQUEST_BODY_SIZE);
  });

  test('largest legitimate call (update, two 50,000-char strings, fully \\u-escaped) is admitted', async () => {
    const sessionId = await openSession();
    // Every code unit of every string escaped as \uXXXX: the worst a client
    // may legally send. The lengths are update's schema maxima.
    const esc = (n: number) => '\\u00e9'.repeat(n);
    const body =
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"update","arguments":{' +
      `"entity":"${esc(200)}","old_content":"${esc(50000)}","new_content":"${esc(50000)}","kind":"${esc(50)}"}}}`;
    assert.ok(body.length > 601_500, `worst-case legit body is ${body.length} bytes`);
    assert.ok(body.length < MCP_MAX_REQUEST_BODY_BYTES);

    const res = await app.request('/mcp', { method: 'POST', headers: mcpHeaders(sessionId), body });
    // Reached the tool's own handler: the update fails in-band because the
    // entity does not exist. A size refusal (413), a schema refusal ("Input
    // validation error") or an element-cap refusal would each read differently.
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.id, 3);
    const text: string = json.result.content[0].text;
    assert.doesNotMatch(text, /Input validation error|maximum of \d+ elements/);
    assert.match(text, /not found/i);
  });

  test('a merge with more than MAX_TOOL_INPUT_ELEMENTS ids is refused before zod, in a short error', async () => {
    const sessionId = await openSession();
    const call = (ids: number) =>
      app.request('/mcp', {
        method: 'POST',
        headers: mcpHeaders(sessionId),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          // numbers, not strings: every element fails zod, the blowup's shape
          params: { name: 'merge', arguments: { content: 'x', observation_ids: new Array(ids).fill(1) } },
        }),
      });
    // content + observation_ids = 2 members, so ids = limit - 2 sits exactly at the cap.
    const atCap = await (await call(MAX_TOOL_INPUT_ELEMENTS - 2)).text();
    assert.doesNotMatch(atCap, /maximum of \d+ elements/, 'at the cap: reaches zod');
    assert.match(atCap, /Input validation error/);

    const over = await call(MAX_TOOL_INPUT_ELEMENTS - 1);
    assert.equal(over.status, 200);
    const text = await over.text();
    assert.match(text, new RegExp(`maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`));
    assert.ok(text.length < 1000, `refusal is ${text.length} bytes, not one line per element`);
  });

  test('oversized body with a declared Content-Length is refused with 413', async () => {
    const sessionId = await openSession();
    const body = hostileMergeBody(MCP_MAX_REQUEST_BODY_BYTES + 1);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders(sessionId), 'content-length': String(Buffer.byteLength(body)) },
      body,
    });
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.error.code, -32000);
  });

  test('oversized streamed body with no Content-Length is refused with 413', async () => {
    const sessionId = await openSession();
    const bytes = new TextEncoder().encode(hostileMergeBody(MCP_MAX_REQUEST_BODY_BYTES + 1));
    const chunk = 64 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.subarray(i, i + chunk));
        controller.close();
      },
    });
    const headers = mcpHeaders(sessionId);
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers,
      body: stream,
      // @ts-expect-error duplex is required for a streamed body in Node's fetch but missing from the DOM RequestInit type
      duplex: 'half',
    });
    assert.equal(req.headers.get('content-length'), null, 'no declared length: the streaming path');
    const res = await app.request(req);
    assert.equal(res.status, 413);
  });
});
