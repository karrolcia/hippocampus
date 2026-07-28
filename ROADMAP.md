# Hippocampus — roadmap

*What's next, now / next / later — the coherent-action arm of gap → bet → action (`PRODUCT.md` holds the gap + bet; `DECISIONS.md` the go-forward log; `CLAUDE.md` the design decisions + gotchas). Converted from `TODO.md` 2026-06-23. A scan surface, not a hard commitment — but the top item is spin-up-ready.*

## ⭐ Next session
- **R2 — `kind` in recall `compact` / `wire`.** The formats agents actually consume, and the one most tied to the agent-continuity work; contained.
  - **Why:** agent-continuity runtimes read `compact`/`wire`; dropping `kind` there blocks differentiating `instruction` / `schedule` / `checkpoint`.
  - **Where:** the recall serializers; regression test alongside `tests/new-features.test.ts`.
  - **Context:** from the V5+-field audit (4 real gaps, ranked R1–R5; R1 `export json` completeness is DONE on main). Full matrix: `hq-sessions/output/audit-other-tools-for-dropped-115408/audit.md`.

## Now (active)
- **Agent-continuity Phase 2 — Bootstrap.** Add `recall("agent tasks", type: "agent", format: "index")` as a standard start-of-session step in global + project CLAUDE.md, so every AI session is aware of agent tasks without loading full context. Spec: `docs/spec-agent-continuity.md`.
- **Checkpoint writes in practice.** Nothing writes `kind: "checkpoint"` after a run yet. Smallest step: `~/chief-of-staff/run.sh` (+ the two other launchd runners) call `remember(entity: "agent:<id>", kind: "checkpoint", replace_kind: true, …)` at run-end.
- **ChatGPT Developer Mode — end-to-end test.** `remember` + `recall` never tested via ChatGPT's custom MCP integration — the blocker for the "universal memory across all platforms" claim on the README. Highest leverage for the flagship claim.
- **R3 + R4 — scoring fields in recall `full` + `context`; resolve `last_recalled_at`.** The embedder layer strips `recall_count`/`importance` and never SELECTs `last_recalled_at` — a maintained-but-unconsumed column. Wire it into scoring, or retire it + drop the CLAUDE.md "foundation for decay" claim.

## Next
- **Phase 3 — cross-runtime execution proof.** The "Claude Code down → ChatGPT picks up" demo: disable the launchd chief-of-staff agent for a day, confirm ChatGPT / Claude.ai reads the agent entity and produces the same briefing.
- **Phase 4 — Ollama / local-LLM fallback.** Local LLM reads agent tasks; skips tasks whose `requires` can't be met locally (mail, calendar) without erroring — degraded but alive.
- **R5 — `kind` in export markdown / obsidian** (cosmetic).
- **Docs / positioning drift.** (a) The v0.4.0 "Memory is a feature. Continuity is the product." positioning lives only in memory + the launch post — decide whether README/PRODUCT should adopt it. (b) `docs/spec-agent-continuity.md` still reads Phase 1 as planned; it's executed (2026-04-15) — add a dated status line.

## Next — production-memory block (from the 2026-07-16 context-engineering talk; D2)

*The talk's production principles (versioning, concurrency, permissioning, out-of-band curation) map onto primitives Hippo mostly has — these four wire them. Ordered: the first has already cost real data. The ops-side counterpart (the dreaming/curation pass) lives in `~/chief-of-staff/ROADMAP.md` #19, not here.*

- [ ] **Append-safe writes — demote dedup-on-write from replace to flag** [session] — `remember` stops silently replacing near-duplicate content (cosine ≥ 0.85); it stores anyway and returns the near-dup as a warning for out-of-band consolidation. `replace_kind` stays (explicit opt-in replacement).
  - **Why:** judgment doesn't belong in the write path — dedup-on-write silently destroyed a dated daily-log entry (`reference_hippo_dedup_destroys_dated_logs`). In-band writes should be dumb and safe; merging is `consolidate` + the AI's job.
  - **Where:** `src/mcp/tools/` remember + the embedder dedup path; `tests/`. Update CLAUDE.md's "Dedup on write" design decision in the same change.
  - **Assumes:** no caller depends on replace-on-longer behaviour (grep `~/chief-of-staff/` prompts + tool descriptions before building).
  - **Done:** no code path replaces observation content without `replace_kind`; a near-dup write stores + warns; tests cover both.
