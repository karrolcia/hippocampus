# Hippocampus

Universal memory for AI. One server, every platform.

Your AI shouldn't forget who you are just because you switched apps.

---

Hippocampus is an open-source, self-hosted MCP memory server. Deploy it once. Connect it to Claude, ChatGPT, Gemini, Cursor, Perplexity — anything that speaks MCP. Tell one AI about a project decision, and every other AI already knows.

## The problem

Every AI platform silos your context:

- Claude.ai memory doesn't work in Claude Code
- Claude Code's CLAUDE.md files don't work in ChatGPT
- ChatGPT's memory doesn't work in Gemini
- None of them talk to each other

You repeat yourself constantly. Context gets lost. Continuity breaks every time you switch tools.

## How it works

```
Claude.ai ────────────┐
Claude Code ──────────┤
Claude Desktop ───────┤
ChatGPT ──────────────┼── MCP ──▶  Hippocampus
Gemini CLI ───────────┤            (your server)
Cursor / Windsurf ────┤
Perplexity ───────────┘
```

[MCP](https://modelcontextprotocol.io/) (Model Context Protocol) is the open standard every major AI platform has adopted. Hippocampus is a remote MCP server that exposes memory tools over Streamable HTTP. Any AI client that supports MCP can connect.

Data model: knowledge graph with entities, observations, and relationships. Semantic search via local embeddings. Entire database encrypted at rest with SQLCipher (AES-256) — including embedding vectors, which [leak original text](https://arxiv.org/abs/2305.03010).

## Tools

| Tool | Description |
|------|-------------|
| `remember` | Store a fact, preference, or piece of context |
| `recall` | Search memories by semantic similarity + keyword match |
| `context` | Get everything about a topic — observations, relationships, related entities |
| `update` | Replace an existing observation with new content |
| `forget` | Permanently delete a memory or entity (secure deletion) |
| `consolidate` | Find clusters of similar/duplicate memories for review |
| `export` | Export as CLAUDE.md context file, readable markdown, or JSON |

The AI calls these tools naturally. You don't manage memory manually — you just talk to your AI and it remembers.

## Quick start

### Prerequisites

- Node.js 18+ (or Docker)
- A passphrase for database encryption

### Local development

```bash
git clone https://github.com/karrolcia/hippocampus.git
cd hippocampus
npm install

# Create .env
cp .env.example .env
# Edit .env — set HIPPO_PASSPHRASE (required)

npm run dev
```

The server starts on `http://localhost:3000`. The embedding model (~80MB) downloads automatically on first run.

### Docker

```bash
git clone https://github.com/karrolcia/hippocampus.git
cd hippocampus

# Generate a passphrase and save it in your password manager
openssl rand -base64 32

# Create .env
cp .env.example .env
# Edit .env — set HIPPO_PASSPHRASE

docker compose up -d
```

This starts Hippocampus + Caddy (automatic HTTPS). Edit the `Caddyfile` to set your domain.

## Connecting AI platforms

### Claude Code

```bash
claude mcp add hippocampus --transport http https://hippo.yourdomain.com/mcp
```

For local development:

```bash
claude mcp add hippocampus --transport http http://localhost:3000/mcp
```

### Claude.ai

Settings > Integrations > Add custom integration > Enter your server URL: `https://hippo.yourdomain.com/mcp`

Requires OAuth — see [OAuth setup](#oauth-setup) below.

### Claude Desktop

Add to your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "hippocampus": {
      "url": "https://hippo.yourdomain.com/mcp"
    }
  }
}
```

### ChatGPT

Settings > Apps > Developer Mode > Create a new app > Set server URL to `https://hippo.yourdomain.com/mcp`

### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "hippocampus": {
      "uri": "https://hippo.yourdomain.com/mcp"
    }
  }
}
```

### Cursor / Windsurf / VS Code

Add to your MCP configuration file:

```json
{
  "mcpServers": {
    "hippocampus": {
      "url": "https://hippo.yourdomain.com/mcp"
    }
  }
}
```

## Self-hosting

Hippocampus is designed to run on a cheap VPS. The database is encrypted — even if someone steals the disk, they get nothing without your passphrase.

### Recommended: Hetzner VPS

EU jurisdiction (GDPR), Helsinki or Stockholm datacenter. CX22 instance (2 vCPU, 4GB RAM) costs ~4 EUR/month.

```bash
# SSH into your VPS

# Firewall
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable

# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone and deploy
git clone https://github.com/karrolcia/hippocampus.git
cd hippocampus

# Generate passphrase — SAVE THIS IN YOUR PASSWORD MANAGER
openssl rand -base64 32

# Configure
cp .env.example .env
# Edit .env: set HIPPO_PASSPHRASE, HIPPO_OAUTH_ISSUER, HIPPO_OAUTH_USER, HIPPO_OAUTH_PASSWORD_HASH
# Edit Caddyfile: replace memory.yourdomain.com with your domain

