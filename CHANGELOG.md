# Changelog

## Unreleased

### Added

- **`scripts/sync-agents.ts`** — Phase 1 migration tool for the Agent Continuity Layer spec. Pushes `~/.claude/scheduled-tasks/<id>/SKILL.md` files into Hippocampus as `agent:<id>` entities with `instruction` + `schedule` observations, and pulls them back out for Claude Code compat. `push --dry-run`, `pull --dry-run`, and `list` for inspection without side effects. Auth via `HIPPO_AGENT_TOKEN` or macOS Keychain fallback.
- **`scripts/agents-manifest.json`** — Bootstrap cron/requires data for the 9 existing scheduled tasks, since SKILL.md frontmatter doesn't carry scheduling metadata. After the first push Hippocampus is canonical; the manifest becomes a historical artifact.

### Fixed

- **`context` tool now exposes observation `kind`.** V5 added the field in 2026-02 but `formatObs` dropped it when serializing — so any AI consuming `context` couldn't tell an `instruction` observation from a `schedule` one even when both existed. Surfaced while writing the agent sync tool; fixed at the point it was actually needed. No schema change.

## 0.4.1 — "Hey, it's your server calling" (2026-04-10)

OAuth 2.1 is the right front door when Claude.ai and other MCP clients come knocking. It is a terrible choice when your own nightly agent, running on your own laptop, needs to talk to your own server to put together tomorrow's briefing. The refresh-token dance is a failure mode looking for a place to happen — and when it fails, it fails silently at 9am on a Monday, which is exactly when you needed the briefing.

So there is now a second door. Same building, same locks, different key.

### Added

- **`HIPPO_AGENT_TOKEN` env var.** Optional. If set, `bearerAuth()` accepts it as a valid bearer token in addition to OAuth access tokens. Designed for machine-to-machine scheduled agents running on infrastructure you control. Minimum 32 characters enforced in config schema (`Zod.string().min(32)`) — if you are going to bypass OAuth, at least bring a real token.
- **`auth.test.ts`.** Covers missing header, bogus token, valid agent token, length-gate rejection (different length), same-length-different-content rejection. 5 tests, no DB round-trips in the assertions themselves.

### Changed

- **`bearerAuth()` now tries OAuth access tokens first, then falls back to the agent token.** This ordering is deliberate: existing OAuth clients are completely unaffected (the lookup is the same, the behavior on success is the same). Only tokens that fail the OAuth lookup reach the agent-token check. If neither matches, the response is identical to before.
- **Constant-time comparison for the agent token.** `timingSafeEqual()` was already imported for OAuth. The new `matchesAgentToken()` helper adds a length gate before the compare (buffers must be equal length for `timingSafeEqual` to work at all) and bails out safely on missing config. No length-based side channels.
- **Cleanup interval is now `unref()`'d.** The 10-minute `deleteExpiredOAuthData()` interval used to keep the Node event loop alive, which made the test runner hang after tests finished. It no longer does. This is a test-ergonomics fix, but also a correctness improvement for any script that imports `oauth.ts` and expects to exit cleanly.

### Why this exists

Scheduled agents on the owner's own laptop, hitting the owner's own server, over HTTPS, with a constant-time-compared secret stored in the macOS Keychain — that is a different trust model than a third-party AI assistant asking for access to user data. OAuth 2.1 was designed for the second case and it shows. Trying to force the first case through the same flow means teaching your laptop to handle refresh-token rotation at 3am, and discovering at 9am that it did not.

The new path is scoped at the deployment layer, not in the protocol: if `HIPPO_AGENT_TOKEN` is not set, nothing changes. If it is set, one additional code path exists that grants full read/write on the instance that configured it. Revocation is rotate-the-env-var-and-redeploy. The blast radius is exactly as big as the server that configured the token.

OAuth clients do not need to know this path exists. They will never hit it.

## 0.3.1 — "Room for the big stuff" (2026-02-26)

The 2,000 character limit made sense when every observation was a telegraphic fact. Then you try to store a writing framework, a CLAUDE.md file, a skill template — and you're negotiating with a text box about what to leave out.

Content limit raised to 50,000 characters. The embedding model still only sees the first ~1,500 chars (all-MiniLM-L6-v2 truncates at 256 tokens), so semantic search quality is unchanged for short memories and irrelevant for long ones — artifacts get retrieved by entity name or keyword, not vibes.

### Changed

- **Content limit: 2,000 → 50,000 chars** across all write paths (`remember`, `update`, `merge`). SQLite TEXT columns had no size constraint to begin with. The limit was purely in Zod validation.

### What this enables

- Writing frameworks, skill templates, career histories, CLAUDE.md files
- Any artifact you want available across AI tools without copy-pasting
- Store once in Hippocampus, retrieve from Claude, ChatGPT, Gemini, Cursor, whatever speaks MCP

- **Richer observation kinds.** `remember` and `onboard` now guide AIs to capture reasoning and exploratory thinking, not just telegraphic facts. Two new kinds: `rationale` (why a decision was made, tradeoffs weighed, options rejected) and `exploration` (half-formed ideas, open questions worth preserving). No schema change — `kind` was always free-text. The difference is in the tool descriptions: AIs now know these kinds exist and have examples to follow.

### What doesn't change

