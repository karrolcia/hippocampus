import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// D28: the same token listed under two scopes is a config mistake; it must
// resolve to the NARROWER scope, whichever order the entries are in. Its own
// file because the token list is read once, at module load.
const DUP = 'd'.repeat(64);
const DUP2 = 'e'.repeat(64);
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-agent-scopes-dup';
process.env.HIPPO_DB_PATH = join(tmpdir(), `hippo-test-agent-scopes-dup-${Date.now()}.db`);
process.env.HIPPO_OAUTH_ISSUER = 'https://test.local';
process.env.HIPPO_OAUTH_USER = 'test';
process.env.HIPPO_OAUTH_PASSWORD_HASH = 'unused';
process.env.HIPPO_AGENT_TOKEN = `full:${DUP},read:${DUP},write:${DUP2},${DUP2}`;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { bearerAuth } = await import('../src/auth/oauth.js');

before(() => initDatabase());
after(() => closeDatabase());

async function scopeFor(token: string): Promise<unknown> {
  const vars = new Map<string, unknown>();
  const ctx = {
    req: { header: (n: string) => (n.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined) },
    header: () => {},
    set: (k: string, v: unknown) => vars.set(k, v),
    get: (k: string) => vars.get(k),
    json: (body: unknown, status?: number) => ({ body, status }),
  };
  let passed = false;
  await bearerAuth()(ctx as any, async () => {
    passed = true;
  });
  assert.equal(passed, true);
  return vars.get('scope');
}

test('full listed before read → read', async () => {
  assert.equal(await scopeFor(DUP), 'read');
});

test('write listed before bare (full) → write', async () => {
  assert.equal(await scopeFor(DUP2), 'write');
});
