# Changelog

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
