import { Hono } from 'hono';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import type { Context, Next } from 'hono';
import { config } from '../config.js';

// In-memory stores (single-user, no persistence needed)
const clients = new Map<string, { client_id: string; redirect_uris: string[]; client_name?: string }>();
const authCodes = new Map<string, { client_id: string; code_challenge: string; redirect_uri: string; expires_at: number }>();
const accessTokens = new Map<string, { client_id: string; expires_at: number }>();
const refreshTokens = new Map<string, { client_id: string; access_token: string; expires_at: number }>();

const ACCESS_TOKEN_TTL = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL = 5 * 60 * 1000; // 5 minutes

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function createOAuthRoutes(): Hono {
  const oauth = new Hono();

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
  oauth.post('/register', async (c) => {
    const body = await c.req.json();
    const clientId = randomUUID();
    const redirectUris = body.redirect_uris || [];

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' }, 400);
    }

    const client = {
      client_id: clientId,
      redirect_uris: redirectUris,
      client_name: body.client_name,
    };

    clients.set(clientId, client);

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

    if (!clientId || !clients.has(clientId)) {
      return c.json({ error: 'invalid_request', error_description: 'Unknown client_id' }, 400);
    }

    if (codeChallengeMethod !== 'S256') {
      return c.json({ error: 'invalid_request', error_description: 'Only S256 code_challenge_method supported' }, 400);
    }

    if (!codeChallenge || !redirectUri) {
      return c.json({ error: 'invalid_request', error_description: 'code_challenge and redirect_uri required' }, 400);
    }

    const client = clients.get(clientId)!;
    if (!client.redirect_uris.includes(redirectUri)) {
      return c.json({ error: 'invalid_request', error_description: 'redirect_uri not registered' }, 400);
    }

    // Render simple login form
    const html = `<!DOCTYPE html>
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
</form></body></html>`;
    return c.html(html);
  });

  oauth.post('/authorize', async (c) => {
    const body = await c.req.parseBody();
    const clientId = body['client_id'] as string;
    const redirectUri = body['redirect_uri'] as string;
    const codeChallenge = body['code_challenge'] as string;
    const state = body['state'] as string;
    const username = body['username'] as string;
    const password = body['password'] as string;

    // Verify credentials
    if (!config.oauthUser || !config.oauthPasswordHash) {
      return c.json({ error: 'server_error', error_description: 'OAuth credentials not configured' }, 500);
    }

    const passwordHash = sha256(password);
    const expectedHash = config.oauthPasswordHash;
    const hashesMatch = passwordHash.length === expectedHash.length &&
      timingSafeEqual(Buffer.from(passwordHash), Buffer.from(expectedHash));

    if (username !== config.oauthUser || !hashesMatch) {
      return c.html('<html><body><h1>Invalid credentials</h1><a href="javascript:history.back()">Try again</a></body></html>', 401);
    }

    // Generate auth code
    const code = randomUUID();
    authCodes.set(code, {
      client_id: clientId,
      code_challenge: codeChallenge,
      redirect_uri: redirectUri,
      expires_at: Date.now() + AUTH_CODE_TTL,
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);

    return c.redirect(redirect.toString());
  });

  // Token endpoint
  oauth.post('/token', async (c) => {
    const body = await c.req.parseBody();
    const grantType = body['grant_type'] as string;

    if (grantType === 'authorization_code') {
      const code = body['code'] as string;
      const codeVerifier = body['code_verifier'] as string;
      const redirectUri = body['redirect_uri'] as string;

      const authCode = authCodes.get(code);
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
        authCodes.delete(code);
        return c.json({ error: 'invalid_grant', error_description: 'Authorization code expired' }, 400);
      }

      // Single-use: delete auth code
      authCodes.delete(code);

      // Issue tokens
      const accessToken = randomUUID();
      const refreshToken = randomUUID();

      accessTokens.set(accessToken, {
        client_id: authCode.client_id,
        expires_at: Date.now() + ACCESS_TOKEN_TTL,
      });

      refreshTokens.set(refreshToken, {
        client_id: authCode.client_id,
        access_token: accessToken,
        expires_at: Date.now() + REFRESH_TOKEN_TTL,
      });

      return c.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL / 1000,
        refresh_token: refreshToken,
      });
    }

    if (grantType === 'refresh_token') {
      const oldRefreshToken = body['refresh_token'] as string;
      const stored = refreshTokens.get(oldRefreshToken);

      if (!stored || Date.now() > stored.expires_at) {
        if (stored) refreshTokens.delete(oldRefreshToken);
        return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }, 400);
      }

      // Rotation: invalidate old tokens
      refreshTokens.delete(oldRefreshToken);
      accessTokens.delete(stored.access_token);

      // Issue new tokens
      const newAccessToken = randomUUID();
      const newRefreshToken = randomUUID();

      accessTokens.set(newAccessToken, {
        client_id: stored.client_id,
        expires_at: Date.now() + ACCESS_TOKEN_TTL,
      });

      refreshTokens.set(newRefreshToken, {
        client_id: stored.client_id,
        access_token: newAccessToken,
        expires_at: Date.now() + REFRESH_TOKEN_TTL,
      });

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

// Bearer token verification middleware
export function bearerAuth() {
  return async (c: Context, next: Next) => {
    // If OAuth is not configured, check for simple token auth
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
    const stored = accessTokens.get(token);

    if (!stored) {
      c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      return c.json({ error: 'invalid_token', error_description: 'Unknown or expired token' }, 401);
    }

    if (Date.now() > stored.expires_at) {
      accessTokens.delete(token);
      c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      return c.json({ error: 'invalid_token', error_description: 'Token expired' }, 401);
    }

    return next();
  };
}

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCodes) {
    if (now > v.expires_at) authCodes.delete(k);
  }
  for (const [k, v] of accessTokens) {
    if (now > v.expires_at) accessTokens.delete(k);
  }
  for (const [k, v] of refreshTokens) {
    if (now > v.expires_at) refreshTokens.delete(k);
  }
}, 10 * 60 * 1000);
