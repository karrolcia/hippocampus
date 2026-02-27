import { getDatabase } from './index.js';

// --- Clients ---

export interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

export function registerClient(clientId: string, redirectUris: string[], clientName?: string): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR REPLACE INTO oauth_clients (client_id, redirect_uris, client_name) VALUES (?, ?, ?)'
  ).run(clientId, JSON.stringify(redirectUris), clientName ?? null);
}

export function getClient(clientId: string): OAuthClient | undefined {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT client_id, redirect_uris, client_name FROM oauth_clients WHERE client_id = ?'
  ).get(clientId) as { client_id: string; redirect_uris: string; client_name: string | null } | undefined;

  if (!row) return undefined;
  return {
    client_id: row.client_id,
    redirect_uris: JSON.parse(row.redirect_uris),
    client_name: row.client_name ?? undefined,
  };
}

// --- Auth Codes ---

export interface OAuthAuthCode {
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  expires_at: number;
}

export function createAuthCode(
  code: string, clientId: string, codeChallenge: string, redirectUri: string, expiresAt: number
): void {
  const db = getDatabase();
  db.prepare(
    'INSERT INTO oauth_auth_codes (code, client_id, code_challenge, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(code, clientId, codeChallenge, redirectUri, expiresAt);
}

export function getAuthCode(code: string): OAuthAuthCode | undefined {
  const db = getDatabase();
  return db.prepare(
    'SELECT client_id, code_challenge, redirect_uri, expires_at FROM oauth_auth_codes WHERE code = ?'
  ).get(code) as OAuthAuthCode | undefined;
}

export function deleteAuthCode(code: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM oauth_auth_codes WHERE code = ?').run(code);
}

// --- Tokens ---

export interface OAuthToken {
  client_id: string;
  linked_token: string | null;
  expires_at: number;
}

export function createToken(
  token: string, type: 'access' | 'refresh', clientId: string, linkedToken: string | null, expiresAt: number
): void {
  const db = getDatabase();
  db.prepare(
    'INSERT INTO oauth_tokens (token, token_type, client_id, linked_token, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(token, type, clientId, linkedToken, expiresAt);
}

export function getToken(token: string, type: 'access' | 'refresh'): OAuthToken | undefined {
  const db = getDatabase();
  return db.prepare(
    'SELECT client_id, linked_token, expires_at FROM oauth_tokens WHERE token = ? AND token_type = ?'
  ).get(token, type) as OAuthToken | undefined;
}

export function deleteToken(token: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM oauth_tokens WHERE token = ?').run(token);
}

// --- Cleanup ---

export function deleteExpiredOAuthData(): void {
  const db = getDatabase();
  const now = Date.now();
  db.prepare('DELETE FROM oauth_auth_codes WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(now);
}
