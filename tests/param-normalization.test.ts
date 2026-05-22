import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-param-norm-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-param-normalization';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { normalizeParams } = await import('../src/mcp/param-normalization.js');
const { createMcpServer } = await import('../src/mcp/server.js');

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
// Unit tests: normalizeParams pure function
// ---------------------------------------------------------------------------

describe('normalizeParams — unit', () => {
  test('canonical input passes through unchanged (idempotent with bash layer)', () => {
    const input = { entity: 'foo', observation_id: 'obs-123' };
    assert.deepEqual(normalizeParams('forget', input), input);
  });

  test('forget: entity_name alias maps to entity', () => {
    assert.deepEqual(
      normalizeParams('forget', { entity_name: 'user' }),
      { entity: 'user' }
    );
  });

  test('forget: entityName alias maps to entity', () => {
    assert.deepEqual(
      normalizeParams('forget', { entityName: 'user' }),
      { entity: 'user' }
    );
  });

  test('forget: observationId (camelCase) maps to observation_id', () => {
    assert.deepEqual(
      normalizeParams('forget', { observationId: 'obs-1' }),
      { observation_id: 'obs-1' }
    );
  });

  test('remember: replaceKind maps to replace_kind', () => {
    assert.deepEqual(
      normalizeParams('remember', {
        content: 'x',
        entity: 'agent:foo',
        kind: 'checkpoint',
        replaceKind: true,
      }),
      { content: 'x', entity: 'agent:foo', kind: 'checkpoint', replace_kind: true }
    );
  });

  test('update: oldContent and newContent map to snake_case', () => {
    assert.deepEqual(
      normalizeParams('update', {
        entity: 'foo',
        oldContent: 'before',
        newContent: 'after',
      }),
      { entity: 'foo', old_content: 'before', new_content: 'after' }
    );
  });

  test('context: entity alias maps to topic', () => {
    assert.deepEqual(
      normalizeParams('context', { entity: 'rsl-pipeline' }),
      { topic: 'rsl-pipeline' }
    );
  });

  test('context: entity_name and entityName both map to topic', () => {
    assert.deepEqual(
      normalizeParams('context', { entity_name: 'x' }),
      { topic: 'x' }
    );
    assert.deepEqual(
      normalizeParams('context', { entityName: 'x' }),
      { topic: 'x' }
    );
  });

  test('unknown keys pass through (server rejects, not us)', () => {
    assert.deepEqual(
      normalizeParams('forget', { not_a_real_param: 'x' }),
      { not_a_real_param: 'x' }
    );
  });

  test('unknown tool name passes args through unchanged', () => {
    const input = { entityName: 'x' };
    assert.deepEqual(normalizeParams('nonexistent_tool', input), input);
  });

  test('non-object args pass through', () => {
    assert.equal(normalizeParams('forget', null), null);
    assert.equal(normalizeParams('forget', undefined), undefined);
    assert.deepEqual(normalizeParams('forget', ['x']), ['x']);
  });

  test('merge_entities: sourceEntities and targetEntity map to snake_case', () => {
    assert.deepEqual(
      normalizeParams('merge_entities', {
        sourceEntities: ['a', 'b'],
        targetEntity: 'c',
        targetType: 'person',
      }),
      { source_entities: ['a', 'b'], target_entity: 'c', target_type: 'person' }
    );
  });

  test('check_version: versionHash maps to version_hash', () => {
    assert.deepEqual(
      normalizeParams('check_version', { entity: 'x', versionHash: 'abc' }),
      { entity: 'x', version_hash: 'abc' }
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests: the server actually accepts non-canonical params
// end-to-end through the MCP dispatch path.
// ---------------------------------------------------------------------------

// The SDK's setRequestHandler wraps the user handler with schema parsing against
// CallToolRequestSchema, so requests routed through _requestHandlers must carry
// the full JSON-RPC shape (`method`, `params.name`, `params.arguments`). Our
// install hook runs BEFORE that schema parse — so this also exercises the
// arrival-order: normalize first, schema-validate second, dispatch third.
type ToolCallRequest = {
  jsonrpc: '2.0';
  id: number;
  method: 'tools/call';
  params: { name: string; arguments: unknown };
};
type ToolCallResult = { content: { type: string; text: string }[]; isError?: boolean };
type WrappedHandler = (request: ToolCallRequest, extra: unknown) => Promise<ToolCallResult>;

function getCallToolHandler(server: ReturnType<typeof createMcpServer>): WrappedHandler {
  const handlers = (server as unknown as {
    server: { _requestHandlers: Map<string, WrappedHandler> };
  }).server._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('tools/call handler missing — install order regression');
  return handler;
}

let callId = 0;
async function callTool(
  server: ReturnType<typeof createMcpServer>,
  name: string,
  args: Record<string, unknown>
) {
  const handler = getCallToolHandler(server);
  const result = await handler(
    { jsonrpc: '2.0', id: ++callId, method: 'tools/call', params: { name, arguments: args } },
    {
      signal: new AbortController().signal,
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    }
  );
  const text = result.content[0]?.text ?? '';
  return { isError: result.isError === true, text, raw: result };
}

describe('normalizeParams — integration via MCP server dispatch', () => {
  test('remember with replaceKind (camelCase) succeeds', async () => {
    const server = createMcpServer();
    const result = await callTool(server, 'remember', {
      content: 'integration test fact',
      entity: 'paramnorm-integration',
      kind: 'fact',
      replaceKind: true,
    });
    assert.equal(result.isError, false, `remember should not error: ${result.text}`);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.success, true);
  });

  test('forget with entity_name succeeds (semantic alias)', async () => {
    const server = createMcpServer();
    // First create an entity to forget
    await callTool(server, 'remember', {
      content: 'doomed observation',
      entity: 'paramnorm-doomed',
    });
    const result = await callTool(server, 'forget', { entity_name: 'paramnorm-doomed' });
    assert.equal(result.isError, false, `forget should not error: ${result.text}`);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.success, true);
  });

  test('forget with entityName succeeds (camelCase alias)', async () => {
    const server = createMcpServer();
    await callTool(server, 'remember', {
      content: 'another doomed observation',
      entity: 'paramnorm-doomed-camel',
    });
    const result = await callTool(server, 'forget', { entityName: 'paramnorm-doomed-camel' });
    assert.equal(result.isError, false, `forget should not error: ${result.text}`);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.success, true);
  });

  test('update with oldContent / newContent (camelCase) succeeds', async () => {
    const server = createMcpServer();
    await callTool(server, 'remember', {
      content: 'original content',
      entity: 'paramnorm-update-test',
    });
    const result = await callTool(server, 'update', {
      entity: 'paramnorm-update-test',
      oldContent: 'original content',
      newContent: 'revised content',
    });
    assert.equal(result.isError, false, `update should not error: ${result.text}`);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.success, true);
  });

  test('context with entity alias succeeds', async () => {
    const server = createMcpServer();
    await callTool(server, 'remember', {
      content: 'context test fact',
      entity: 'paramnorm-context-test',
    });
    const result = await callTool(server, 'context', { entity: 'paramnorm-context-test' });
    assert.equal(result.isError, false, `context should not error: ${result.text}`);
    const parsed = JSON.parse(result.text);
    assert.ok(parsed.entity, 'context returned no entity');
  });

  test('canonical params still work (regression check)', async () => {
    const server = createMcpServer();
    const result = await callTool(server, 'remember', {
      content: 'canonical fact',
      entity: 'paramnorm-canonical',
      replace_kind: false,
    });
    assert.equal(result.isError, false, `canonical remember should work: ${result.text}`);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.success, true);
  });

  test('unknown param name still gets rejected by Zod (we only normalize, never invent)', async () => {
    const server = createMcpServer();
    const result = await callTool(server, 'forget', { not_a_real_param: 'x' });
    // Either Zod rejects (validation error) or forget returns success:false
    // (because no entity/observation_id was provided). Both are correct —
    // we should NOT silently coerce an unknown param into a valid one.
    if (!result.isError) {
      const parsed = JSON.parse(result.text);
      assert.equal(parsed.success, false, 'forget with no recognized params should not succeed');
    }
  });
});