- [ ] **`precondition_hash` on mutations — optimistic concurrency** [session] — optional param on `remember`/`update`/`merge`: if the caller's cached hash ≠ current `version_hash`, reject and return the current hash so the agent re-pulls, re-drafts, retries. V6 already recomputes the hash on every mutation — this is the talk's compare-and-swap for nearly free.
  - **Where:** mutation tools + `db/entities.ts`; document the re-pull/retry loop in the tool descriptions.
  - **Done:** a stale-hash write is rejected with the current hash; no-param callers are unaffected (backward compatible).
- [ ] **Protected entities** [session] — a `protected` flag on entities; `remember`/`update`/`forget`/`merge`/`merge_entities` refuse without an explicit `override: true`. Protect the curated tier (`skill:*`, `feedback:*`) from a misbehaving agent or an injected instruction.
  - **Why:** every agent token currently has full write to everything, including the curriculum. Cheap single-user version of the talk's permissioning; scoped tokens stay out of scope (see PRODUCT non-priorities — no multi-user SaaS).
  - **Done:** mutation on a protected entity without override errors with a clear message; flag settable + visible via existing tools.
- [ ] **Mutation audit log — attribution without content** [session] — append-only log: when / entity / tool / source / hash-after. **Never content** (respects `secure_delete`; full version history stays rejected — D2). Answers "which agent wrote this" and gives rollback *points* when paired with `export`.
  - **Related:** Later's "session provenance on recall" is the read-side of the same need — the talk promotes both.

## Later (feature ideas — not scheduled)
- Session provenance on recall (`source_platform` per observation; schema V8).
- Consistency metrics (build on `consolidate mode: "contradictions"`).
- Agent-task recall shorthand (revisit once Phase 2 bootstrap is in real use).
- Timezone handling across runtimes (UTC fallback, unimplemented).
- Failed-task surfacing (checkpoint `last_status: failed` → next runtime mentions it).
- Gemini end-to-end verify (when Gemini ships a GA MCP client).
- README/positioning: speak the production-memory vocabulary [quick] — once the production-memory block ships, name versioning / concurrency / permissioning / out-of-band consolidation explicitly. That vocabulary is becoming the search language for exactly what Hippo is, and the only "enterprisey" answer on offer today is a paid managed API.

## Housekeeping
- Decide fate of `linkedin-data-export-reminder` (the DMA pipeline replaced it; keep disabled as a fallback, or delete the entity + dir).
- Commit or explain `scripts/health-check.sh` (untracked ops tooling — commit with an invocation note, or move to the deploy repo).
- Move `test-all-tools.ts` + `test-export.ts` out of repo root into `tests/` / `scripts/`.

## Watch list from 2026-07-28 session (stale-session regression test + app export refactor, `1ceb9d0`)
- [ ] **Verify the stale-session 404 fix behaviorally on prod** after the dependabot session's VPS deploy of `0a2bb2e`: POST `https://hippo.sarna.rocks/mcp` with a valid bearer token + bogus `Mcp-Session-Id` → expect HTTP 404 with `error.code -32001` (repro line in CLAUDE.md gotcha). Also confirm `/health` reports `sessions` and version 0.4.1 uptime reset.
- [ ] **Assumption to hold loosely:** test-file env isolation relies on node's test runner spawning one process per file (`tsx --test`). `tests/auth.test.ts` sets `HIPPO_OAUTH_ISSUER`, `tests/mcp-session.test.ts` deliberately doesn't — if a future runner change shares a process, config module caching would cross-contaminate them. Cheapest check if suites start failing weirdly together: run each file solo with `npx tsx --test tests/<file>`.

## Watch list from 2026-07-27 session (observation-scoping fixes, `92edff6`, D7)
- [ ] **Watch for new `forget: unrecognized argument` errors in agent logs** for a week or so. Forget went strict — any caller (launchd agent, Claude.ai flow) that was passing sloppy extra args to `forget` and getting a quiet (dangerous) whole-entity delete now gets a hard JSON-RPC error instead. A new error here is a caller to fix, not a server bug.

### Assumptions from 2026-07-27 (verify before work that depends on them)
- [ ] **The 8 pseo skills were the only `skill:*` entities with a kind=null content observation.** Only the entities named in the incident were migrated; no DB-wide sweep for other stranded kind=null skill observations was done. Downstream: kind-filtered skill retrieval (`recall(type:"skill")` → `context`) silently misses any others. Cheapest check: `export format:"json"` (or recall over skill entities) and grep for `"kind": null` on `skill:*`.
- [ ] **Re-tagging via `update` (old_content == new_content + kind) is harmless despite recreating the observation.** The migration gave the 7 content observations new IDs, `created_at` 2026-07-27, and `recall_count` 0. Assumed fine (decay boost is gentle; nothing known keys on those observation IDs). If anything caches observation IDs for pseo skills, it's stale.
