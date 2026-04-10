import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(tmpdir(), `hippo-test-auth-${Date.now()}.db`);

// Env must be set before importing config/oauth modules (eager load)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-auth';
process.env.HIPPO_DB_PATH = DB_PATH;
process.env.HIPPO_OAUTH_ISSUER = 'https://test.local';
process.env.HIPPO_OAUTH_USER = 'test';
process.env.HIPPO_OAUTH_PASSWORD_HASH = 'unused';
process.env.HIPPO_AGENT_TOKEN = 'a'.repeat(64); // 64-char test token

// bearerAuth always calls getToken() first for the OAuth access-token path,
// which requires the DB to be initialized. We init an empty test DB so the
// lookup returns nothing and the code cleanly falls through to the agent
// token check.
const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { bearerAuth } = await import('../src/auth/oauth.js');

before(() => {
  initDatabase();
});

after(() => {
  closeDatabase();
});

// Minimal fake Hono context — only the methods bearerAuth touches
function makeCtx(authHeader?: string) {
  const headers = new Map<string, string>();
  if (authHeader) headers.set('authorization', authHeader);
  const responseHeaders = new Map<string, string>();
  let jsonBody: unknown = null;
  let jsonStatus: number | null = null;

  const ctx = {
    req: {
      header: (name: string) => headers.get(name.toLowerCase()),
    },
    header: (name: string, value: string) => {
      responseHeaders.set(name, value);
    },
    json: (body: unknown, status?: number) => {
      jsonBody = body;
      jsonStatus = status ?? 200;
      return { body, status: jsonStatus };
    },
  };

  return {
    ctx,
    getResponse: () => ({ body: jsonBody, status: jsonStatus, headers: responseHeaders }),
  };
}

describe('bearerAuth with agent token fallback', () => {
  test('rejects missing Authorization header', async () => {
    const { ctx, getResponse } = makeCtx();
    const middleware = bearerAuth();
    let nextCalled = false;
    await middleware(ctx as any, async () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(getResponse().status, 401);
  });

  test('rejects bogus token', async () => {
    const { ctx, getResponse } = makeCtx('Bearer totally-wrong');
    const middleware = bearerAuth();
    let nextCalled = false;
    await middleware(ctx as any, async () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(getResponse().status, 401);
  });

  test('accepts valid agent token', async () => {
    const { ctx } = makeCtx(`Bearer ${'a'.repeat(64)}`);
    const middleware = bearerAuth();
    let nextCalled = false;
    await middleware(ctx as any, async () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  test('rejects agent token with different length (length gate)', async () => {
    const { ctx, getResponse } = makeCtx(`Bearer ${'a'.repeat(63)}`);
    const middleware = bearerAuth();
    let nextCalled = false;
    await middleware(ctx as any, async () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(getResponse().status, 401);
  });

  test('rejects agent token with same length but different content', async () => {
    const { ctx, getResponse } = makeCtx(`Bearer ${'b'.repeat(64)}`);
    const middleware = bearerAuth();
    let nextCalled = false;
    await middleware(ctx as any, async () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(getResponse().status, 401);
  });
});
