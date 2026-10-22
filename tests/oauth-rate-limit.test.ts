import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(tmpdir(), `hippo-test-oauth-rate-limit-${Date.now()}.db`);
const PASSWORD = 'correct-horse-battery-staple';

// Env must be set before importing config/oauth modules (eager load)
process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-oauth-rate-limit';
process.env.HIPPO_DB_PATH = DB_PATH;
process.env.HIPPO_OAUTH_ISSUER = 'https://test.local';
process.env.HIPPO_OAUTH_USER = 'test';
process.env.HIPPO_OAUTH_PASSWORD_HASH = createHash('sha256').update(PASSWORD).digest('base64url');

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { createOAuthRoutes, OAUTH_LIMITS, OAUTH_BODY_LIMIT_BYTES } = await import('../src/auth/oauth.js');
const { isTrustedProxyPeer } = await import('../src/middleware/rate-limit.js');

const REDIRECT = 'https://client.example/cb';
const PUBLIC_PEER = '203.0.113.7';
const PROXY_PEER = '172.18.0.1'; // the docker bridge gateway prod's app sees

// What @hono/node-server's getConnInfo reads: c.env.incoming.socket.
function from(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress } } };
}

type OAuth = ReturnType<typeof createOAuthRoutes>;

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

function withXff(init: RequestInit, xff: string): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), 'x-forwarded-for': xff } };
}

