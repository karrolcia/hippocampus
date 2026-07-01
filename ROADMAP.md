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

## Later (feature ideas — not scheduled)
- Session provenance on recall (`source_platform` per observation; schema V8).
- Consistency metrics (build on `consolidate mode: "contradictions"`).
- Agent-task recall shorthand (revisit once Phase 2 bootstrap is in real use).
- Timezone handling across runtimes (UTC fallback, unimplemented).
- Failed-task surfacing (checkpoint `last_status: failed` → next runtime mentions it).
- Gemini end-to-end verify (when Gemini ships a GA MCP client).

## Housekeeping
- Decide fate of `linkedin-data-export-reminder` (the DMA pipeline replaced it; keep disabled as a fallback, or delete the entity + dir).
- Commit or explain `scripts/health-check.sh` (untracked ops tooling — commit with an invocation note, or move to the deploy repo).
- Move `test-all-tools.ts` + `test-export.ts` out of repo root into `tests/` / `scripts/`.
