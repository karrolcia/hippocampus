# Hippocampus TODO

Running list of open work on the codebase. Not a commitment — a scan surface.
Last updated: 2026-06-08.

## Immediately unlocked by today's sync-agents work

- [x] **Deploy `context` kind fix to hippo.sarna.rocks.** ~~Server change already committed to `src/mcp/tools/context.ts`.~~ Verified live on prod 2026-06-08: the `claude.ai Hippocampus` connector (→ `hippo.sarna.rocks`) returns observation `kind` in `context` responses. The fix (`c46ea72`, committed 2026-04-15) was already picked up by a subsequent redeploy; this item was just never checked off. `scripts/sync-agents.ts pull`'s content-shape heuristic remains a safe fallback, but the `kind` field path is now primary.
- [x] **Add a test for `context` including `kind`.** Done 2026-06-08 — `tests/versioning.test.ts` now has a `kind in context` block asserting a kinded observation's `kind` survives `formatObs` (regression guard for `c46ea72`).
- [x] **Audit other tools for dropped V5+ fields.** Done 2026-06-09. All 12 observation-serialization paths audited (recall full/compact/wire/index, export claude-md/markdown/json/wire/obsidian, both `hippocampus://` resources, + the `context` tool). 7 drop fields by design (minimal/injection formats); 4 real gaps. Full matrix + ranked fixes (R1–R5) in `hq-sessions/output/audit-other-tools-for-dropped-115408/audit.md`. **Follow-ups unlocked (separate fix phase):** ~~R1 — `export json` completeness~~ **DONE 2026-06-09**: chose lossless (backup is its stated job); `formatJson` now emits `importance`/`recall_count`/`last_recalled_at`, regression test in `tests/new-features.test.ts`. Reversible lever if ever wanted: intent-only = keep `importance`, drop the two telemetry fields. R2 — add `kind` to recall `compact`/`wire`, the formats agents use + most tied to the agent-continuity work (contained); R3+R4 — surface scoring fields in recall `full` + `context` tool (embedder-layer: `SemanticSearchResult` strips `recall_count`/`importance` and never SELECTs `last_recalled_at`), and resolve `last_recalled_at` — a maintained-but-unconsumed column (written every recall, read nowhere): wire into scoring or retire + drop the CLAUDE.md "foundation for decay" claim; R5 — `kind` in export markdown/obsidian (cosmetic).
- [ ] **Decide fate of `linkedin-data-export-reminder`.** The DMA pipeline (per `project:linkedin-data-pipeline`) runs daily and replaces the manual export loop. `scripts/agents-manifest.json` already marks it `enabled: false` with a runtime hint flagging possible obsolescence. Either keep disabled as a fallback, or delete the entity + disk dir.
- [ ] **Commit or explain `scripts/health-check.sh`.** Untracked, dated 2026-03-03, monitors the Docker container from outside. It's server-side ops tooling, not agent-continuity work. Either commit with a short comment about how it's invoked (cron? systemd timer? the header claims systemd), or move it to the deployment repo / docs and drop from here.

## Agent Continuity Spec — remaining phases

See `docs/spec-agent-continuity.md` for the full design.

- [ ] **Phase 2 — Bootstrap.** Update the session protocol in global `~/.claude/CLAUDE.md` (and surface in project CLAUDE.md here) to add `recall("agent tasks", type: "agent", format: "index")` as a standard start-of-session step. Makes every AI session aware of what agent tasks exist without loading full context.
- [ ] **Phase 3 — Cross-runtime execution proof.** The promised "Claude Code down → ChatGPT picks up" demo. Concrete test: disable the launchd chief-of-staff agent for a day, confirm ChatGPT (or Claude.ai with the Hippocampus connector) reads the agent entity, sees it's due, produces the same briefing structure.
- [ ] **Phase 4 — Ollama / local LLM fallback.** Local LLM with MCP client reads agent tasks from Hippo. Skips tasks whose `requires` can't be satisfied locally (mail, calendar) without erroring. Degraded but alive.
- [ ] **Checkpoint writes in practice.** Nothing currently writes `kind: "checkpoint"` observations after a run. The launchd briefing/nightly-check shells don't — neither does any skill. Smallest next step: update `~/chief-of-staff/run.sh` (and the two other launchd runners) to call `remember(entity: "agent:<id>", kind: "checkpoint", replace_kind: true, content: <yaml>)` via `hippo-query.sh` at the end of each run.

## Feature ideas (not on the roadmap, not scheduled)

- [ ] **Session provenance on recall.** Tag each observation with which platform/runtime wrote it (`source_platform`: `claude-code`, `claude-ai`, `chatgpt`, `ollama`, etc). Would be schema V8 — either a column on `observations` or a parseable convention inside the existing `source` field. Helpful for debugging when non-deterministic outputs from different platforms create conflicting state.
- [ ] **Consistency metrics.** Build on existing `consolidate mode: "contradictions"` to proactively surface "this entity got 3 conflicting updates this week" without the AI having to ask. Could live as a new `consolidate` mode or as flags on the `hippocampus://context` resource.
- [ ] **Agent-task recall shorthand.** Open question 2 in the spec: should there be a helper like `recall(type: "agent", kind: "schedule", format: "compact")` dedicated to "show me all schedules at once"? Current answer is "no, index format is enough" — revisit once Phase 2 bootstrap is in real use.
- [ ] **Timezone handling across runtimes.** Open question 3 in the spec: `schedule` observations carry an IANA timezone, but the runtime may not know its own. Convention right now is "UTC fallback, note in checkpoint" — not actually implemented anywhere. Low-priority until a non-macOS runtime starts running tasks.
- [ ] **Failed-task surfacing.** Open question 4 in the spec: if a checkpoint writes `last_status: failed`, does the next runtime that connects mention it to the user? Decision was "leave to the consuming AI's judgment" — still unimplemented on the consuming side.

## Platform coverage (from CLAUDE.md Testing Checklist)

- [ ] **ChatGPT Developer Mode.** `remember` + `recall` never tested end-to-end via ChatGPT's custom MCP integration. Blocker for the "universal memory across all platforms" claim on the README.
- [ ] **Gemini.** Not mentioned in the current Testing Checklist but positioning says "any AI platform that supports MCP." When Gemini ships a generally available MCP client, verify. Currently unscheduled.

## Docs / positioning drift

- [ ] **README vs PRODUCT.md vs CLAUDE.md consistency.** The v0.4.0 "Memory is a feature. Continuity is the product." positioning only lives in `raw:project:hippocampus` memory and the launch post. Neither README.md nor PRODUCT.md uses it yet. Decide whether the repo surface should follow or whether the positioning is content-only.
- [ ] **`docs/spec-agent-continuity.md` Phase 1 status.** The spec still reads as if Phase 1 is planned. As of 2026-04-15 it's executed (all 9 tasks live in Hippo). Add a "Status" line or a small dated note at the top.

## Deferred

- [ ] Move `test-all-tools.ts` and `test-export.ts` out of repo root into `tests/` or `scripts/`. They're runnable TS files, not `tsx --test` suites — fine but cluttering the root listing.