- Semantic search still works on the embedding window (~1,500 chars). Long artifacts rank lower in similarity search — by design, not by bug.
- Keyword search, `context` tool, and `export` all work on full stored text regardless of length. Always did.
- SQLite schema untouched. Existing databases need no migration.


## 0.3.0 — "Did anything change while I was gone?" (2026-02-25)

You told Claude about your project stack on Monday. On Wednesday you switched to Gemini. Gemini has the same Hippocampus connected, pulls your context — but is it still Monday's context? Maybe you updated three things since then. Maybe you didn't. Gemini has no way to know without re-fetching everything, every time, forever.

This release gives every entity a version fingerprint. Now an AI can ask "has this changed?" and get a yes/no answer in one lightweight call. No re-reading observations, no embedding computation. Just a hash check.

Also: onboarding is no longer "figure it out from the tool description." There's a proper onboard tool now that tells the AI exactly what to extract and how to store it.

### Added

- **Entity versioning** (Schema V6). Every entity gets a `version_hash` — SHA-256 of all its observation content, sorted by ID — and a `version_at` timestamp. The hash recomputes automatically on every mutation. Deterministic: same observations, same hash, every time. Existing entities start with NULL and pick up their hash on next write. Nothing breaks.

- **`check_version` tool**. The "did anything change?" tool. AI sends an entity name and a hash it cached last time. Gets back `is_current: true` (relax, nothing changed) or `is_current: false` (time to re-fetch). Works without a cached hash too — just returns current version info. Zero embedding computation. Pure metadata. Fast.

- **`onboard` tool**. First-session extraction, guided. Instead of hoping the AI figures out what to `remember` from tool descriptions alone, `onboard` returns a structured prompt: here's what to look for (identity, projects, preferences, skills), here's what's already stored (don't duplicate it), here's the format (telegraphic, one fact per call). The tool itself stores nothing — it hands the AI a checklist and gets out of the way. Optional `source` param so it can say "you're running in ChatGPT" if that helps.

- **`version_hash` everywhere it matters**. All mutation tools (`remember`, `update`, `merge`, `merge_entities`) return the hash after writing, so AIs can cache it immediately. All `recall` formats carry it — `full` gets the field per memory, `compact` gets `[v:8chars]` in the header, `wire` and `index` get `|v:8chars` inline. `context` includes it on the main entity. If an AI touches a tool that reads or writes entities, version info is right there. No second call needed.

- **Smarter onboarding guidance**. The `hippocampus://context` sparse-state text (< 5 observations) now points to `onboard` instead of just saying "use remember." Because "use remember" is technically correct and practically useless when you're staring at an empty knowledge graph.

### Design notes

**Why entity-level, not observation-level.** We considered `supersedes`/`superseded_by` on observations — proper audit trail, very clean. But it requires soft-delete, and soft-delete means every query path in the system (semantic search, keyword search, consolidate, export, context, spreading activation) needs supersession filters. That's a lot of surface area for a feature whose actual job is answering "did this change?" Entity-level hashing answers that question without touching the deletion model. Also plays nicely with `PRAGMA secure_delete = ON` — when you forget something, it's gone, not marked invisible.

**Onboard returns instructions, not actions.** Every AI platform has different context available — conversation history, system prompts, uploaded files. Hippocampus doesn't know what the AI knows. The AI does. So `onboard` hands it a structured extraction prompt and lets it do what it's good at: reading its own context and calling `remember`.

## 0.2.0 — Memory Lifecycle (2026-02-24)

Hippocampus now manages the full memory lifecycle: encode, sleep, reconsolidate. Three failure modes that accumulate over time — aggregate redundancy invisible to pairwise comparison, dead-weight observations never recalled, and stale facts actively served despite newer information — are now detectable and actionable.

### Added

- **Subspace novelty scoring** on `remember`. Returns `novelty` (0-1) via SVD projection onto the subspace spanned by existing observations. Catches aggregate redundancy that pairwise cosine similarity misses — five observations with moderate individual overlap can collectively explain a new one entirely. Warns when novelty < 0.1.

- **Sleep mode** (`consolidate mode: "sleep"`). Batch lifecycle analysis inspired by hippocampal memory consolidation during sleep. Uses SVD leverage scores combined with temporal signals to classify old observations into three categories:
  - **Compress**: redundant + old + recalled. Merge candidates — information captured elsewhere, safe to consolidate.
  - **Prune**: never recalled + old. Delete candidates — synaptic pruning for observations that never proved useful.
  - **Refresh**: actively used + unique + old. Reconsolidation candidates — the AI keeps serving these, but newer information exists.

  Returns `information_rank` and `redundancy_ratio` per entity for structural diagnosis ("20 observations but only 5 dimensions of information — 75% redundant").

- **Reconsolidation hints** on `recall`. Flags `stale: true` on observations older than 30 days when the entity has received newer information since. Lightweight — date comparison only, no embedding computation. The AI can act on stale flags with the existing `update` tool.

- **`age_days` parameter** on `consolidate` (sleep mode). Minimum age in days for an observation to be a candidate (default 30, range 1-365).

### Dependencies

- Added `ml-matrix` (~50KB, pure JS, zero native dependencies) for SVD computation.

### Design notes

Hippocampus does the math, the AI does the language. Sleep mode returns classified observations — the AI acts on them using existing tools (`merge` for compress, `forget` for prune, `update` for refresh). No new action tools needed.