async function register(oauth: OAuth, peer = '198.51.100.1'): Promise<string> {
  const res = await oauth.request('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  }, from(peer));
  assert.equal(res.status, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function login(clientId: string, password: string): RequestInit {
  return form({
    client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'x',
    state: 's', username: 'test', password,
  });
}

// Spend `n` requests and return the statuses.
async function spend(oauth: OAuth, path: string, init: () => RequestInit, env: object, n: number) {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await oauth.request(path, init(), env)).status);
  return statuses;
}

describe('OAuth route rate limits (D26)', () => {
  let oauth: OAuth;

  before(() => initDatabase());
  after(() => closeDatabase());
  beforeEach(() => { oauth = createOAuthRoutes(); });

  test('POST /authorize is limited per client address', async () => {
    const { max } = OAUTH_LIMITS.authorize;
    const bad = () => form({ client_id: 'nope' });
    const under = await spend(oauth, '/authorize', bad, from(PUBLIC_PEER), max);
    assert.ok(under.every((s) => s === 400), `first ${max} reach the handler: ${under}`);
    assert.equal((await oauth.request('/authorize', bad(), from(PUBLIC_PEER))).status, 429);
    // A different address still has its own budget.
    assert.equal((await oauth.request('/authorize', bad(), from('203.0.113.8'))).status, 400);
  });

  test('POST /token is limited per client address', async () => {
    const { max } = OAUTH_LIMITS.token;
    const bad = () => form({ grant_type: 'authorization_code', code: 'nope' });
    const under = await spend(oauth, '/token', bad, from(PUBLIC_PEER), max);
    assert.ok(under.every((s) => s === 400), `first ${max} reach the handler: ${under}`);
    assert.equal((await oauth.request('/token', bad(), from(PUBLIC_PEER))).status, 429);
  });

  test('POST /register is limited per client address', async () => {
    const { max } = OAUTH_LIMITS.register;
    const body = () => ({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    const under = await spend(oauth, '/register', body, from(PUBLIC_PEER), max);
    assert.ok(under.every((s) => s === 201), `first ${max} register: ${under}`);
    assert.equal((await oauth.request('/register', body(), from(PUBLIC_PEER))).status, 429);
  });

  test('the OAuth limits are tighter than /mcp', () => {
    // /mcp allows RATE_LIMIT_RECALL (default 60) per minute.
    for (const { max, windowMs } of [OAUTH_LIMITS.authorize, OAUTH_LIMITS.token, OAUTH_LIMITS.register]) {
      assert.ok(max / (windowMs / 60_000) < 60, `${max} per ${windowMs}ms`);
    }
  });

  test('rendering the GET /authorize form does not spend the POST budget', async () => {
    const { max } = OAUTH_LIMITS.authorize;
    await spend(oauth, '/authorize?client_id=nope', () => ({ method: 'GET' }), from(PUBLIC_PEER), max + 5);
    assert.equal((await oauth.request('/authorize', form({ client_id: 'nope' }), from(PUBLIC_PEER))).status, 400);
  });

  test('a forged X-Forwarded-For from a public peer does not get a fresh counter', async () => {
    const { max } = OAUTH_LIMITS.authorize;
    let i = 0;
    const forged = () => withXff(form({ client_id: 'nope' }), `192.0.2.${++i}`);
    await spend(oauth, '/authorize', forged, from(PUBLIC_PEER), max);
    assert.equal((await oauth.request('/authorize', forged(), from(PUBLIC_PEER))).status, 429);
  });

  test('behind a trusted proxy, distinct client addresses keep separate counters', async () => {
    const { max } = OAUTH_LIMITS.authorize;
    const asClient = (ip: string) => () => withXff(form({ client_id: 'nope' }), ip);
    await spend(oauth, '/authorize', asClient('198.51.100.20'), from(PROXY_PEER), max);
    assert.equal((await oauth.request('/authorize', asClient('198.51.100.20')(), from(PROXY_PEER))).status, 429);
    assert.equal((await oauth.request('/authorize', asClient('198.51.100.21')(), from(PROXY_PEER))).status, 400);
  });

  test('behind a trusted proxy, client-prepended X-Forwarded-For entries are ignored', async () => {
    const { max } = OAUTH_LIMITS.authorize;
    let i = 0;
    // An appending proxy puts the real peer last; whatever the client sent sits before it.
    const prepended = () => withXff(form({ client_id: 'nope' }), `192.0.2.${++i}, 198.51.100.30`);
    await spend(oauth, '/authorize', prepended, from(PROXY_PEER), max);
    assert.equal((await oauth.request('/authorize', prepended(), from(PROXY_PEER))).status, 429);
  });

  test('isTrustedProxyPeer accepts loopback/private/ULA and rejects public or reserved look-alikes', () => {
    assert.equal(isTrustedProxyPeer('172.18.0.1'), true);
    assert.equal(isTrustedProxyPeer('127.0.0.1'), true);
    assert.equal(isTrustedProxyPeer('::1'), true);
    assert.equal(isTrustedProxyPeer('fd00::1'), true);
    assert.equal(isTrustedProxyPeer('203.0.113.7'), false);
    assert.equal(isTrustedProxyPeer('172.32.0.1'), false);
    assert.equal(isTrustedProxyPeer('2001:db8::1'), false);
    assert.equal(isTrustedProxyPeer('fe80::1%eth0'), true);
    // 0x00fc / 0x0fe8 first hextets: not ULA or link-local.
    assert.equal(isTrustedProxyPeer('fc::1'), false);
    assert.equal(isTrustedProxyPeer('fe8::1'), false);
  });

  test('a ::ffff:-mapped proxy peer reads X-Forwarded-For like the plain address', async () => {
    const { max } = OAUTH_LIMITS.authorize;
    const asClient = (ip: string) => () => withXff(form({ client_id: 'nope' }), ip);
    await spend(oauth, '/authorize', asClient('198.51.100.40'), from(`::ffff:${PROXY_PEER}`), max);
    assert.equal((await oauth.request('/authorize', asClient('198.51.100.40')(), from(`::ffff:${PROXY_PEER}`))).status, 429);
    assert.equal((await oauth.request('/authorize', asClient('198.51.100.41')(), from(`::ffff:${PROXY_PEER}`))).status, 400);
  });

  test('without a socket every request shares one counter', async () => {
    const { max } = OAUTH_LIMITS.authorize;
    let i = 0;
    const forged = () => withXff(form({ client_id: 'nope' }), `192.0.2.${++i}`);
    await spend(oauth, '/authorize', forged, {}, max);
    assert.equal((await oauth.request('/authorize', forged(), {})).status, 429);
  });
});

describe('global failed-login cap (D26)', () => {
  let oauth: OAuth;
  let clientId: string;

  before(() => initDatabase());
  after(() => closeDatabase());
  beforeEach(async () => {
    oauth = createOAuthRoutes();
    clientId = await register(oauth);
  });

  // One address per attempt, so no per-address limit is ever reached: what
  // rotating IPv6 addresses buys an attacker.
  const rotating = (n: number) => from(`2001:db8::${n.toString(16)}`);

  test('wrong passwords from rotating addresses lock POST /authorize for everyone', async () => {
    const { max } = OAUTH_LIMITS.loginFailures;
    for (let n = 1; n <= max; n++) {
      assert.equal((await oauth.request('/authorize', login(clientId, 'wrong'), rotating(n))).status, 401);
    }
    // Fresh address, correct password: refused while the cap holds.
    assert.equal((await oauth.request('/authorize', login(clientId, PASSWORD), rotating(max + 1))).status, 429);
    // /token is not locked, so existing sessions can still refresh.
    const token = await oauth.request('/token', form({ grant_type: 'refresh_token', refresh_token: 'nope' }), rotating(max + 2));
    assert.notEqual(token.status, 429);
  });

  test('concurrent wrong passwords cannot overrun the cap', async () => {
    const { max } = OAUTH_LIMITS.loginFailures;
    const burst = await Promise.all(Array.from({ length: max * 5 }, (_, i) =>
      oauth.request('/authorize', login(clientId, 'wrong'), rotating(i + 1))));
    const evaluated = burst.filter((r) => r.status === 401).length;
    assert.equal(evaluated, max, `passwords evaluated in a ${max * 5}-request burst`);
    assert.ok(burst.every((r) => r.status === 401 || r.status === 429));
  });

  test('control: below the cap a correct password still logs in', async () => {
    const { max } = OAUTH_LIMITS.loginFailures;
    for (let n = 1; n < max; n++) {
      assert.equal((await oauth.request('/authorize', login(clientId, 'wrong'), rotating(n))).status, 401);
    }
    assert.equal((await oauth.request('/authorize', login(clientId, PASSWORD), rotating(max))).status, 302);
  });

  test('requests refused before the password check do not count as failed logins', async () => {
    const { max } = OAUTH_LIMITS.loginFailures;
    for (let n = 1; n <= max + 5; n++) {
      assert.equal((await oauth.request('/authorize', form({ client_id: 'nope' }), rotating(n))).status, 400);
    }
    assert.equal((await oauth.request('/authorize', login(clientId, PASSWORD), rotating(max + 6))).status, 302);
  });
});

describe('OAuth body cap (D26)', () => {
  let oauth: OAuth;

  before(() => initDatabase());
  after(() => closeDatabase());
  beforeEach(() => { oauth = createOAuthRoutes(); });

  const big = 'x'.repeat(OAUTH_BODY_LIMIT_BYTES + 1);

  for (const path of ['/register', '/authorize', '/token']) {
    test(`POST ${path} refuses a body over the cap`, async () => {
      const res = await oauth.request(path, form({ pad: big }), from(PUBLIC_PEER));
      assert.equal(res.status, 413);
    });

    test(`POST ${path} refuses an over-cap body sent without Content-Length`, async () => {
      const bytes = new TextEncoder().encode(new URLSearchParams({ pad: big }).toString());
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      });
      const res = await oauth.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: stream,
        duplex: 'half',
      } as RequestInit, from(PUBLIC_PEER));
      assert.equal(res.status, 413);
    });
  }

  test('control: a body under the cap reaches the handler', async () => {
    const res = await oauth.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'x'.repeat(OAUTH_BODY_LIMIT_BYTES - 200) }),
    }, from(PUBLIC_PEER));
    assert.equal(res.status, 201);
  });
});
