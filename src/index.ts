import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { config } from './config.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { createMcpServer } from './mcp/server.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createOAuthRoutes, bearerAuth } from './auth/oauth.js';
import { backfillEmbeddings } from './embeddings/embedder.js';

const app = new Hono();

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
  return c.json({ status: 'ok', version: '0.1.0' });
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

// MCP Streamable HTTP transport
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

app.all('/mcp', async (c) => {
  const sessionId = c.req.header('mcp-session-id');

  // For existing sessions, reuse the transport
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    return transport.handleRequest(c.req.raw);
  }

  // For new sessions or initialization, create a new transport + server
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (newSessionId) => {
      transports.set(newSessionId, transport);
    },
    onsessionclosed: (closedSessionId) => {
      transports.delete(closedSessionId);
    },
  });

  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
  return transport.handleRequest(c.req.raw);
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
