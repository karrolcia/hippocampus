# Agent Continuity Layer — Technical Spec

## Problem

Agent instructions (scheduled tasks, workflows, runbooks) are stored in
`.claude/scheduled-tasks/` — a local directory that only Claude Code can read.
When Claude Code goes down, those instructions are inaccessible. No other AI
can pick them up. The agent stops.

Skills already live in Hippocampus (`skill:<name>`, type `skill`). Scheduled tasks
don't. This creates a single-provider dependency for the most operational part
of the system: the things that need to run on a schedule.

## Design Principles

1. **Hippocampus stores what and when, not how.**
   The instruction (prompt), the schedule, and the last checkpoint. Never the
   execution engine. Each AI runtime translates instructions into its own
   execution style.

2. **No schema changes.**
   Uses existing entities, observations, kinds, and relationships. Convention
   over configuration. V7 schema is sufficient.

3. **Hippo is source of truth, disk is cache.**
   `.claude/scheduled-tasks/` becomes a materialised view of what's in Hippo.
   Not the other way around. Claude Code can still read disk files, but Hippo
   is canonical.

4. **Last-writer-wins for state.**
   Whichever AI runs a task last writes the checkpoint. No distributed locking.
   No consensus protocol. One user, multiple runtimes, good enough consistency.

5. **Convention-compatible with existing skills.**
   Skills use `skill:<name>` with kind `trigger` + `content`.
   Agent tasks use `agent:<name>` with kind `instruction` + `schedule` + `checkpoint`.
   Same pattern. Same query surface.


## Entity Convention

```
Entity name:  agent:<task-id>
Entity type:  agent
```

Examples:
- `agent:chief-of-staff-briefing`
- `agent:nightly-session-check`
- `agent:signal-scan`
- `agent:holvi-export-reminder`

Relationships (auto-detected or explicit):
- `agent:chief-of-staff-briefing` → relates_to → `ops:active-threads`
- `agent:chief-of-staff-briefing` → relates_to → `ops:daily-log`


## Observation Schema

Each agent entity has up to three observations, differentiated by `kind`:

### kind: "instruction"

The prompt. What the AI should do. Equivalent to the body of a SKILL.md file.

```
You are Karolina's Chief of Staff agent. Gather context from these sources
and produce a short morning briefing:

1. From Hippocampus: recall("daily log operations"...) ...
2. Read ~/Documents/ops/pipeline.md ...
...

Keep it short and direct. No motivational framing.
```

Rules:
- Free-form text. No YAML frontmatter. The AI reads it as a prompt.
- Can reference other Hippo entities by name (skills, ops data).
- Can reference local files (~/Documents/ops/) — runtime decides if accessible.
- Maximum 50,000 chars (existing Hippo limit).

### kind: "schedule"

Structured metadata. When to run and what's needed.

```yaml
cron: 0 9 * * *
timezone: Europe/Helsinki
enabled: true
requires:
  - hippocampus
  - apple-mail
  - icloud-calendar
  - filesystem:~/Documents/ops/
description: Daily morning briefing — pipeline, content, deadlines, outreach
```

Rules:
- YAML-formatted for AI readability. Not parsed by Hippo — Hippo stores it as text.
- `cron`: standard 5-field expression. Empty string or absent = manual-only.
- `timezone`: IANA timezone. AI adjusts for its runtime environment.
- `enabled`: boolean. AI skips disabled tasks.
- `requires`: list of capabilities the runtime needs. AI checks before attempting.
  Capability names are conventions, not enforced:
  - `hippocampus` — Hippo MCP connection (always true if reading this)
  - `apple-mail` — Apple Mail MCP
  - `icloud-calendar` — iCloud calendar MCP
  - `filesystem:<path>` — local file access
  - `web-search` — internet search capability
  - `browser` — browser automation
- `description`: one-line human summary.

### kind: "checkpoint"

Last execution state. Written after each run.

```yaml
last_run: 2026-04-08T09:05:23+03:00
last_status: completed
last_runtime: claude-code
run_count: 47
last_summary: >
  Briefing delivered. 3 items flagged: Space4Good follow-up overdue,
  Q1 VAT return in 34 days, no session log from gallant context yesterday.
next_due: 2026-04-09T09:00:00+03:00
```

Rules:
- `last_runtime`: which AI ran it. Free-text identifier.
  Convention: `claude-code`, `claude-ai`, `chatgpt`, `gemini`, `ollama`, `cursor`.
- `last_status`: `completed`, `failed`, `partial`.
- `last_summary`: brief output summary. What happened, what was flagged.
- `next_due`: computed from cron + timezone. Helps other AIs decide whether to run.
- Updated via `remember(entity, kind: "checkpoint", replace_kind: true, content)`.
  Atomically replaces the previous checkpoint. No exact-match fragility.


## Agent Bootstrap Protocol

When a new AI session connects to Hippocampus (any platform):

### Step 1: Discover all agent tasks

```
recall("agent tasks scheduled", type: "agent", format: "index", limit: 50)
```

Returns entity index with version hashes. ~200 tokens for 10 agents.

### Step 2: Load tasks that need attention

For each agent entity, the AI checks:
- Is it enabled? (`kind: "schedule"` → `enabled: true`)
- Is it due? (`kind: "checkpoint"` → `next_due` vs current time)
- Can I run it? (`kind: "schedule"` → `requires` vs available tools)

Load full context only for actionable tasks:

```
context("agent:chief-of-staff-briefing")
```

Returns instruction + schedule + checkpoint + relationships.

