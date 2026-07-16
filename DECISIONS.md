# Hippocampus — decisions (go-forward log)

*Append-only, newest first, `D-NNN`. Hippo's **architecture / design decisions** (SQLCipher-everything, local-embeddings-only, OAuth 2.1, Streamable HTTP, entity-versioning-not-supersession, consolidate = clustering-not-LLM-merge, dedup-on-write, …) live in `CLAUDE.md` → "Key Design Decisions" — that's the how-it's-built reference and stays there. This log records **go-forward** decisions and reversals; `PRODUCT.md` holds what-it-is + the bet.*

### D2 · 2026-07-16 · Adopt the production-memory direction: append-safe writes + out-of-band curation
**Why:** the 2026-07-16 context-engineering talk (memory/versioning/dreaming at scale) names the inversion behind our own recorded failures: Hippo puts judgment in the write path (dedup-on-write deciding to replace content — which silently destroyed a dated log entry) while curation stays manual, where the production pattern is the opposite — write path dumb and deterministic (append-safe, hash-preconditioned, permission-guarded), judgment scheduled out-of-band with human-reviewed proposals. The talk also *validates* the core bet: its portability principle (files with a standalone API on top) is Hippo's thesis — the "file systems are state of the art" claim only holds when agents share a filesystem, which cross-surface agents don't. Concretely adopted: the four ROADMAP items (append-safe writes, `precondition_hash`, protected entities, mutation audit log).
**Instead of:** replacing Hippo with file-system memory (rejected — no shared filesystem across Claude.ai / ChatGPT / launchd agents; the file memory remains the in-repo arm, Hippo the cross-surface arm); observation-level version history (re-rejected — conflicts with `secure_delete`, see CLAUDE.md's entity-versioning decision; the audit log records who/when/which-entity, never content).
**Status:** active.
**Where:** `ROADMAP.md` → "Next — production-memory block"; ops-side dreaming pass in `~/chief-of-staff/ROADMAP.md` #19; AppKeep shared instance in AppKeep `DECISIONS_LOG.md` D.110.

### D1 · 2026-06-23 · Adopt the three-doc convention (PRODUCT / ROADMAP / DECISIONS)
**Why:** consistency across repos — PRODUCT = gap + bet (+ success criterion + non-priorities); ROADMAP = coherent action (now/next/later); DECISIONS = go-forward log. Converted `TODO.md` → `ROADMAP.md`; added the missing convention pieces to PRODUCT (an adoption-style success criterion — hippo is free/open-source, not a paying-user gate — and the non-priorities named).
**Instead of:** numbering the CLAUDE.md design decisions and relocating them to PRODUCT/DECISIONS (rejected — they're architecture reference, not the strategic *bet*, and reorganizing a large working list is over-touch; keep them in CLAUDE.md).
**Status:** active.
**Where:** `PRODUCT.md`, `ROADMAP.md`, this file; convention set for all repos in global `CLAUDE.md`.
