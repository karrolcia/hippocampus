import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-param-norm-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-param-normalization';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { normalizeParams, _internal } = await import('../src/mcp/param-normalization.js');
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

  test('consolidate camelCase params normalize, including include_append_only', () => {
    // The leniency layer is keyed off a per-tool param set; a param added to the
    // tool schema but not to that set silently stops normalizing, and Zod then
    // strips the camelCase form. For include_append_only the failure is safe
    // (the exclusion still applies) but the escape hatch just no-ops.
    assert.deepEqual(
      normalizeParams('consolidate', { includeAppendOnly: true, ageDays: 30 }),
      { include_append_only: true, age_days: 30 }
    );
  });

  test('unknown keys pass through on non-strict tools (Zod strips them downstream)', () => {
    // `export` is deliberately non-strict: its optional params narrow the
    // export, but "give me everything" is its documented default shape, so a
    // dropped filter returns a superset the caller can still see in full
    // rather than an answer that looks scoped and is not. Nothing *rejects*
    // the stray key — Zod strips it silently, which is exactly why the
    // widening tools are in STRICT_TOOLS instead.
    assert.deepEqual(
      normalizeParams('export', { format: 'json', not_a_real_param: 'x' }),
      { format: 'json', not_a_real_param: 'x' }
    );
  });

  test('recall: canonical params pass through unchanged (idempotent, still strict)', () => {
    const input = {
      query: 'daily log session',
      type: 'operations',
      since: '2026-08-25',
      kind: 'fact',
      limit: 10,
      spread: false,
      format: 'wire',
    };
    assert.deepEqual(normalizeParams('recall', input), input);
  });

  test('unknown keys on recall throw — a dropped filter silently widens the answer', () => {
    // The key-side mirror of D13 (D14). `from` is the name a caller reaches
    // for instead of `since`; Zod strips it, the bound never applies, and the
    // response is all of history with success: true — which a scheduled sweep
    // asking "what landed since my last run" reads as entirely new.
    assert.throws(
      () => normalizeParams('recall', { query: 'q', from: '2026-08-25' }),
      /recall: unrecognized argument "from"/
    );
  });

  test('recall strict error names the key and the accepted args, never the value', () => {
    // The error echoes into client logs, and on `recall` the stripped value is
    // frequently a search query. Assert the value is absent, not just that the
    // key is present — the leak would otherwise pass every other test here.
    let message = '';
    try {
      normalizeParams('recall', { query: 'q', notes: 'Karolina PhD atmospheric physics' });
      assert.fail('expected recall to reject an unrecognized argument');
    } catch (err) {
      message = (err as Error).message;
    }
    assert.match(message, /unrecognized argument "notes"/);
    assert.ok(
      !message.includes('atmospheric physics'),
      `strict error leaked the argument value: ${message}`
    );
    for (const param of ['query', 'limit', 'type', 'since', 'kind', 'spread', 'format']) {
      assert.ok(message.includes(param), `accepted-args list is missing "${param}": ${message}`);
    }
  });

  test('strict error truncates an over-long key rather than echoing it whole', () => {
    // A malformed call can put content-like text in the KEY position, which
    // the "names the key only" rule would otherwise wave straight through.
    const longKey = 'x'.repeat(200);
    assert.throws(
      () => normalizeParams('recall', { query: 'q', [longKey]: 1 }),
      (err: Error) => {
        assert.ok(!err.message.includes(longKey), 'full over-long key was echoed');
        assert.match(err.message, /unrecognized argument "x{50}…"/);
        return true;
      }
    );
  });

  test('strict consequence clause is per-tool, not forget-specific', () => {
    assert.throws(
      () => normalizeParams('forget', { entity: 'x', bogus: 1 }),
      /what gets deleted/
    );
    assert.throws(
      () => normalizeParams('recall', { query: 'q', bogus: 1 }),
      /what gets returned/
    );
  });

  test('unknown keys on forget throw — destructive scope must never silently widen', () => {
    // Zod strips unknown keys rather than rejecting them, so a stripped arg
    // on forget can turn a scoped delete into a whole-entity delete
    // (the 2026-07-27 skill:pseo-llm-visibility incident).
    assert.throws(
      () => normalizeParams('forget', { entity: 'x', not_a_real_param: 'x' }),
      /forget: unrecognized argument "not_a_real_param"/
    );
  });

  test('prototype-chain key names hit the strict check like any other', () => {
    // Every map in the module is a plain object literal, so `k in aliases`
    // was true for Object.prototype's members: `constructor` took the ALIAS
    // branch, skipped the strict throw, and landed as a key literally named
    // "function Object() { [native code] }" for Zod to strip — a silently
    // widened call, which is the one outcome STRICT_TOOLS exists to prevent.
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      assert.throws(
        () => normalizeParams('recall', { query: 'q', [key]: 'x' }),
        new RegExp(`recall: unrecognized argument "${key.replace(/[$]/g, '')}"`),
        `recall accepted prototype-chain key "${key}"`
      );
      assert.throws(
        () => normalizeParams('forget', { entity: 'e', [key]: 'x' }),
        /forget: unrecognized argument/,
        `forget accepted prototype-chain key "${key}"`
      );
    }
  });

  test('a prototype-chain key on a NON-strict tool stays an own key, not a prototype write', () => {
    // `out['__proto__'] = v` invokes the setter rather than creating a key, so
    // this would hand Zod a `topic` it never received. Assert the own-key
    // shape, not just the absence of a throw.
    const injected = JSON.parse('{"__proto__":{"topic":"injected-entity"}}');
    const out = normalizeParams('export', injected) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out), ['__proto__'], 'key was not preserved as an own property');
    assert.equal(
      (out as { topic?: unknown }).topic,
      undefined,
      'a canonical param leaked in through the prototype'
    );
    assert.equal(Object.getPrototypeOf(out), Object.prototype, 'prototype was overwritten');
    assert.equal(({} as { topic?: unknown }).topic, undefined, 'global prototype pollution');
  });

  test('a tool NAME from the prototype chain passes through instead of crashing', () => {
    // TOOL_PARAMS['constructor'] resolved to the Object function — truthy, so
    // the guard let it past and the next line died on `canonical.has is not a
    // function`. The normalizer runs before SDK dispatch, so this replaced the
    // SDK's clean "tool not found" with an opaque TypeError.
    for (const name of ['constructor', 'toString', '__proto__', 'valueOf']) {
      const input = { query: 'q' };
      assert.deepEqual(
        normalizeParams(name, input),
        input,
        `tool name "${name}" was not treated as unknown`
      );
    }
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

  test('forget with entity + content deletes one observation through the full wire path', async () => {
    // Pins the Zod link of the 2026-07-27 bug: `content` must survive schema
    // validation and reach the handler. If it were ever dropped from the
    // forget shape again, Zod would strip it and this call would widen to a
    // whole-entity delete — normalizeParams can't catch that (content is a
    // known param), only this dispatch-path test can.
    const server = createMcpServer();
    await callTool(server, 'remember', {
      content: 'the observation that stays about winter cycling in Helsinki',
      entity: 'paramnorm-scoped-forget',
    });
    await callTool(server, 'remember', {
      content: 'the observation that goes about espresso grind settings',
      entity: 'paramnorm-scoped-forget',
    });
    const result = await callTool(server, 'forget', {
      entity: 'paramnorm-scoped-forget',
      content: 'the observation that goes about espresso grind settings',
    });
    assert.equal(result.isError, false, `scoped forget should not error: ${result.text}`);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.success, true);
    assert.equal(parsed.deleted.entity, false, 'entity must survive a content-scoped forget');
    assert.equal(parsed.deleted.observations, 1);

    // The surviving observation is still there
    const ctx = await callTool(server, 'context', { topic: 'paramnorm-scoped-forget' });
    assert.equal(ctx.isError, false);
    assert.ok(ctx.text.includes('winter cycling'), 'surviving observation should remain');
    assert.ok(!ctx.text.includes('espresso grind'), 'deleted observation should be gone');
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

  test('unknown param on forget surfaces as a loud error through server dispatch', async () => {
    const server = createMcpServer();
    // The strict-tool throw happens inside the wrapped handler; through the
    // real SDK dispatch it becomes a JSON-RPC error (Promise.resolve() chain
    // captures synchronous throws). Here we drive the handler directly, so
    // the throw reaches us as a rejection — either way, never a silent strip.
    await assert.rejects(
      () => callTool(server, 'forget', { entity: 'x', not_a_real_param: 'x' }),
      /forget: unrecognized argument "not_a_real_param"/
    );
  });

  test('unknown param on recall surfaces as a loud error through server dispatch', async () => {
    const server = createMcpServer();
    await assert.rejects(
      () => callTool(server, 'recall', { query: 'anything', from: '2026-08-25' }),
      /recall: unrecognized argument "from"/
    );
  });

  test('CONTROL: the same recall call minus the stray key answers normally', async () => {
    // The positive control for the test above. Without it, "recall rejects"
    // could be measuring a broken fixture rather than the new strictness —
    // and the whole point of this change is that the un-strict version of
    // this call SUCCEEDS while quietly ignoring the bound.
    const server = createMcpServer();
    await callTool(server, 'remember', {
      content: 'strictness control fact about winter cycling',
      entity: 'paramnorm-recall-control',
    });
    const result = await callTool(server, 'recall', { query: 'winter cycling', limit: 5 });
    assert.equal(result.isError, false, `canonical recall should not error: ${result.text}`);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.success, true);
  });

  test('canonical recall with every optional filter still works end-to-end', async () => {
    // Strictness must not cost the real callers anything. These are the exact
    // params the scheduled sweeps send (briefing.sh, nightly-session-check,
    // knowledge-harvest, scripts/sync-agents.ts) — all canonical, all through
    // the same dispatch path that now rejects strays.
    const server = createMcpServer();
    await callTool(server, 'remember', {
      content: 'canonical filter fact about espresso grind settings',
      entity: 'paramnorm-recall-filters',
      type: 'operations',
      kind: 'fact',
    });
    const result = await callTool(server, 'recall', {
      query: 'espresso grind',
      type: 'operations',
      kind: 'fact',
      since: '2020-01-01',
      limit: 10,
      spread: false,
      format: 'wire',
    });
    assert.equal(result.isError, false, `filtered recall should not error: ${result.text}`);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.success, true);
  });
});