### Step 3: Execute or skip

If due + enabled + capable:
1. Read instruction (kind: "instruction")
2. Execute the prompt
3. Write checkpoint (kind: "checkpoint") via `update()`

If not capable (missing requirements):
- Skip silently. Another runtime will handle it.
- Optionally note in checkpoint: `last_skip: "missing apple-mail MCP"`

### Step 4: Report

If the task has a relationship to `ops:daily-log`, write a session log entry
per existing session protocol.


## Execution Coordination

### Problem: Two AIs run the same task

Without distributed locking, two runtimes could both decide a task is due
and execute simultaneously.

### Solution: Optimistic checkpoint check

Before executing, read the checkpoint:

```
context("agent:chief-of-staff-briefing")
→ checkpoint.last_run = 2026-04-08T09:05:23+03:00
→ checkpoint.next_due = 2026-04-09T09:00:00+03:00
```

If `last_run` is within the current scheduling window (e.g., today for a daily
task), skip. Another runtime already handled it.

This is not bulletproof. Two AIs checking at the exact same moment could
both proceed. Acceptable for single-user self-hosted — worst case is a
duplicate briefing, not data loss.

### Problem: Task fails halfway

Write checkpoint with `last_status: partial` and include what was completed
in `last_summary`. Next runtime reads the partial state and can resume or retry.


## Sync with Claude Code

Claude Code reads `.claude/scheduled-tasks/<name>/SKILL.md`. To maintain
backward compatibility:

### Hippo → Disk (materialise)

A sync skill (or startup hook) reads all `type: "agent"` entities from Hippo
and writes corresponding SKILL.md files:

```
~/.claude/scheduled-tasks/<task-id>/SKILL.md
```

Format:

```markdown
---
name: <task-id>
description: <from schedule observation>
---

<instruction observation content>
```

The cron expression maps to Claude Code's scheduled-task config (separate from
SKILL.md — stored in Claude Code's internal state).

### Disk → Hippo (migrate)

One-time migration: read all existing SKILL.md files, create corresponding
`agent:<name>` entities in Hippo with instruction + schedule observations.

Script or skill that runs once, then disk becomes the cache.


## Migration Path

### Phase 1: Store (this spec)

Define the entity convention. Migrate existing scheduled tasks to Hippo.
9 tasks currently in `.claude/scheduled-tasks/`:

| Task | Cron | Requires |
|------|------|----------|
| chief-of-staff-briefing | 0 9 * * * | hippo, mail, calendar, filesystem |
| nightly-session-check | 47 21 * * * | hippo |
| signal-scan | 17 8 * * 1 | hippo, web-search |
| holvi-export-reminder | 0 10 1 * * | hippo |
| linkedin-data-export-reminder | 0 9 * * 1 | hippo |
| knowledge-compile | — | hippo |
| knowledge-harvest | — | hippo |
| knowledge-synthesis | — | hippo |
| seed-repos-v4 | — | hippo, filesystem |

### Phase 2: Bootstrap

Add agent bootstrap to session protocol (CLAUDE.md). On session start:

```
1. recall("daily log session", type: "operations")
2. context("ops:active-threads")
3. recall("agent tasks", type: "agent", format: "index")   ← NEW
```

The third step gives any AI visibility into what agent tasks exist.

### Phase 3: Cross-runtime execution

Build the checkpoint write pattern. Test with:
1. Claude Code runs chief-of-staff-briefing at 09:03
2. Claude Code goes down
3. ChatGPT (with Hippo MCP) reads the agent task, sees it's due, runs it

This is the proof point. Same briefing, different engine.

### Phase 4: Ollama fallback

Local LLM with MCP client connects to Hippo. Reads agent tasks. Executes
what it can (Hippo-only tasks — no mail, no calendar). Gracefully skips
tasks with unmet requirements.

Degraded but not dead. The agent keeps running.


## What This Does Not Include

- **Orchestration**: Hippo doesn't schedule, trigger, or dispatch. The AI
  runtime decides when to check and what to run.
- **Execution engine**: No cron daemon in Hippo. No task queue. No webhooks.
- **Multi-user coordination**: Single user, multiple runtimes. Not multi-tenant.
- **Guaranteed exactly-once execution**: Optimistic, not transactional.
  Acceptable for the use case.
- **New MCP tools**: No new `run-agent` or `schedule-agent` tool. Uses existing
  `remember`, `recall`, `update`, `context`. Convention only.
- **New schema migrations**: V7 is sufficient.


## Open Questions

1. **~~Should checkpoint writes use `remember` or `update`?~~** RESOLVED.
   Neither. Added `replace_kind` parameter to `remember`. When `replace_kind: true`
   and `kind` is set, atomically deletes all existing observations with the same
   kind on the entity, then creates the new one. No exact-match fragility
   (`update`), no accumulation (`remember`). Kind-scoped upsert.

2. **Should there be a dedicated `recall` shorthand?**
   `recall(type: "agent", kind: "schedule", format: "compact")` returns all
   schedules. Useful but not strictly necessary — the index format already
   surfaces agent entities cheaply.

3. **How to handle timezone across runtimes?**
   Store timezone in schedule observation. AI converts to local time. But what
   if the runtime doesn't know its timezone? Convention: UTC fallback, note
   in checkpoint.

4. **Should failed tasks alert?**
   If a task writes `last_status: failed`, the next runtime that connects
   could surface it. But that's a UI/notification concern, not a Hippo concern.
   Leave to the consuming AI's judgment.
