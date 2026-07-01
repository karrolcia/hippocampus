# Hippocampus — decisions (go-forward log)

*Append-only, newest first, `D-NNN`. Hippo's **architecture / design decisions** (SQLCipher-everything, local-embeddings-only, OAuth 2.1, Streamable HTTP, entity-versioning-not-supersession, consolidate = clustering-not-LLM-merge, dedup-on-write, …) live in `CLAUDE.md` → "Key Design Decisions" — that's the how-it's-built reference and stays there. This log records **go-forward** decisions and reversals; `PRODUCT.md` holds what-it-is + the bet.*

### D1 · 2026-06-23 · Adopt the three-doc convention (PRODUCT / ROADMAP / DECISIONS)
**Why:** consistency across repos — PRODUCT = gap + bet (+ success criterion + non-priorities); ROADMAP = coherent action (now/next/later); DECISIONS = go-forward log. Converted `TODO.md` → `ROADMAP.md`; added the missing convention pieces to PRODUCT (an adoption-style success criterion — hippo is free/open-source, not a paying-user gate — and the non-priorities named).
**Instead of:** numbering the CLAUDE.md design decisions and relocating them to PRODUCT/DECISIONS (rejected — they're architecture reference, not the strategic *bet*, and reorganizing a large working list is over-touch; keep them in CLAUDE.md).
**Status:** active.
**Where:** `PRODUCT.md`, `ROADMAP.md`, this file; convention set for all repos in global `CLAUDE.md`.