// ---------------------------------------------------------------------------
// Drift guard: TOOL_PARAMS must match the schemas the server actually
// advertises. This is what makes STRICT_TOOLS safe to extend.
// ---------------------------------------------------------------------------

type ToolsListRequest = { jsonrpc: '2.0'; id: number; method: 'tools/list'; params: Record<string, never> };
type ToolsListResult = { tools: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] };

async function listTools(server: ReturnType<typeof createMcpServer>): Promise<ToolsListResult> {
  const handlers = (server as unknown as {
    server: { _requestHandlers: Map<string, (req: ToolsListRequest, extra: unknown) => Promise<ToolsListResult>> };
  }).server._requestHandlers;
  const handler = handlers.get('tools/list');
  if (!handler) throw new Error('tools/list handler missing — SDK internals changed');
  return handler(
    { jsonrpc: '2.0', id: ++callId, method: 'tools/list', params: {} },
    {
      signal: new AbortController().signal,
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    }
  );
}

describe('TOOL_PARAMS drift guard', () => {
  // TOOL_PARAMS is a hand-maintained copy of every tool's parameter list, and
  // nothing links it to the registered schemas. Drift breaks BOTH directions:
  // a param added to a tool but missing here silently stops normalizing (the
  // camelCase form gets stripped) and — on a strict tool — turns a valid,
  // documented call into a hard error; a param removed from a tool but left
  // here keeps a dead name accepted. `tools/list` is the wire contract every
  // client's model actually reads, so compare against that rather than the
  // Zod objects behind it.
  test('every advertised tool has an entry, with exactly its advertised params', async () => {
    const server = createMcpServer();
    const { tools } = await listTools(server);
    assert.ok(tools.length > 0, 'tools/list returned nothing — dispatch regression');

    const advertised = new Map<string, string[]>();
    for (const tool of tools) {
      const properties = tool.inputSchema?.properties ?? {};
      assert.ok(
        Object.keys(properties).length > 0,
        `${tool.name}: tools/list advertised no properties — the ZodEffects/` +
          `EMPTY_OBJECT_JSON_SCHEMA regression (see CLAUDE.md gotcha)`
      );
      advertised.set(tool.name, Object.keys(properties).sort());
    }

    assert.deepEqual(
      Object.keys(_internal.TOOL_PARAMS).sort(),
      [...advertised.keys()].sort(),
      'TOOL_PARAMS tool names drifted from the tools the server advertises'
    );

    for (const [name, params] of advertised) {
      assert.deepEqual(
        [...(_internal.TOOL_PARAMS[name] ?? [])].sort(),
        params,
        `TOOL_PARAMS.${name} drifted from the schema advertised by tools/list`
      );
    }
  });

  test('every semantic alias resolves to a real param on its own tool', async () => {
    // An alias pointing at a name the tool no longer has would rewrite a valid
    // key into one Zod strips — and on a strict tool the alias branch runs
    // BEFORE the strict check, so the failure would be silent, not loud.
    for (const [tool, aliases] of Object.entries(_internal.SEMANTIC_ALIASES)) {
      const canonical = _internal.TOOL_PARAMS[tool];
      assert.ok(canonical, `SEMANTIC_ALIASES names unknown tool "${tool}"`);
      for (const [from, to] of Object.entries(aliases)) {
        assert.ok(
          canonical.has(to),
          `${tool}: alias "${from}" targets "${to}", which is not one of its params`
        );
        assert.ok(
          !canonical.has(from),
          `${tool}: alias "${from}" shadows a real param of the same name`
        );
      }
    }
  });
});
