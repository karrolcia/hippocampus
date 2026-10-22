import { Hono } from 'hono';
import { html } from 'hono/html';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import type { Context, Next } from 'hono';
import { config } from '../config.js';
import {
  registerClient, getClient,
  createAuthCode, getAuthCode, deleteAuthCode,
  createToken, getToken, deleteToken,
  deleteExpiredOAuthData,
} from '../db/oauth.js';
import { createRateLimiter, createFailureCounter } from '../middleware/rate-limit.js';

const ACCESS_TOKEN_TTL = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL = 5 * 60 * 1000; // 5 minutes

// Pre-auth limits on the OAuth routes (D26). Login-shaped: a small budget per
// client address over a long window, far below /mcp's 60 a minute. Hard-coded,
// not env: compose forwards an unset var as "", which z.coerce.number() reads
// as 0, and a limit of 0 refuses every login.
export const OAUTH_LIMITS = {
  authorize: { max: 10, windowMs: 15 * 60 * 1000 },
  token: { max: 30, windowMs: 15 * 60 * 1000 },
  register: { max: 10, windowMs: 60 * 60 * 1000 },
  // Wrong passwords across ALL addresses. Per-address limits alone are beaten
  // by rotating addresses. While tripped, POST /authorize refuses everyone,
  // the owner included, and an attacker can keep it tripped indefinitely;
  // /token keeps working and rotates the refresh token, so connected clients
  // never need the form. Only new connectors are blocked.
  loginFailures: { max: 20, windowMs: 60 * 60 * 1000 },
} as const;

