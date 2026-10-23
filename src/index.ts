import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { config, VERSION } from './config.js';
import { initDatabase, closeDatabase, getDatabase } from './db/index.js';
import { createMcpServer } from './mcp/server.js';
import { SessionRegistry } from './mcp/session-registry.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createOAuthRoutes, bearerAuth } from './auth/oauth.js';
import type { Scope } from './auth/scopes.js';
import { backfillEmbeddings } from './embeddings/embedder.js';

// Exported for tests (driven via app.request()); the server itself only
// starts when this file is the entrypoint — see the main-module block below.
export const app = new Hono();
const startedAt = Date.now();

// MCP sessions accumulate one retained McpServer each unless idle ones are
// evicted server-side (the SDK only drops a session on an explicit client
// DELETE, which Claude.ai and most clients never send). See session-registry.ts
// for the full rationale and the 2026-07-17 OOM this prevents.
const SESSION_IDLE_MS = 30 * 60 * 1000; // evict sessions idle longer than this
const SESSION_SWEEP_MS = 5 * 60 * 1000; // idle-sweep cadence
const MAX_SESSIONS = 1000; // hard backstop against burst growth
const sessions = new SessionRegistry<WebStandardStreamableHTTPServerTransport>({
  idleMs: SESSION_IDLE_MS,
  maxSessions: MAX_SESSIONS,
});

// CORS for AI platform origins
app.use(
  '*',
  cors({
    origin: [
      'https://claude.ai',
      'https://chat.openai.com',
      'https://gemini.google.com',
    ],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'mcp-session-id', 'mcp-protocol-version'],
    exposeHeaders: ['mcp-session-id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    credentials: true,
  })
);

// Health check
app.get('/health', (c) => {
  let dbStatus = 'ok';
  try {
    const db = getDatabase();
    db.prepare('SELECT 1').get();
  } catch {
    dbStatus = 'error';
  }

  const mem = process.memoryUsage();
  const body = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    db: dbStatus,
    memory_mb: Math.round(mem.rss / 1024 / 1024),
    sessions: sessions.size,
  };

  return c.json(body, dbStatus === 'ok' ? 200 : 503);
});

// Mount OAuth routes when configured
if (config.oauthIssuer) {
  const oauthRoutes = createOAuthRoutes();
  app.route('/', oauthRoutes);
  console.log('OAuth 2.1 enabled');
}

// Rate limiting for MCP endpoint
app.use('/mcp', createRateLimiter(config.rateLimitRecall));

// Bearer token verification on /mcp
app.use('/mcp', bearerAuth());

// MCP Streamable HTTP transport.
//
// Periodic idle sweep: evict sessions with no activity within the TTL. unref()
// so the timer never keeps the process alive on its own.
const sessionSweep = setInterval(() => sessions.sweep(), SESSION_SWEEP_MS);
sessionSweep.unref();

// The scope each session was created under (D28). A session's McpServer has
// its tool set fixed at creation, so a request presenting that session's id
// must carry the same scope — otherwise a read-only token holding a full
// session's id would drive the full tool set. The binding is per SCOPE, not per
// credential: two tokens of one scope can share a session (no privilege
// changes), and an OAuth client keeps its session across an access-token
// refresh, which a per-credential binding would break every hour. Keyed on the transport object so
// an evicted session's entry goes with it; no second registry to keep in step.
const sessionScopes = new WeakMap<WebStandardStreamableHTTPServerTransport, Scope>();

app.all('/mcp', async (c) => {
  const sessionId = c.req.header('mcp-session-id');
  const scope = c.get('scope');
  if (!scope) {
    // bearerAuth sets a scope on every request it lets through. Reaching here
    // without one means the middleware chain changed; refuse rather than guess.
    return c.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'No authorization scope resolved' }, id: null },
      500
    );
  }

  // Existing session: reuse its transport, stamp it active + in-flight so the
  // sweep and LRU backstop can't evict it mid-request.
  if (sessionId) {
    // peek, not touch: the scope check below may refuse, and a refused
    // request must not refresh the session's idle timer or LRU position.
    const transport = sessions.peek(sessionId);
    if (transport) {
      if (sessionScopes.get(transport) !== scope) {
        // 403, not 404: 404 tells a client to silently re-initialize, and
        // this is a credential mismatch, not a stale session.
        return c.json(
          {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session was created under a different token scope' },
            id: null,
          },
          403
        );
      }
      sessions.touch(sessionId);
      sessions.setInFlight(sessionId, 1);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        sessions.setInFlight(sessionId, -1);
      }
    }
    // Unknown or evicted session id: the MCP Streamable HTTP spec requires
    // 404 here — that's the signal clients re-initialize on. Falling through
    // to a fresh transport instead yields 400 "Server not initialized",
    // which clients treat as fatal, so every idle-swept or restart-orphaned
    // session stayed permanently broken.
    return c.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
      404
    );
  }

  // New session (or initialization): create a transport + server.
  const mcpServer = createMcpServer(scope);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (newSessionId) => {
      sessions.register(newSessionId, transport);
    },
    onsessionclosed: (closedSessionId) => {
      sessions.close(closedSessionId);
    },
  });
  // Any close path (client DELETE, error, our idle sweep) drops the map entry
  // so the session/server island can be garbage-collected.
  transport.onclose = () => {
    if (transport.sessionId) sessions.drop(transport.sessionId);
  };

  sessionScopes.set(transport, scope);
  await mcpServer.connect(transport);
  return transport.handleRequest(c.req.raw);
});

// JSON 404 for unmatched routes — the MCP SDK's OAuth client calls
// parseErrorResponse(response) on non-OK responses and expects JSON.
// Hono's default 404 returns an empty body, which makes JSON.parse("")
// throw "SyntaxError: Unexpected EOF", surfacing as the confusing
// "Invalid OAuth error response" message in every MCP client.
app.notFound((c) => {
  return c.json({ error: 'not_found', error_description: 'Not found' }, 404);
});

// Startup side effects (DB init, signal handlers, listener, backfill) only run
// when this file is the entrypoint — `node dist/index.js` in Docker, `tsx watch
// src/index.ts` in dev. Tests import { app } without starting a server.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  initDatabase();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('Shutting down...');
    closeDatabase();
    process.exit(0);
  });

  // Start server
  console.log(`Hippocampus starting on http://${config.host}:${config.port}`);
  console.log(`MCP endpoint: http://${config.host}:${config.port}/mcp`);
  // Config metadata only — never memory content. A typo'd separator collapses
  // the list to one garbage prefix and silently unprotects every log entity,
  // so the resolved list is printed where it can be eyeballed after a deploy.
  console.log(
    `Append-only entities (dedup exempt): ${
      config.appendOnlyPrefixes.length > 0 ? config.appendOnlyPrefixes.join(', ') : 'none'
    }`
  );

  serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  });

  // Backfill embeddings for any observations from v1 that lack them
  backfillEmbeddings().catch((err) => {
    console.error('Embedding backfill failed:', err instanceof Error ? err.message : err);
  });
}
