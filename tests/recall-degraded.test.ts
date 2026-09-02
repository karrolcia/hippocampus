/**
 * Regression tests for the silent semantic-search degradation in `recall` (D16).
 *
 * `recall()` used to call:
 *
 *   semanticSearch(query, opts).catch(() => [])
 *
 * Semantic search is the PRIMARY leg and keyword LIKE is the fallback, so any
 * embedding failure — model load, OOM, a corrupt vector — produced a real but
 * badly incomplete answer wearing a complete answer's shape: `success: true`,
 * a smaller result set, and nothing anywhere to say half the search never ran.
 * At the limit it produced `success: true, count: 0`, which is byte-for-byte
 * the answer for "the memory holds nothing about this".
 *
 * Same failure family as D13, in the same function: fail quietly toward fewer
 * results, on the read path every scheduled sweep and every briefing calls.
 *
 * The failure is forced the way it actually happens in production — the model
 * genuinely fails to load — rather than by stubbing the module. `env` is
 * poisoned before anything touches the lazy pipeline, so the first
 * `generateEmbedding` in this process rejects with a real transformers error,
 * offline and deterministically. The 'poison took effect' test below is the
 * positive control: without it every assertion here could pass vacuously
 * against a WORKING embedder, since a healthy semantic leg also returns
 * results and also never throws.
 */
import { env } from '@huggingface/transformers';

// Must precede the project imports: the pipeline is a module-level singleton
// and caches on first successful load, so a healthy load anywhere in this
// process would make the file untestable for the rest of its run.
const MISSING_MODEL_DIR = '/nonexistent-hippocampus-degraded-test-models';
env.allowRemoteModels = false;
env.allowLocalModels = true;
(env as unknown as { localModelPath: string }).localModelPath = MISSING_MODEL_DIR;
process.env.TRANSFORMERS_CACHE = MISSING_MODEL_DIR;

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-recall-degraded-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-recall-degraded';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { context } = await import('../src/mcp/tools/context.js');
const { generateEmbedding } = await import('../src/embeddings/embedder.js');
const { findOrCreateEntity } = await import('../src/db/entities.js');
const { createObservation, searchObservations } = await import('../src/db/observations.js');
const { createRelationship } = await import('../src/db/relationships.js');
const { createMcpServer } = await import('../src/mcp/server.js');

// A word that exists in the fixture, so the keyword leg can still answer, and
// one that exists nowhere, so it cannot.
const KEYWORD_HIT = 'ionosphere';
const KEYWORD_MISS = 'zzqx_no_such_token_42';

const ENTITY = 'degraded-test-entity';
const RELATED_ENTITY = 'degraded-test-related';

