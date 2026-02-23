# Hippocampus — Project Context

## What This Is
Open-source, self-hosted MCP memory server. Universal memory across Claude, ChatGPT, Gemini, Cursor, Perplexity — any AI platform that supports MCP.

"Your AI shouldn't forget who you are just because you switched apps."

## Stack
- Node.js 18+ / TypeScript
- Hono (web framework)
- `@modelcontextprotocol/sdk` (official MCP TypeScript SDK)
- Streamable HTTP transport on `/mcp`
- SQLite via `better-sqlite3-multiple-ciphers` (SQLCipher AES-256 encryption)
- `@xenova/transformers` for local embeddings (all-MiniLM-L6-v2)
- OAuth 2.1 with PKCE (self-contained, single user)
- Docker + Caddy reverse proxy

## Architecture
- Knowledge graph: entities → observations → relationships
- Semantic search via local embeddings (no external API keys)
- Entire database encrypted at rest (including embedding vectors — they leak original text)
- MCP tools: remember, recall, forget, update, merge, merge_entities, context, consolidate, export
- MCP resources: `hippocampus://context` (full knowledge graph, claude-md format), `hippocampus://entity/{name}` (per-entity context with relationships)

## Key Design Decisions
- **SQLCipher for everything**: Embeddings are NOT privacy-safe. Research shows text reconstruction from vectors. Encrypt the entire DB.
- **Local embeddings only**: No OpenAI/Anthropic API dependency. `all-MiniLM-L6-v2` runs in Node.js via Transformers.js.
- **OAuth 2.1 mandatory**: Claude.ai custom connectors need it. Self-contained auth server for single-user self-hosted.
- **Streamable HTTP**: Modern MCP transport. Not SSE (deprecated). Not stdio (local only).
- **No hosted version**: Open source, donations via Stripe Payment Link. No SaaS, no customer data liability.
- **Hono over Express**: Lighter, faster, works well with MCP middleware packages.
- **Consolidate = clustering only**: Hippocampus identifies duplicate clusters (embedding math). The AI does the merging (language intelligence). Each does what it's good at. The AI calls `merge` to finalize.
- **Dedup on write**: `remember` checks for near-duplicates (cosine similarity >= 0.85) on the same entity before storing. If existing content is longer/equal, skips. If new content is longer, replaces. Conservative threshold — only catches near-verbatim repeats.
- **Merge = atomic consolidation**: Single tool call replaces multi-step `remember` + N x `forget` dance. AI provides merged text + observation IDs, Hippocampus handles the rest.
- **Storage guidance**: Tool descriptions encourage telegraphic form ("PhD atmospheric physics, TU Delft" not full sentences) to reduce per-observation token cost.
- **Compact recall format**: `format: "compact"` returns grouped markdown (~4x fewer tokens than full JSON). `format: "full"` (default) returns current shape for backward compat.
- **Budgeted context**: `hippocampus://context` resource capped at `HIPPO_CONTEXT_MAX_OBSERVATIONS` (default 100). Prioritizes most-recently-updated entities, partial-includes the last entity at the budget boundary.
- **Access tracking**: Schema V3 adds `recall_count` + `last_recalled_at` per observation. Foundation for decay-weighted retrieval. Updated on every recall match.
- **Entity resolution**: `consolidate mode: "entities"` embeds entity names, clusters by cosine similarity (default threshold 0.7). Detection only — AI decides what to merge. Surfaces cross-entity redundancy invisible to per-entity dedup.
- **Decay-weighted retrieval**: `score = similarity * (1 + 0.1 * log(1 + recall_count)) * importance`. Gentle boost from access tracking — similarity stays the dominant signal. recall_count=0 → neutral (no penalty), recall_count=100 → ~1.46x boost.
- **Observation importance**: Schema V4 — `importance REAL DEFAULT 1.0` per observation. Manual override for always-relevant facts. Set via `remember` tool's `importance` param (0.0-1.0). Multiplied into recall scoring.
- **Entity merge**: `merge_entities` tool — structural consolidation companion to `consolidate mode: "entities"`. Moves observations, embeddings, relationships atomically in a transaction, then deletes source entities.

## Security Rules
- NEVER log memory content, observation text, embeddings, tokens, or passphrase
- All endpoints behind rate limiting
- Input validation: 2,000 char max per memory, 200 char max entity name
- `PRAGMA secure_delete = ON` for forget operations
- Non-root Docker, cap_drop ALL, read-only filesystem (except /data)
- CORS restricted to known AI platform origins
- See SECURITY.md for full architecture

## File Structure
```
src/
├── index.ts              # Hono server setup, MCP transport
├── mcp/
│   ├── server.ts         # MCP server, tool + resource registration
│   ├── tools/            # One file per tool
│   └── resources/        # MCP resources (proactive context)
├── db/
│   ├── schema.ts         # SQLCipher schema + migrations
│   ├── entities.ts
│   ├── observations.ts
│   └── relationships.ts
├── embeddings/
│   └── embedder.ts       # Local embedding generation + search
└── auth/
    └── oauth.ts          # Self-contained OAuth 2.1
```

## Revenue Model
None. Open source + Stripe donation link ("buy me a coffee"). No billing code in the app.

## Testing Checklist
- [x] remember + recall works via Claude Code (HTTP transport, local dev)
- [x] remember + recall works via claude.ai (remote MCP, custom integration)
- [ ] remember + recall works via ChatGPT (Developer Mode)
- [x] SQLCipher encryption verified (file unreadable without passphrase, header is random bytes)
- [x] OAuth flow works for Claude.ai connector
- [x] Rate limiting active (429 at request #61)
- [x] Secure deletion verified (PRAGMA secure_delete = ON)
