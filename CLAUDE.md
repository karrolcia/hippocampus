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
- MCP tools: remember, recall, forget, update, merge, merge_entities, context, consolidate, export, check_version, onboard
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
- **Observation kind**: Schema V5 — optional `kind TEXT` per observation. Free-text, not enum — tool descriptions suggest `fact`, `decision`, `question`, `preference`. Filterable in both `recall` and `semanticSearch`. Included in JSON export. NULL for existing observations (backward compatible).
- **Spreading activation**: `recall` with `spread: true` — after base semantic+keyword search, follows relationships 1 hop from matched entities, scores related observations against the query, dampens by `SPREAD_DECAY = 0.5`, merges into results. Refactored `semanticSearch` into `semanticSearchWithVector` to avoid redundant embedding generation when spreading.
- **Contradiction detection**: `consolidate mode: "contradictions"` — finds observation pairs with high embedding similarity (same topic, default threshold 0.6) but low Jaccard word-set overlap (< 0.3). Surfaces conflicting claims for human review. No LLM needed — pure embedding math + lexical comparison.
- **Adaptive onboarding**: `hippocampus://context` resource counts total observations. If < 5, prepends guidance prompting the AI to capture user knowledge (identity, projects, preferences). Existing observations still shown below the guidance. At 5+, returns the full knowledge graph only. The old empty-state message ("No memories stored yet") is subsumed by the sparse branch.
- **Near-match detection on write**: `remember` already scans all entity embeddings for dedup (>= 0.85). Now also collects observations in the 0.5–0.85 similarity range — zero additional computation. Returns top 3 as `near_matches` in the response with a consolidation prompt. Encode-on-arrival: detect temporal redundancy at write time instead of waiting for batch `consolidate` passes.
- **Subspace novelty scoring**: `remember` returns `novelty` (0–1) via SVD projection. Pairwise cosine misses aggregate redundancy — five observations that individually have moderate similarity can collectively explain a new observation entirely. SVD projection compares against all observations simultaneously. When novelty < 0.1, the response flags it. Dependency: `ml-matrix` (~50KB, pure JS, zero native deps).
- **Sleep mode**: `consolidate mode: "sleep"` — batch lifecycle analysis inspired by hippocampal memory consolidation during sleep. SVD leverage scores + temporal signals classify observations into compress (redundant + old + recalled → merge candidates), prune (never recalled + old → delete candidates), and refresh (actively used + unique + old → reconsolidation candidates). Returns `information_rank` and `redundancy_ratio` per entity for structural diagnosis.
- **Reconsolidation hints**: `recall` flags `stale: true` on observations older than 30 days when the entity has received newer information since. Lightweight — date comparison only, no embedding computation. The AI can then use `update` to refresh stale facts.
- **Entity versioning**: Schema V6 — `version_hash TEXT` + `version_at TEXT` on entities. SHA-256 of all observation content sorted by observation ID, recomputed on every mutation via `updateEntityTimestamp`. Solves cross-platform staleness: an artifact stored via Claude is usable in Gemini/ChatGPT — the AI caches the hash and checks freshness later without re-fetching content.
- **Entity-level versioning, not observation-level supersession**: Original design considered `supersedes`/`superseded_by` on observations, but that requires soft-delete model — every query path (semantic search, keyword search, consolidate, export, context, spreading) would need supersession filters. Conflicts with `PRAGMA secure_delete = ON`. Entity version hash solves the actual problem (staleness detection) without touching the deletion model.
- **Version hash = SHA-256 of sorted observation content**: Sort by observation ID (UUID, stable), concatenate content with null byte separator, hash. Deterministic — same observations always produce same hash. Recomputed on every entity mutation via `updateEntityTimestamp` (already called by remember, update, merge, forget).
- **check_version tool**: Lightweight staleness check — AI sends entity name + cached `version_hash`, gets back `is_current` boolean + current version info. No embedding computation, no observation content returned. Purely metadata.
- **Version hash in tool responses**: All mutation tools (remember, update, merge, merge_entities) return `version_hash` so AIs can cache it. Recall includes `version_hash` per entity in all formats (full: per memory, compact/wire: entity header `[v:XXXXXXXX]`, index: appended to entity line). Context tool includes `version_hash` on the main entity.
- **Onboard tool**: Returns structured extraction instructions the AI follows to systematically capture user context. Lists existing entities to avoid duplicates. The tool doesn't extract anything itself — it returns a prompt. Keeps the tool stateless; each AI platform uses its own context for extraction. Optional `source` param adds platform-specific hint.
- **Adaptive onboarding updated**: `hippocampus://context` sparse guidance (< 5 observations) now mentions the `onboard` tool alongside direct `remember` usage.
- **Kind-scoped upsert (`replace_kind`)**: `remember` with `replace_kind: true` atomically deletes all existing observations with the same `kind` on the entity before inserting the new one. Designed for state observations that should have exactly one value (agent checkpoints, schedules). Skips dedup entirely — the caller explicitly wants replacement. Solves the `update` vs `remember` tradeoff for mutable state: `update` requires fragile exact-match on previous content; `remember` accumulates duplicates. `replace_kind` gives clean single-observation behavior without either failure mode.
- **Agent continuity layer**: Convention for storing agent instructions (scheduled tasks, workflows) in Hippocampus so any MCP-connected runtime can execute them. Entity type `agent`, observation kinds `instruction` (prompt), `schedule` (cron + requirements), `checkpoint` (last run state). No new tools, no schema changes — uses existing `remember`/`recall`/`context` with `replace_kind` for checkpoint writes. Spec: `docs/spec-agent-continuity.md`.
- **Sync script** (`scripts/sync-agents.ts`): Phase 1 tooling. Two commands: `push` migrates `~/.claude/scheduled-tasks/<id>/SKILL.md` → `agent:<id>` entities (uses `scripts/agents-manifest.json` to seed cron/requires since SKILL.md frontmatter doesn't carry them). `pull` materializes `agent:*` entities back to disk for Claude Code compat, backing up existing SKILL.md to `.bak`. Auth via `HIPPO_AGENT_TOKEN` env var; macOS Keychain fallback (`security find-generic-password -s hippocampus-agent -a karolina -w`). Run via `npm run sync-agents -- push|pull|list [--dry-run]`. Uses `replace_kind: true` on `remember` so re-running is idempotent. Uses a content-shape heuristic (`/^cron:/m && /^enabled:/m`) when distinguishing schedule from instruction observations, as a fallback for servers where `context` doesn't yet expose `kind`.
- **Context tool now exposes observation `kind`**: Schema V5 added `kind` per observation, but `context` tool's `formatObs` dropped it when serializing. Fixed — `context` response now includes `kind` alongside `content`, `source`, `remembered_at`. Unblocks any AI needing to differentiate observations by kind (e.g., agent sync separating `instruction` from `schedule`). Server-side change; requires redeploy to take effect.

## Security Rules
- NEVER log memory content, observation text, embeddings, tokens, or passphrase
- All endpoints behind rate limiting
- Input validation: 50,000 char max per memory, 200 char max entity name
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

## Known Gotchas

- **`context()` blows up on append-only log entities.** Entities like `ops:daily-log:*`, `ops:knowledge-patterns`, or `pipeline:qualification-patterns` accumulate many observations over time. `context(topic: "...")` can return 100K+ chars and exceed token limits — the harness saves the response to a file with offset/limit instructions, but that breaks your flow. For log-style entities, use `recall(query, format: "index" | "compact")` first to see what's there, or open the saved file with offset/limit. Long-term fix: a token budget on `context` similar to `HIPPO_CONTEXT_MAX_OBSERVATIONS` for the resource.
- **VPS lives at `/opt/hippocampus` on Hetzner** (NOT `~/hippocampus`). SSH config alias is `hippo`. Deploy = `git push origin main` then `ssh hippo 'cd /opt/hippocampus && git pull && docker compose up -d --build'`. Container runs read-only filesystem; `/data` is the only writable volume. No `docker-compose.override.yml` — single compose file. Healthcheck takes ~15s after restart.
- **MCP client tool param names ≠ entity field names.** `context` expects `topic`, not `entity`. Easy to get wrong when refactoring — load the schema via ToolSearch when in doubt rather than guessing from existing tool-call patterns. Mitigated since 2026-05-22: `src/mcp/param-normalization.ts` accepts `entity`/`entity_name`/`entityName` as aliases for `topic` on `context`, and `entity_name`/`entityName` for `entity` on `forget`, plus generic snake↔camel conversion across all params. Canonical names are still the wire contract — only inbound leniency is added.
- **Don't wrap tool `inputSchema` with `z.preprocess()` or `z.object().transform()` to mutate args before validation.** The SDK's `tools/list` runs `normalizeObjectSchema` on each tool's input — that helper only unwraps raw shapes and ZodObjects (it checks `.shape` directly). A `ZodEffects` (which is what `z.preprocess` and `.transform` return) returns `undefined` from `normalizeObjectSchema`, so `tools/list` falls back to `EMPTY_OBJECT_JSON_SCHEMA` and AI clients silently lose all param signatures. To run pre-validation logic, install at the request-handler boundary instead — see `installParamNormalization` in `src/mcp/server.ts`.
- **`_requestHandlers.get('tools/call')` returns a schema-parsing wrapper, not the raw McpServer dispatch.** The SDK's `Protocol.setRequestHandler` wraps user handlers with `parseWithCompat(CallToolRequestSchema, request)`, so anything reaching back into `_requestHandlers` (including our own normalization wrapper) must accept and pass through the full JSON-RPC shape `{ jsonrpc, id, method, params }`. Tests that drive the handler directly need to construct that full shape — see `tests/param-normalization.test.ts` for the pattern.
- **Typecheck-before-commit is a *git* hook, not a Claude Code `settings.json` hook.** `.claude/settings.json` once carried a `"PreCommit"` hook running `npm run typecheck` — but `PreCommit` is not a Claude Code hook event (those fire on the Claude Code lifecycle: `PreToolUse`, etc., never on `git commit`), and the shape was wrong too, so `/doctor` flagged it and it silently never ran. The real enforcement lives in tracked `.githooks/pre-commit`, activated per clone with `git config core.hooksPath .githooks` (a non-zero hook exit aborts the commit — standard git). Deliberately no husky/postinstall: running `git config` during the Docker `npm ci` build fails (no `.git` present) and breaks the image. Fixed 2026-06-08 (`29d71dc`).
- **Before treating a "deploy X" roadmap item as undone, check whether X is already live.** "Deploy" TODO items go stale: the `context` kind fix (`c46ea72`, committed 2026-04-15) sat as an unchecked deploy item for ~2 months while already running on prod — an unrelated later redeploy had picked it up. Verify *behaviorally*, not via SSH or commit hash: call the live tool through the `claude.ai Hippocampus` connector (→ `hippo.sarna.rocks/mcp`) and inspect the actual response (e.g. does `context` return observation `kind`?). A needless redeploy just restarts the container — and stales any running MCP sessions.
- **MCP sessions leak one `McpServer` each without a server-side idle sweep → eventual OOM.** The Streamable HTTP transport only drops a session on an explicit client `DELETE` (`onsessionclosed` fires nowhere else). Claude.ai and most clients reconnect with a fresh session and never DELETE, so the `/mcp` session map in `src/index.ts` grew one retained `McpServer` per session across ~7 weeks of uptime until the process OOM'd at ~1.9 GB *live* heap — while the DB was only 5.8 MB. The small DB is why it looked like a query/data bug and wasn't; the crash's `better-sqlite3 .all()` stack frame was just the allocation that tipped an already-full heap. Fixed 2026-07-17 (`17147ac`, D3) with `src/mcp/session-registry.ts`: 30-min idle sweep + LRU cap + in-flight guard. **Diagnostic:** `/health` now reports live `sessions` — if it climbs monotonically and never falls, the sweep has regressed. Recognise the failure by `FATAL ERROR: Reached heap limit` in `docker logs` that is unrelated to DB size, plus a slowly-climbing `RestartCount` over weeks.