// Checked before any OAuth handler parses a body. These bodies are a few
// hundred bytes; nothing else bounds a pre-auth request (no Caddy
// request_body limit, and @hono/node-server does not cap the body).
export const OAUTH_BODY_LIMIT_BYTES = 16 * 1024;

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function createOAuthRoutes(): Hono {
  const oauth = new Hono();

  // Per-instance state, so each createOAuthRoutes() starts with clean counters.
  const authorizeLimit = createRateLimiter(OAUTH_LIMITS.authorize.max, OAUTH_LIMITS.authorize.windowMs);
  const tokenLimit = createRateLimiter(OAUTH_LIMITS.token.max, OAUTH_LIMITS.token.windowMs);
  const registerLimit = createRateLimiter(OAUTH_LIMITS.register.max, OAUTH_LIMITS.register.windowMs);
  const loginFailures = createFailureCounter(OAUTH_LIMITS.loginFailures.max, OAUTH_LIMITS.loginFailures.windowMs);
  const bodyCap = bodyLimit({
    maxSize: OAUTH_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: 'invalid_request', error_description: 'Request body too large' }, 413),
  });
  const loginLockout = async (c: Context, next: Next) => {
    const retryAfter = loginFailures.blocked();
    if (retryAfter !== null) {
      return c.json({ error: 'Too many failed logins', retryAfter }, 429);
    }
    await next();
  };

  // Resource metadata (RFC 9470)
  oauth.get('/.well-known/oauth-protected-resource/mcp', (c) => {
    return c.json({
      resource: config.oauthIssuer,
      authorization_servers: [config.oauthIssuer],
      bearer_methods_supported: ['header'],
    });
  });

  // Authorization server metadata (RFC 8414)
  oauth.get('/.well-known/oauth-authorization-server', (c) => {
    const issuer = config.oauthIssuer!;
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  // Dynamic client registration (RFC 7591)
  oauth.post('/register', registerLimit, bodyCap, async (c) => {
    const body = await c.req.json();
    const clientId = randomUUID();
    const redirectUris = body.redirect_uris || [];

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' }, 400);
    }

    registerClient(clientId, redirectUris, body.client_name);

    return c.json({
      client_id: clientId,
      redirect_uris: redirectUris,
      client_name: body.client_name,
      token_endpoint_auth_method: 'none',
    }, 201);
  });

  // Authorization endpoint
  oauth.get('/authorize', (c) => {
    const clientId = c.req.query('client_id');
    const redirectUri = c.req.query('redirect_uri');
    const codeChallenge = c.req.query('code_challenge');
    const codeChallengeMethod = c.req.query('code_challenge_method');
    const state = c.req.query('state');

    const client = clientId ? getClient(clientId) : undefined;
    if (!clientId || !client) {
      return c.json({ error: 'invalid_request', error_description: 'Unknown client_id' }, 400);
    }

    if (codeChallengeMethod !== 'S256') {
      return c.json({ error: 'invalid_request', error_description: 'Only S256 code_challenge_method supported' }, 400);
    }

    if (!codeChallenge || !redirectUri) {
      return c.json({ error: 'invalid_request', error_description: 'code_challenge and redirect_uri required' }, 400);
    }

    if (!client.redirect_uris.includes(redirectUri)) {
      return c.json({ error: 'invalid_request', error_description: 'redirect_uri not registered' }, 400);
    }

    // Render simple login form. Built with `html`, which escapes every
    // interpolation: `state` and `code_challenge` are not validated at all, and
    // `/register` is open, so `redirect_uri` is whatever any caller registered.
    // A plain template literal here was a reflected XSS on the password form.
    return c.html(html`<!DOCTYPE html>
<html><head><title>Hippocampus — Authorize</title>
<style>body{font-family:system-ui;max-width:400px;margin:80px auto;padding:0 20px}
h1{font-size:1.4em}input{width:100%;padding:8px;margin:6px 0;box-sizing:border-box}
button{padding:10px 24px;background:#333;color:white;border:none;cursor:pointer;margin-top:10px}</style></head>
<body><h1>Hippocampus</h1><p>Authorize access to your memory server.</p>
<form method="POST" action="/authorize">
<input type="hidden" name="client_id" value="${clientId}">
<input type="hidden" name="redirect_uri" value="${redirectUri}">
<input type="hidden" name="code_challenge" value="${codeChallenge}">
<input type="hidden" name="state" value="${state || ''}">
<label>Username<input type="text" name="username" required></label>
<label>Password<input type="password" name="password" required></label>
<button type="submit">Authorize</button>
</form></body></html>`);
  });

  oauth.post('/authorize', loginLockout, authorizeLimit, bodyCap, async (c) => {
    const body = await c.req.parseBody();
    const clientId = body['client_id'] as string;
    const redirectUri = body['redirect_uri'] as string;
    const codeChallenge = body['code_challenge'] as string;
    const state = body['state'] as string;
    const username = body['username'] as string;
    const password = body['password'] as string;

    // Re-check what GET /authorize checked. This POST is the request that
    // issues the code, and nothing ties it to a GET that validated the pair.
    const client = clientId ? getClient(clientId) : undefined;
    if (!client || !redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return c.json({ error: 'invalid_request', error_description: 'Unknown client_id or unregistered redirect_uri' }, 400);
    }

    // Verify credentials
    if (!config.oauthUser || !config.oauthPasswordHash) {
      return c.json({ error: 'server_error', error_description: 'OAuth credentials not configured' }, 500);
    }

    // Re-check here, not only in loginLockout: requests in flight together all
    // passed that check before any of them recorded a failure (the hunter
    // review sent 200 concurrently and all 200 were evaluated). From this line
    // to record() the code is synchronous, so check and increment are atomic.
    const retryAfter = loginFailures.blocked();
    if (retryAfter !== null) {
      return c.json({ error: 'Too many failed logins', retryAfter }, 429);
    }

    const passwordHash = sha256(password);
    const expectedHash = config.oauthPasswordHash;
    const hashesMatch = passwordHash.length === expectedHash.length &&
      timingSafeEqual(Buffer.from(passwordHash), Buffer.from(expectedHash));

    if (username !== config.oauthUser || !hashesMatch) {
      loginFailures.record();
      return c.html('<html><body><h1>Invalid credentials</h1><a href="javascript:history.back()">Try again</a></body></html>', 401);
    }

    // Generate auth code
    const code = randomUUID();
    createAuthCode(code, clientId, codeChallenge, redirectUri, Date.now() + AUTH_CODE_TTL);

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);

    return c.redirect(redirect.toString());
  });

  // Token endpoint
  oauth.post('/token', tokenLimit, bodyCap, async (c) => {
    const body = await c.req.parseBody();
    const grantType = body['grant_type'] as string;

    if (grantType === 'authorization_code') {
      const code = body['code'] as string;
      const codeVerifier = body['code_verifier'] as string;
      const redirectUri = body['redirect_uri'] as string;

      const authCode = getAuthCode(code);
      if (!authCode) {
        return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }, 400);
      }

      // Verify PKCE
      const computedChallenge = sha256(codeVerifier);
      if (computedChallenge !== authCode.code_challenge) {
        return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      }

      if (authCode.redirect_uri !== redirectUri) {
        return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
      }

      if (Date.now() > authCode.expires_at) {
        deleteAuthCode(code);
        return c.json({ error: 'invalid_grant', error_description: 'Authorization code expired' }, 400);
      }

      // Single-use: delete auth code
      deleteAuthCode(code);

      // Issue tokens
      const accessToken = randomUUID();
      const refreshToken = randomUUID();

      createToken(accessToken, 'access', authCode.client_id, null, Date.now() + ACCESS_TOKEN_TTL);
      createToken(refreshToken, 'refresh', authCode.client_id, accessToken, Date.now() + REFRESH_TOKEN_TTL);

      return c.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL / 1000,
        refresh_token: refreshToken,
      });
    }

    if (grantType === 'refresh_token') {
      const oldRefreshToken = body['refresh_token'] as string;
      const stored = getToken(oldRefreshToken, 'refresh');

      if (!stored || Date.now() > stored.expires_at) {
        if (stored) deleteToken(oldRefreshToken);
        return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }, 400);
      }

      // Rotation: invalidate old tokens
      deleteToken(oldRefreshToken);
      if (stored.linked_token) deleteToken(stored.linked_token);

      // Issue new tokens
      const newAccessToken = randomUUID();
      const newRefreshToken = randomUUID();

      createToken(newAccessToken, 'access', stored.client_id, null, Date.now() + ACCESS_TOKEN_TTL);
      createToken(newRefreshToken, 'refresh', stored.client_id, newAccessToken, Date.now() + REFRESH_TOKEN_TTL);

      return c.json({
        access_token: newAccessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL / 1000,
        refresh_token: newRefreshToken,
      });
    }

    return c.json({ error: 'unsupported_grant_type' }, 400);
  });

  return oauth;
}

