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
-- version_hash: SHA-256 of sorted observation content (cross-platform staleness detection)
entities (id, name, type, created_at, updated_at, version_hash, version_at)

-- Observations: facts about entities
-- kind: fact, decision, question, preference (or custom). Filterable.
-- importance: manual boost (0.0-1.0) for always-relevant facts
-- recall tracking: last_recalled_at + recall_count for decay-weighted retrieval
observations (id, entity_id, content, source, kind, importance, created_at,
             last_recalled_at, recall_count)

-- Relationships: connections between entities
relationships (id, from_entity, to_entity, relation_type, created_at)

-- Embeddings: vector representations for semantic search
embeddings (id, entity_id, observation_id, vector, text_content, created_at)
```

Schema V6 (current). Entire database encrypted at rest with SQLCipher. Embeddings included — research shows original text can be reconstructed from embedding vectors.

### MCP Tools (11)

```
remember(content, entity?, type?, source?, importance?, kind?)
  → Store a fact. Dedup on write (cosine >= 0.85), near-match detection (0.5-0.85),
    subspace novelty scoring via SVD. Returns version_hash.

recall(query, limit?, type?, since?, kind?, spread?, format?)
  → Semantic + keyword search. 4 formats (full/compact/wire/index).
    Spreading activation follows relationships 1 hop. Reconsolidation
    hints flag stale observations. Includes version_hash per entity.

forget(entity?, observation_id?)
  → Permanent deletion. PRAGMA secure_delete = ON — zeros freed pages.

update(entity, old_content, new_content)
  → Replace observation by exact content match. Returns version_hash.

merge(observation_ids, content)
  → Atomic consolidation. Replace N observations with one merged text.
    Returns version_hash.

merge_entities(source_entities, target_entity)
  → Structural consolidation. Moves all data, deletes sources.
    Returns version_hash.

context(topic, depth?)
  → Graph traversal. Entity + observations + relationships + related
    entities via BFS. Includes version_hash.

consolidate(entity?, threshold?, mode?, age_days?)
  → 4 modes: observations (dedup clusters), entities (name resolution),
    contradictions (conflicting claims), sleep (lifecycle analysis —
    compress/prune/refresh candidates).

export(format, entity?, type?)
  → 5 formats: claude-md, markdown, json, wire, obsidian.

check_version(entity, version_hash?)
  → "Did anything change?" Cached hash in, is_current boolean out.
    No embeddings, no content — pure metadata.

onboard(source?)
  → Bootstrap memory from a new AI session. Returns extraction
    instructions the AI follows. Lists existing entities to avoid dupes.
```

### File Structure

```
hippocampus/
├── src/
│   ├── index.ts              # Hono server, MCP Streamable HTTP transport
│   ├── config.ts             # Environment config with Zod validation
│   ├── mcp/
│   │   ├── server.ts         # MCP server, tool + resource registration (11 tools)
│   │   ├── tools/            # One file per tool
│   │   └── resources/        # MCP resources (proactive context injection)
│   ├── db/
│   │   ├── index.ts          # SQLCipher initialization
│   │   ├── schema.ts         # Schema V1-V6 + migrations
│   │   ├── entities.ts       # Entity CRUD + version hashing
│   │   ├── observations.ts   # Observation CRUD + keyword search + access tracking
│   │   └── relationships.ts  # Relationship CRUD + BFS graph traversal
│   ├── embeddings/
│   │   ├── embedder.ts       # Local embeddings (all-MiniLM-L6-v2) + semantic search
│   │   ├── similarity.ts     # Cosine similarity
│   │   └── subspace.ts       # SVD novelty scoring + redundancy analysis
│   └── auth/
│       └── oauth.ts          # Self-contained OAuth 2.1 server
├── tests/                    # node:test — consolidation, lifecycle, features, resources, efficiency, versioning
├── Dockerfile
├── docker-compose.yml
├── Caddyfile                 # Reverse proxy config (Caddy auto-TLS)
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

## What Shipped

### 0.1.0 — Core
Core server, 6 tools (remember, recall, forget, update, context, export), SQLCipher encryption, local embeddings, OAuth 2.1, Docker + Caddy. Dedup on write, near-match detection, compact/wire/index recall formats, budgeted context resource, adaptive onboarding, contradiction detection, entity resolution, spreading activation.

### 0.2.0 — Memory Lifecycle
Subspace novelty scoring (SVD), sleep mode (compress/prune/refresh lifecycle analysis), reconsolidation hints on recall, observation kind and importance. The "overnight defrag" for knowledge graphs.

### 0.3.1 — Artifact Storage
Content limit raised from 2,000 to 50,000 chars. Enables storing writing frameworks, skill templates, CLAUDE.md files — anything you want available across AI tools. Semantic search still uses the embedding window (~1,500 chars); long artifacts are retrieved by entity name, keyword, or context tool.

### 0.3.0 — Cross-Platform Staleness
Entity versioning (SHA-256 hash per entity, recomputed on every mutation), `check_version` tool (cached hash in, is_current boolean out), `onboard` tool (guided first-session extraction), version_hash propagated through all tool responses. The "did anything change while I was in ChatGPT?" release.

## Differentiation

Nobody else is building this:
- **Claude.ai native memory** — Claude only. Doesn't work in Claude Code, ChatGPT, or anything else.
- **ChatGPT memory** — ChatGPT only. Siloed.
- **CLAUDE.md files** — Claude Code only. Local files on disk.
- **Mem0** — Local MCP server. Doesn't work across platforms.
- **Hippocampus** — One server, every AI platform, knowledge graph with semantic search, self-hosted and encrypted. Cross-platform staleness detection so AIs know when their cached context is stale without re-fetching everything.

## Name

The hippocampus is the part of the brain that forms new memories, consolidates them, and maps relationships between concepts. It's how you navigate both physical space and conceptual space.

`hippocampus` as the repo. `hippo` as the CLI shorthand.
