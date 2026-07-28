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
import { backfillEmbeddings } from './embeddings/embedder.js';

const app = new Hono();
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

// Initialize database
initDatabase();

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

app.all('/mcp', async (c) => {
  const sessionId = c.req.header('mcp-session-id');

  // Existing session: reuse its transport, stamp it active + in-flight so the
  // sweep and LRU backstop can't evict it mid-request.
  if (sessionId) {
    const transport = sessions.touch(sessionId);
    if (transport) {
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
  const mcpServer = createMcpServer();
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

serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.host,
});

// Backfill embeddings for any observations from v1 that lack them
backfillEmbeddings().catch((err) => {
  console.error('Embedding backfill failed:', err instanceof Error ? err.message : err);
});