before(() => {
  initDatabase();

  // Seeded through the DB layer, NOT through `remember`: `remember` generates an
  // embedding and would throw in this process. Rows without vectors are also the
  // faithful fixture — the keyword leg is exactly what survives when the
  // embedder is down, and it is the only thing this fixture should be able to
  // find.
  const entity = findOrCreateEntity(ENTITY, 'project');
  createObservation(entity.id, `${KEYWORD_HIT} sounding notes alpha`, undefined, 1.0, 'fact');
  createObservation(entity.id, `${KEYWORD_HIT} sounding notes bravo`, undefined, 1.0, 'fact');

  const related = findOrCreateEntity(RELATED_ENTITY, 'person');
  createObservation(related.id, `${KEYWORD_HIT} collaborator note`, undefined, 1.0, 'fact');
  createRelationship(entity.id, related.id, 'works_with');
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

// ---------------------------------------------------------------------------
// Positive controls. Every assertion below is of the form "the degraded path
// behaves like X", and all of them would also pass against a healthy embedder
// if the poison stopped working. These two are what make the file mean
// something.
// ---------------------------------------------------------------------------

describe('controls', () => {
  test('poison took effect: generateEmbedding rejects in this process', async () => {
    await assert.rejects(
      () => generateEmbedding('probe'),
      (err: Error) => {
        assert.ok(err instanceof Error, 'expected a real Error');
        return true;
      },
      'the embedding path did NOT fail — every degraded assertion in this file is vacuous'
    );
  });

  test('the keyword leg still finds the fixture', () => {
    // Otherwise "degraded: true with results" could not be distinguished from
    // "degraded: true because nothing matched at all".
    const hits = searchObservations({ query: KEYWORD_HIT, limit: 10 });
    assert.ok(hits.length >= 2, `keyword fixture is not searchable: ${hits.length} hits`);
    assert.equal(searchObservations({ query: KEYWORD_MISS, limit: 10 }).length, 0);
  });
});

// ---------------------------------------------------------------------------
// The contract.
// ---------------------------------------------------------------------------

describe('recall discloses a degraded semantic leg', () => {
  test('keyword hits are still returned, flagged degraded', async () => {
    const result = await recall({ query: KEYWORD_HIT, limit: 10, spread: false, format: 'full' }) as {
      success: boolean; count: number; degraded: boolean; degraded_reason?: string;
      memories: Array<{ content: string }>;
    };

    assert.equal(result.success, true);
    assert.ok(result.count > 0, 'the keyword fallback must survive an embedder failure');
    assert.equal(result.degraded, true, 'a half-run search must not report as a whole one');
    assert.ok(result.degraded_reason, 'degraded without a reason is a flag nobody can act on');
  });

  test('degraded_reason carries the error, never the query', async () => {
    const result = await recall({ query: KEYWORD_HIT, limit: 10, spread: false, format: 'full' }) as {
      degraded_reason?: string;
    };
    const reason = result.degraded_reason ?? '';
    assert.ok(reason.length > 0);
    // The response is safe either way (the caller sent the query), but this same
    // string is written to the server log, which must never carry it.
    assert.ok(!reason.includes(KEYWORD_HIT), `degraded_reason leaked the query: ${reason}`);
    assert.ok(reason.length <= 320, 'degraded_reason must be capped, not an unbounded driver dump');
  });

  test('a degraded search with NO keyword hits throws rather than returning an empty success', async () => {
    // The cell the flag cannot rescue: `success: true, count: 0` is exactly the
    // shape of "nothing is stored", and D13 already settled that a memory server
    // must not answer that way when it does not know.
    await assert.rejects(
      () => recall({ query: KEYWORD_MISS, limit: 10, spread: false, format: 'full' }),
      (err: Error) => {
        assert.match(err.message, /[Ss]emantic search failed/);
        assert.match(err.message, /indistinguishable from an empty memory/);
        return true;
      }
    );
  });

  test('a malformed question is never reported as a degraded answer', async () => {
    // The D15 interaction, exercised from the one direction that is reachable.
    // `degraded` means "the server's machinery failed"; a bad `since` bound
    // means "the caller's question was malformed", and the two must not be
    // conflated — a contract violation dressed as a flagged partial answer is
    // the silent-empty failure D15's assert exists to prevent, reintroduced by
    // the error handling wrapped around it. Here BOTH are true at once (the
    // embedder is down for this whole file), which is exactly the case where a
    // careless catch would report the wrong one.
    await assert.rejects(
      () => recall({ query: KEYWORD_HIT, since: 'whenever', limit: 10, spread: false, format: 'full' }),
      (err: Error) => {
        assert.match(err.message, /since/i, 'the bound is what failed, so the bound is what must be named');
        assert.doesNotMatch(
          err.message,
          /[Ss]emantic search failed/,
          'a malformed bound must not be attributed to the embedder'
        );
        return true;
      }
    );
  });

  test('spread still throws — an embedding failure there has no honest fallback', async () => {
    // Unchanged behaviour, pinned deliberately (D16). Keyword-only results are
    // not a degraded spread; they are a different operation. The two branches
    // disagree about the disposal because they disagree about what can be
    // returned, not about whether the failure matters.
    await assert.rejects(
      () => recall({ query: KEYWORD_HIT, limit: 10, spread: true, format: 'full' }),
      (err: Error) => err instanceof Error
    );
  });
});

describe('every response format carries the flag and says so in its text', () => {
  for (const format of ['compact', 'wire', 'index'] as const) {
    test(`${format} format`, async () => {
      const result = await recall({ query: KEYWORD_HIT, limit: 10, spread: false, format }) as {
        success: boolean; count: number; degraded: boolean; degraded_reason?: string; text: string;
      };

      assert.equal(result.degraded, true, `${format} dropped the flag`);
      assert.ok(result.degraded_reason);
      // The sibling JSON field is not enough on the text formats: they exist to
      // be READ as text, and a caller reading `text` never sees a field it does
      // not look at.
      assert.match(result.text, /DEGRADED/, `${format} text gave no visible warning`);
      assert.ok(result.count > 0, `${format} lost the keyword results`);
    });
  }
});

describe('context stops claiming "no entity found" when its last leg did not run', () => {
  test('a topic miss throws instead of reporting an empty memory', async () => {
    // exact -> LIKE -> semantic. When semantic is the leg that fails there is
    // never a partial answer to return, so the only alternative to throwing is
    // `success: false, "No entity found"` — a false claim about the memory.
    await assert.rejects(
      () => context({ topic: KEYWORD_MISS }),
      (err: Error) => err instanceof Error
    );
  });

  test('an exact hit is unaffected — the semantic leg never runs', async () => {
    const result = await context({ topic: ENTITY });
    assert.equal(result.success, true);
    assert.equal(result.entity?.name, ENTITY);
    assert.ok((result.entity?.observations.length ?? 0) >= 2);
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
async function callTool(name: string, args: Record<string, unknown>) {
  const server = createMcpServer();
  const handlers = (server as unknown as {
    server: { _requestHandlers: Map<string, WrappedHandler> };
  }).server._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('tools/call handler missing — install order regression');
  const result = await handler(
    { jsonrpc: '2.0', id: ++callId, method: 'tools/call', params: { name, arguments: args } },
    { signal: new AbortController().signal, sendNotification: async () => {}, sendRequest: async () => ({}) }
  );
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

describe('over MCP dispatch', () => {
  test('a degraded-but-answerable recall reaches the client flagged, not as an error', async () => {
    const result = await callTool('recall', { query: KEYWORD_HIT, limit: 10 });
    assert.equal(result.isError, false, result.text);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.success, true);
    assert.equal(parsed.degraded, true);
    assert.ok(parsed.count > 0);
  });

  test('a degraded recall with nothing to return surfaces as isError, never as count 0', async () => {
    const result = await callTool('recall', { query: KEYWORD_MISS, limit: 10 });
    assert.equal(result.isError, true, `expected an error, got: ${result.text}`);
    assert.match(result.text, /[Ss]emantic search failed/);

    // The specific shape this entry exists to make impossible.
    assert.doesNotMatch(result.text, /"count":\s*0/);
    assert.doesNotMatch(result.text, /"success":\s*true/);
  });
});
