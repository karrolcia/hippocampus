# Spec — Hippocampus bridge (Slack in, GitHub in, brain out)

*A Hippocampus client, not a server feature. Status: specified 2026-10-08, re-read against main 2026-10-28 (D26 to D28 landed in between; folded in below), not built. Supersedes the two separate specs of 2026-10-07 (a Slack app and a GitHub Action); the Action is dropped because CI is the wrong place for plumbing that has to be debugged. Generic: any team that self-hosts a Hippocampus instance can run one bridge per instance. Deployment specifics stay with the deployment.*

- **HELPS:** When a team member finishes a call, reads a thread that settled something, merges a pull request, or lands a decision line, they want the shared brain to already know, so the next person's AI, in another time zone tomorrow, reads the current state without anyone copying by hand or configuring a connector. Today the brain is empty unless someone copies twice, which nobody does.

- **OUTCOME:** One small long-running service, **the bridge**, in one container beside the Hippocampus instance. Two inputs, one output, no LLM, writes only.
  - **Slack side** (Socket Mode, no public address): three gestures and nothing else.
    1. **Save to brain**, a message shortcut on any message. Opens a modal with one optional field, *Entity*, pre-filled with the channel default. Saves the message verbatim, or the whole thread if the message is a thread parent, stamped with author, channel, date and permalink.
    2. **`/remember <text>`** writes one line to the channel's default entity; `/remember` alone opens the same modal.
    3. **`/recall <query>`** runs `recall(format: "compact", limit: 5)` and replies ephemerally.
  - **GitHub side** (polling, read-only token, no CI, no webhook): every `GITHUB_POLL_SECONDS` (default 300) the bridge asks the GitHub API what changed in one repository since its cursor and mirrors three kinds of event:
    1. **Pull request merged** → appended to `repo:<repo>` (`kind: "merge"`: title, URL, who merged, date), then, if the PR or its linked issue carries a unit label (`jar:<name>` by default), the unit's status is replaced: entity `jar:<name>`, `kind: "status"`, `replace_kind: true`, content = PR title and URL, the issue's title and its done-when (the issue body's first section), merge date.
    2. **`DECISIONS.md` changed on the default branch** → each new entry appended verbatim to `decisions:<repo>` (`kind: "decision"`), with the commit URL on the last line. Cap 10 per poll; more is a bulk import, skipped with a warning.
    3. **Issue closed with the `bug` label** → appended to `bugs:<repo>` (`kind: "bug"`: title, URL, body with its four parts, closed date).
  - Either side can be switched off by leaving its variables unset, so a GitHub-only bridge (no Slack workspace) or a Slack-only bridge is the same image.
  - Done = a teammate saves a thread and another teammate's `/recall` finds it with the saver's Slack name as `source`; a merged PR labelled `jar:parcels` leaves exactly one `status` on `jar:parcels` and one `merge` on `repo:<repo>`; a push with two new decision entries leaves exactly two `decision` observations; a second poll changes nothing.

- **WHY one service and no Action:** a GitHub Action runs inside a repository's CI, is configured in YAML, holds secrets in repository settings, and is debugged by re-running workflows. The bridge is a process with logs, testable from a laptop against any repository its token can read. The only thing on GitHub's side is a fine-grained read-only token for the one repository. Polling over webhooks: no inbound route, no signature checking, no missed deliveries, five-minute latency that nobody notices.

- **WHY one-way, into the brain only:** the repository is the record. The brain mirrors it so agents read it next to what was said in Slack. The bridge never writes to GitHub or posts status to Slack (the Slack-native GitHub app owns status). A decision enters the brain only through the `DECISIONS.md` diff, so the brain can never hold a decision the file does not.

- **WHY zero server changes:** Hippocampus has one identity per instance and no per-user permissioning (PRODUCT.md non-priorities). The bridge holds one agent token at `write:` scope (D28: `remember` with `replace_kind`, `recall`, `context`; no `forget`, `update`, `merge`, `merge_entities`), so even a leaked bridge token cannot delete by id or entity. Slack supplies the author on every write (`source: slack:<display-name>`), GitHub supplies it on every mirrored event (`source: github:<login>`). Humans never see the Hippocampus login.

- **Slack details (manifest, so an admin creates the app in minutes):**
  - Socket Mode: app-level token (`xapp-…`) with `connections:write`. No signing secret is needed in Socket Mode.
  - Bot token scopes (`xoxb-…`): `commands`, `chat:write`, `users:read`, `channels:history` (reads only channels the bot is invited to; invite it to the one working channel), `groups:history` only for a private channel. Saving a thread needs `conversations.replies`, hence the history scope; a single message does not.
  - One message shortcut, one modal, two slash commands. `users.info` resolves display names, cached in memory.
  - Slack retries on a 3 s timeout: acknowledge first, write after, and dedupe on `trigger_id` for 60 s so a retry never double-writes.

- **GitHub details:**
  - Token: fine-grained personal access token, one repository, read-only on Contents, Issues, Pull requests, Metadata. Created by a repository admin; stored only in the bridge's environment.
  - Queries per poll: closed PRs sorted by `updated` (keep those with `merged_at` after the cursor); commits on the default branch touching `DECISIONS.md` since the cursor (for each, the file at the commit and at its parent, entries diffed by heading); closed issues labelled `bug` with `closed_at` after the cursor. Linked issue for a PR: GraphQL `closingIssuesReferences`, falling back to the first `#N` in the PR body. Well under 100 API calls an hour at team scale, against a 5,000 limit.
  - **Cursor and idempotency.** A small JSON file on the bridge's volume: last poll time per source plus the ids already mirrored (PR numbers, commit SHAs, issue numbers; pruned past 30 days). On a failed write the cursor does not advance and the id is not recorded, so the next poll retries. On first start the cursor is *now*: no backfill unless `GITHUB_SINCE=<date>` is set, and then decisions backfill is capped the same way.
  - **Decision-entry extraction.** An entry starts at a line matching `^### D-?\d+` and runs to the next such line. "New" means present after and absent, by heading, before. Edits to old entries (a Status line changing) are ignored on purpose.
  - **Naming (lock per repository):** the unit of work is identified only by a label `<unit_prefix>:<name>` on the PR or its linked issue. Titles are never parsed. Missing label → only the `repo:` merge entry, and the log says so. `UNIT_PREFIX` defaults to `jar`.
  - **Linking:** Hippocampus creates relationships only by detecting entity names in content. The bridge writes the unit's entity name into every decision and bug body that carries the label, so spreading activation reaches them.

- **Hippocampus client contract (verified 2026-10-07, re-verified 2026-10-28 against `src/index.ts`, `src/auth/scopes.ts`, `scripts/sync-agents.ts`, `src/mcp/tools/remember.ts`):**
  - POST `<HIPPO_URL>/mcp`, `Authorization: Bearer <token>`, `Accept: application/json, text/event-stream`. Initialize with `protocolVersion: "2025-03-26"`, capture `mcp-session-id`, send `notifications/initialized`, then `tools/call`. Copy `HippoClient` from `scripts/sync-agents.ts`.
  - Sessions are swept after 30 idle minutes; a `404` with JSON-RPC `-32001 Session not found` means re-initialize and retry once, transparently. A long-running bridge hits this after every quiet half hour. Since D28 a session is bound to the scope of the token that created it, and `-32001 Session was created under a different token scope` is the same signal: re-initialize. Never share one `mcp-session-id` across tokens.
  - Token entry on the instance: `write:<hex>` in the comma-separated `HIPPO_AGENT_TOKEN` list (D28). A bare entry is `full`, which the bridge must not hold. The write scope lists only the tools it may call, so a mis-wired `forget` fails with an error naming the scope rather than deleting anything.
  - Rate limit on `/mcp`: 60 requests per minute per client address (D26: the proxy-written `X-Forwarded-For` hop, else the socket peer). A poll writes at most a dozen; Slack traffic is human-paced.
  - Field limits: `content` 50,000, `entity` 200, `source` 100, `kind` 50. A long thread or issue body is truncated at the limit with the header and link kept and `[truncated]` stated.
  - Never pass `importance` or `type` from the bridge; `replace_kind` only on unit status. Curation is out of band.
  - **Dedup hazard, and the one instance setting the deployment must make.** Dedup-on-write deletes the shorter of two ≥0.85-similar observations written to the same non-append-only entity on the same UTC day. Everything the bridge appends must sit under an append-only prefix: the instance's `HIPPO_APPEND_ONLY_PREFIXES` must include `slack:`, `decisions:`, `bugs:`, `repo:` and the team's call-note prefix. Setting that variable **replaces** the defaults, so list every prefix wanted. Unit entities (`jar:`) must **not** be append-only: status relies on `replace_kind`, which replaces only `status` observations and leaves a human's `note` alone. A user who types a unit entity into the Save modal accepts same-day dedup on it; the modal says so in one line.

- **Read shape.** `/recall` → `recall({ query, format: "compact", limit: 5 })`, ephemeral. If `degraded: true`, one prefixed line says the semantic leg was unavailable. Queries under 3 characters get the usage line.

- **Failure behaviour.** Every Hippocampus or GitHub error is logged in full and, on the Slack side, shown to the user as an ephemeral one-liner. The GitHub side never advances past a failed item. No silent catch anywhere. Container logs are the only health surface; `docker logs bridge` after a poll shows one line per mirrored event or one line saying nothing changed.

- **Packaging.** Own repository (`hippocampus-bridge`; a client, so it fits PRODUCT.md either way, and its own repo lets a team fork it without touching the server). Node 20, `@slack/bolt`, `@octokit/rest` (or plain `fetch`), nothing else. Ships as a Dockerfile, a `docker-compose.yml` fragment, `app-manifest.yml` for Slack, and a README under one page. Same container hygiene as the server (`read_only`, `cap_drop: ALL`, `no-new-privileges`, a volume for the cursor file). Environment:
  `HIPPO_URL`, `HIPPO_AGENT_TOKEN` (required); `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (Slack side); `GITHUB_TOKEN`, `GITHUB_REPO` (`owner/name`), `GITHUB_POLL_SECONDS` (300), `GITHUB_SINCE` (unset), `UNIT_PREFIX` (`jar`), `DONE_WHEN_HEADING` (unset = first section).

- **LOCKED:**
  - One bridge per Hippocampus instance; one `write:`-scoped agent token per bridge, its own entry in the instance's comma-separated list, revocable alone. A bridge never writes to two brains.
  - Writes only: `remember` and `recall`. No delete path exists.
  - No LLM. The bridge copies what was said and what was done; summarising is an agent's job later, reading the brain.
  - No status posting to Slack, no writes to GitHub.
  - Default-branch commits only for decisions.

- **ASSUMES (verify before building):**
  - Slack's shortcut payload carries `message.thread_ts` for thread parents, so one `conversations.replies` call fetches the thread; free plans hide history older than 90 days, which bounds Save.
  - Bolt's Socket Mode reconnects on its own after network loss without dropping queued acknowledgements.
  - A fine-grained token on one private repository can read `closingIssuesReferences` via GraphQL; if not, the `#N` fallback carries it.
  - The `DECISIONS.md` file lives at the repository root on the default branch; a different path is a config input to add if a repository needs it.

- **SIZE:** one session for the GitHub side tested from a laptop against any repository the token can read, writing to a test token on an existing instance; one session for the Slack side in a free dev workspace; half a session for image, manifest, README and hardening.

- **CLOSE:** in a dev workspace, Save a three-reply thread and `/recall` a phrase from the second reply; in a scratch repository, merge a PR labelled `jar:test` with a linked issue, push two new decision entries in one commit, close a `bug` issue; wait one poll: `context("jar:test")` shows exactly one `status`, `context("repo:<repo>")` one new `merge`, `context("decisions:<repo>")` exactly two new observations ending in a commit URL, `context("bugs:<repo>")` one; wait another poll: nothing changes; restart the Hippocampus container and confirm the next `/remember` and the next poll succeed without a visible error.

- **LOAD before building:** `README.md`, `scripts/sync-agents.ts` (`HippoClient`), `src/index.ts` (session TTL, the two `-32001` 404s), `src/auth/scopes.ts` (what `write:` may call), `src/mcp/tools/remember.ts` (schema, `replace_kind`, dedup guards), `.env.example` (scope prefixes, append-only semantics), `infra/README.md` (backup and restore drill, D27, for the instance the bridge sits beside). Slack: Bolt JS Socket Mode, message shortcuts, modals, app manifests. GitHub: fine-grained tokens, REST `pulls`/`commits`/`issues`, GraphQL `closingIssuesReferences`.
