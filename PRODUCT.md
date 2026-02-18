# Hippocampus — Universal Memory for AI

## One-liner

Your AI shouldn't forget who you are just because you switched apps.

## What It Is

An open-source, self-hosted MCP memory server. One server, every AI platform.

You deploy it once. Connect it to Claude, ChatGPT, Gemini, Cursor, Perplexity — anything that speaks MCP. Tell one AI about a project decision, and every other AI already knows.

## Why It Matters

Every AI platform silos your context:
- Claude.ai memory doesn't work in Claude Code
- Claude Code's CLAUDE.md files don't work in ChatGPT
- ChatGPT's memory doesn't work in Gemini
- None of them talk to each other

You repeat yourself constantly. Context gets lost. Continuity breaks every time you switch tools.

Hippocampus is the memory layer that sits behind all of them.

## How It Works

```
Claude.ai (browser) ──┐
Claude.ai (mobile) ───┤
Claude Code ───────────┤
Claude Desktop ────────┤                    ┌──────────────────┐
ChatGPT (web/mobile) ──┼── Remote MCP ─────▶│   Hippocampus    │
ChatGPT API ───────────┤                    │                  │
Gemini CLI ────────────┤                    │  Your memories   │
Cursor / Windsurf ─────┤                    │  Your knowledge  │
Perplexity ────────────┘                    │  Your context    │
                                            └──────────────────┘
```

MCP (Model Context Protocol) is the open standard every major AI platform has adopted. Hippocampus is a remote MCP server that exposes memory tools. Any AI that supports MCP can connect.

## Platform Compatibility (February 2026)

| Platform | Remote MCP | Status |
|----------|-----------|--------|
| Claude.ai (browser + mobile) | ✅ | Custom connector |
| Claude Code | ✅ | `claude mcp add` |
| Claude Desktop | ✅ | Config file |
| ChatGPT (web + mobile) | ✅ | Developer Mode → Apps |
| ChatGPT API | ✅ | `server_url` in tools |
| Gemini CLI | ✅ | OAuth-compatible config |
| Gemini in Android Studio | ✅ | Settings → MCP Servers |
| Cursor / Windsurf / VS Code | ✅ | MCP config files |
| Perplexity Mac | ⚠️ | Local MCP now, remote coming soon |

## Technical Architecture

### Stack
- **Runtime:** Node.js 18+
- **MCP SDK:** `@modelcontextprotocol/sdk` (official TypeScript SDK)
- **Transport:** Streamable HTTP on `/mcp`
- **Framework:** Hono (lightweight, works with MCP middleware)
- **Database:** SQLite via `better-sqlite3-multiple-ciphers` (encrypted with SQLCipher, AES-256)
- **Embeddings:** Local via `@xenova/transformers` (all-MiniLM-L6-v2, ~80MB, no API key needed)
- **Auth:** OAuth 2.1 with PKCE (MCP standard, self-contained for single user)

### Data Model

Knowledge graph: entities → observations → relationships.

```sql
-- Entities: people, projects, concepts, preferences
entities (id, name, type, created_at, updated_at)

-- Observations: facts about entities (append-only log)
observations (id, entity_id, content, source, created_at)

-- Relationships: connections between entities
relationships (id, from_entity, to_entity, relation_type, created_at)

-- Embeddings: vector representations for semantic search
embeddings (id, entity_id, observation_id, vector, text_content, created_at)
```

Entire database encrypted at rest. Embeddings included — research shows original text can be reconstructed from embedding vectors.

### MCP Tools

```
remember(content, entity?, type?, source?)
  → Store new information. Claude structures it naturally.

recall(query, limit?, type?, since?)
  → Search memories by semantic similarity.

forget(entity?, observation_id?)
  → Remove a memory. Uses secure deletion (zeros freed pages).

update(entity, old_content, new_content)
  → Modify an existing memory.

context(topic, depth?)
  → Graph traversal. Get everything about a topic + related entities.

export(format: 'claude-md' | 'markdown' | 'json', filter?)
  → Generate CLAUDE.md or structured export from memories.
```

### File Structure

```
hippocampus/
├── src/
│   ├── index.ts              # Hono server, MCP transport
│   ├── mcp/
│   │   ├── server.ts         # MCP server, tool registration
│   │   └── tools/            # remember, recall, forget, update, context, export
│   ├── db/
│   │   ├── schema.ts         # SQLCipher schema + migrations
│   │   ├── entities.ts       # Entity CRUD
│   │   ├── observations.ts   # Observation CRUD
│   │   └── relationships.ts  # Relationship CRUD
│   ├── embeddings/
│   │   └── embedder.ts       # Local embedding generation + search
│   └── auth/
│       └── oauth.ts          # Self-contained OAuth 2.1 server
├── Dockerfile
├── docker-compose.yml
├── Caddyfile                 # Reverse proxy config
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Self-Hosting

### Recommended: Hetzner VPS (€4/month)

EU jurisdiction (GDPR), Helsinki or Stockholm datacenter, professional infrastructure. Database encrypted with SQLCipher — even if someone stole the raw disk, they get nothing without your passphrase.

### Other options
- **Fly.io** (~$5/mo) — easiest deploy, `fly launch` and done
- **Home server + Cloudflare Tunnel** — free, maximum hardware control
- **Railway / Render** — simple, good for getting started

See SECURITY.md for full comparison and detailed setup instructions.

## Revenue Model

**Open source. Free forever. Donations welcome.**

No hosted version. No SaaS. No customer support obligations. No liability for other people's data.

Stripe Payment Link in the README: "If Hippocampus is useful, buy me a coffee." One-time donations, not subscriptions.

## Development Plan

### Day 1: Core server + remember/recall
- Hono + MCP SDK + Streamable HTTP transport
- SQLCipher encrypted database + entity/observation CRUD
- `remember` and `recall` tools (keyword search first)
- Docker setup
- Test with Claude Code locally

### Day 2: Semantic search + remaining tools
- Local embeddings (`@xenova/transformers`)
- Semantic `recall`
- `forget`, `update`, `context` tools
- OAuth 2.1 implementation
- Test from claude.ai as custom connector

### Day 3: Export + cross-platform + polish
- `export` tool (CLAUDE.md generation)
- Test from ChatGPT, Gemini CLI
- Write README with self-hosting guide
- Push to GitHub

## Differentiation

Nobody else is building this:
- **Claude.ai native memory** — Claude only. Doesn't work in Claude Code, ChatGPT, or anything else.
- **ChatGPT memory** — ChatGPT only. Siloed.
- **CLAUDE.md files** — Claude Code only. Local files on disk.
- **Mem0** — Local MCP server. Doesn't work across platforms.
- **Hippocampus** — One server, every AI platform, knowledge graph with semantic search, self-hosted and encrypted.

## Name

The hippocampus is the part of the brain that forms new memories, consolidates them, and maps relationships between concepts. It's how you navigate both physical space and conceptual space.

`hippocampus` as the repo. `hippo` as the CLI shorthand.