# Start
docker compose up -d
```

Caddy handles TLS certificates automatically via Let's Encrypt.

### Alternative: Fly.io (~$5/month)

```bash
git clone https://github.com/karrolcia/hippocampus.git && cd hippocampus
fly launch
fly secrets set HIPPO_PASSPHRASE=$(openssl rand -base64 32)
fly volumes create hippo_data --size 1
fly deploy
```

### Alternative: Home server + Cloudflare Tunnel

Free, maximum control. You're responsible for uptime and physical security. See [SECURITY.md](SECURITY.md) for trade-offs.

## OAuth setup

Remote MCP connections (Claude.ai, ChatGPT, Gemini) require OAuth 2.1. Hippocampus includes a self-contained OAuth server for single-user authentication.

```bash
# Generate a password hash
node -e "const{createHash}=require('crypto');console.log(createHash('sha256').update('your-password').digest('base64url'))"

# Add to .env
HIPPO_OAUTH_ISSUER=https://hippo.yourdomain.com
HIPPO_OAUTH_USER=your-username
HIPPO_OAUTH_PASSWORD_HASH=<output from above>
```

This enables:
- Dynamic Client Registration (AI platforms auto-register)
- Authorization Code Flow with PKCE
- Short-lived access tokens (1 hour) with refresh token rotation (30 days)

For local development without OAuth, set `HIPPO_TOKEN` in `.env` and pass it as a Bearer token.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HIPPO_PASSPHRASE` | Yes | — | Database encryption passphrase |
| `HIPPO_DB_PATH` | No | `./data/hippocampus.db` | Database file location |
| `PORT` | No | `3000` | Server port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `HIPPO_TOKEN` | No | — | Bearer token for local dev (skip OAuth) |
| `HIPPO_OAUTH_ISSUER` | No | — | Your server URL — enables OAuth |
| `HIPPO_OAUTH_USER` | No | — | OAuth login username |
| `HIPPO_OAUTH_PASSWORD_HASH` | No | — | SHA-256 hash of OAuth password |
| `RATE_LIMIT_REMEMBER` | No | `20` | Write rate limit per minute |
| `RATE_LIMIT_RECALL` | No | `60` | Read rate limit per minute |
| `TRANSFORMERS_CACHE` | No | System default | Embedding model cache directory |

## Security

- AES-256 database encryption via SQLCipher (text, embeddings, indexes — everything)
- OAuth 2.1 with PKCE for remote access
- Input validation: 2,000 char/memory, 200 char/entity name
- Rate limiting on all endpoints
- `PRAGMA secure_delete = ON` — forgotten memories are zeroed, not just unlinked
- Non-root Docker, `cap_drop: ALL`, read-only filesystem
- CORS restricted to known AI platform origins
- No external API calls — embeddings run locally via Transformers.js

See [SECURITY.md](SECURITY.md) for the full threat model and architecture.

## Architecture

```
src/
├── index.ts              # Hono server, MCP Streamable HTTP transport
├── config.ts             # Environment config with Zod validation
├── mcp/
│   ├── server.ts         # MCP tool registration (7 tools)
│   └── tools/            # remember, recall, forget, update, context, consolidate, export
├── db/
│   ├── index.ts          # SQLCipher initialization
│   ├── schema.ts         # Schema + migrations
│   ├── entities.ts       # Entity CRUD
│   ├── observations.ts   # Observation CRUD + keyword search
│   └── relationships.ts  # Relationship CRUD + BFS graph traversal
├── embeddings/
│   └── embedder.ts       # Local embeddings (all-MiniLM-L6-v2) + semantic search
└── auth/
    └── oauth.ts          # Self-contained OAuth 2.1 server
```

**Stack:** Node.js, TypeScript, Hono, MCP SDK, SQLCipher, Transformers.js

## Running tests

```bash
# Full end-to-end test suite (all 7 tools, real embeddings, temp encrypted DB)
HIPPO_PASSPHRASE=test HIPPO_DB_PATH=/tmp/hippo-test.db npx tsx test-all-tools.ts

# Export tool tests only
HIPPO_PASSPHRASE=test HIPPO_DB_PATH=/tmp/hippo-test-export.db npx tsx test-export.ts
```

## Platform compatibility

| Platform | Remote MCP | How to connect |
|----------|-----------|----------------|
| Claude.ai (browser + mobile) | Yes | Custom integration |
| Claude Code | Yes | `claude mcp add` |
| Claude Desktop | Yes | Config file |
| ChatGPT (web + mobile) | Yes | Developer Mode > Apps |
| ChatGPT API | Yes | `server_url` in tools |
| Gemini CLI | Yes | Settings file |
| Gemini in Android Studio | Yes | Settings > MCP Servers |
| Cursor / Windsurf / VS Code | Yes | MCP config file |
| Perplexity Mac | Partial | Local MCP support, remote coming |

## License

MIT

## Support

If Hippocampus is useful to you, [buy me a coffee](https://buy.stripe.com/placeholder).

Open source. Free forever. No hosted version. No SaaS.
