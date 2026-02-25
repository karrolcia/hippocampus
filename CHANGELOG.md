# Changelog

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