// Constant-time comparison of candidate token against a configured secret.
// Returns false if either is missing or lengths differ; always runs a
// timingSafeEqual on equal-length buffers to avoid length-based leaks
// once past the length gate.
function matchesAgentToken(candidate: string): boolean {
  if (!config.agentToken) return false;
  // HIPPO_AGENT_TOKEN may be a comma-separated LIST, so multiple self-hosted
  // agents (e.g. the loops box + the Mac) can each hold an independently-
  // revocable token: revoke one by removing its entry + redeploying, without
  // rotating the others. A single token (no comma) is the one-element case, so
  // this is backward-compatible. Each entry is compared in constant time;
  // entries below the 32-char floor are ignored (never match).
  const a = Buffer.from(candidate);
  for (const raw of config.agentToken.split(',')) {
    const tok = raw.trim();
    if (tok.length < 32) continue;
    const b = Buffer.from(tok);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

// Bearer token verification middleware.
//
// Accepts either:
//  (a) an OAuth 2.1 access token issued by this server (production path,
//      used by Claude.ai and other MCP clients that run the full flow), or
//  (b) a static agent bearer token configured via HIPPO_AGENT_TOKEN
//      (machine-to-machine path for self-hosted scheduled agents on the
//      owner's own infrastructure — no OAuth dance, constant-time compare).
//
// Agent token check runs last so OAuth clients are unaffected. If neither
// matches, returns 401 with the appropriate WWW-Authenticate header.
//
// When OAuth is not configured at all (legacy single-token mode), the
// original HIPPO_TOKEN path is preserved for backward compat.
export function bearerAuth() {
  return async (c: Context, next: Next) => {
    // Legacy mode: no OAuth, check HIPPO_TOKEN only
    if (!config.oauthIssuer) {
      if (config.token) {
        const auth = c.req.header('Authorization');
        if (!auth || auth !== `Bearer ${config.token}`) {
          return c.json({ error: 'unauthorized', error_description: 'Invalid or missing token' }, 401);
        }
      }
      return next();
    }

    const auth = c.req.header('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'unauthorized', error_description: 'Bearer token required' }, 401);
    }

    const token = auth.slice(7);

    // Try OAuth access token first (primary path for MCP clients)
    const stored = getToken(token, 'access');
    if (stored) {
      if (Date.now() > stored.expires_at) {
        deleteToken(token);
        c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
        return c.json({ error: 'invalid_token', error_description: 'Token expired' }, 401);
      }
      return next();
    }

    // Fall back to agent token (machine-to-machine path)
    if (matchesAgentToken(token)) {
      return next();
    }

    c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
    return c.json({ error: 'invalid_token', error_description: 'Unknown or expired token' }, 401);
  };
}

// Cleanup expired entries periodically. Unref so the interval does not
// keep the Node event loop alive (tests and scripts can exit cleanly).
const cleanupInterval = setInterval(() => {
  deleteExpiredOAuthData();
}, 10 * 60 * 1000);
cleanupInterval.unref();
