#!/usr/bin/env tsx
/**
 * sync-agents.ts — Sync Claude Code scheduled tasks between disk and Hippocampus.
 *
 * Implements Phase 1 (disk → Hippo migration) and Phase 3 (Hippo → disk
 * materialization) of the Agent Continuity Layer spec (docs/spec-agent-continuity.md).
 *
 * Hippocampus is canonical. Disk is a cache for Claude Code. Any MCP-connected
 * runtime can read the agent tasks from Hippo without needing the disk files.
 *
 * Commands:
 *   push [--dry-run]     Read ~/.claude/scheduled-tasks/<id>/SKILL.md and
 *                        scripts/agents-manifest.json, write agent:<id> entities
 *                        to Hippo with instruction + schedule observations.
 *
 *   pull [--dry-run]     Read type:agent entities from Hippo, materialize as
 *                        ~/.claude/scheduled-tasks/<id>/SKILL.md. Existing files
 *                        are backed up to SKILL.md.bak before overwrite.
 *
 *   list                 Show the agent entities currently in Hippo.
 *
 * Environment:
 *   HIPPO_ENDPOINT       Default https://hippo.sarna.rocks/mcp
 *   HIPPO_AGENT_TOKEN    Primary token source. If unset on macOS, falls back to
 *                        Keychain (service=hippocampus-agent, account=karolina).
 *
 * Run:
 *   tsx scripts/sync-agents.ts push --dry-run
 *   tsx scripts/sync-agents.ts push
 *   tsx scripts/sync-agents.ts pull --dry-run
 *   tsx scripts/sync-agents.ts list
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  statSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ───────────────────────────────────────── Config ─────────────────────────────────────────

const ENDPOINT = process.env.HIPPO_ENDPOINT ?? "https://hippo.sarna.rocks/mcp";
const TASKS_DIR = join(homedir(), ".claude", "scheduled-tasks");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(SCRIPT_DIR, "agents-manifest.json");
const CLIENT_INFO = { name: "sync-agents", version: "1.0" };
const KEYCHAIN_SERVICE = process.env.HIPPO_KEYCHAIN_SERVICE ?? "hippocampus-agent";
const KEYCHAIN_ACCOUNT = process.env.HIPPO_KEYCHAIN_ACCOUNT ?? "karolina";

// ───────────────────────────────────────── Types ─────────────────────────────────────────

interface SkillFrontmatter {
  name: string;
  description?: string;
  model?: string;
}

interface ScheduleMeta {
  cron: string;
  timezone: string;
  enabled: boolean;
  requires: string[];
  description: string;
  model?: string;
  runtime_hint?: string;
}

interface ManifestEntry {
  cron: string;
  timezone: string;
  enabled: boolean;
  requires: string[];
  runtime_hint?: string;
}

interface Manifest {
  version: number;
  agents: Record<string, ManifestEntry>;
}

interface AgentEntity {
  name: string;
  instruction: string;
  schedule: ScheduleMeta;
  frontmatter: SkillFrontmatter;
}

// ─────────────────────────────────── YAML helpers ────────────────────────────────────────
// The format is ours — minimal stringify/parse avoids pulling a YAML dependency
// into scripts/. Only flat maps, scalar strings/bools, and a single list (requires).

function parseFrontmatter(content: string): { fm: SkillFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("no YAML frontmatter delimiter found");
  const raw = match[1];
  const body = match[2].replace(/^\r?\n/, "").trimEnd();
  const fm: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    fm[kv[1]] = kv[2].trim();
  }
  if (!fm.name) throw new Error("frontmatter missing required 'name' field");
  return { fm: fm as unknown as SkillFrontmatter, body };
}

function stringifyFrontmatter(fm: SkillFrontmatter): string {
  const lines = [`name: ${fm.name}`];
  if (fm.description) lines.push(`description: ${fm.description}`);
  if (fm.model) lines.push(`model: ${fm.model}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

function stringifyScheduleYaml(s: ScheduleMeta): string {
  const lines: string[] = [];
  lines.push(`cron: ${s.cron ? quoteIfNeeded(s.cron) : '""'}`);
  lines.push(`timezone: ${s.timezone}`);
  lines.push(`enabled: ${s.enabled}`);
  if (s.requires.length === 0) {
    lines.push(`requires: []`);
  } else {
    lines.push(`requires:`);
    for (const r of s.requires) lines.push(`  - ${r}`);
  }
  lines.push(`description: ${s.description}`);
  if (s.model) lines.push(`model: ${s.model}`);
  if (s.runtime_hint) lines.push(`runtime_hint: ${s.runtime_hint}`);
  return lines.join("\n") + "\n";
}

function quoteIfNeeded(v: string): string {
  // cron expressions contain * which is fine unquoted in YAML block style,
  // but quote to be safe for any downstream YAML consumer.
  return /[*:#]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

function parseScheduleYaml(content: string): ScheduleMeta {
  const out: Partial<ScheduleMeta> = { requires: [] };
  const lines = content.split(/\r?\n/);
  let inRequires = false;
  for (const line of lines) {
    if (inRequires) {
      const listItem = line.match(/^\s+-\s+(.+)$/);
      if (listItem) {
        out.requires!.push(listItem[1].trim());
        continue;
      }
      inRequires = false;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, rawV] = kv;
    const v = rawV.trim();
    if (k === "requires") {
      if (v === "[]" || v === "") {
        out.requires = v === "[]" ? [] : out.requires;
        inRequires = v !== "[]";
      } else {
        // inline list: requires: [a, b] — not our output format, but handle defensively
        const inline = v.match(/^\[(.*)\]$/);
        if (inline) {
          out.requires = inline[1].split(",").map(s => s.trim()).filter(Boolean);
        }
      }
      continue;
    }
    if (k === "enabled") out.enabled = v === "true";
    else if (k === "cron" || k === "timezone" || k === "description" || k === "model" || k === "runtime_hint") {
      (out as Record<string, string>)[k] = v.replace(/^"|"$/g, "");
    }
  }
  return {
    cron: out.cron ?? "",
    timezone: out.timezone ?? "Europe/Helsinki",
    enabled: out.enabled ?? false,
    requires: out.requires ?? [],
    description: out.description ?? "",
    model: out.model,
    runtime_hint: out.runtime_hint,
  };
}

// ─────────────────────────────────── Token fetch ────────────────────────────────────────

function getToken(): string {
  const envToken = process.env.HIPPO_AGENT_TOKEN;
  if (envToken && envToken.length >= 32) return envToken;
  if (process.platform !== "darwin") {
    throw new Error("HIPPO_AGENT_TOKEN not set and Keychain fallback is macOS-only");
  }
  let token: string;
  try {
    token = execSync(
      `security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    throw new Error(
      `token not found in Keychain (service=${KEYCHAIN_SERVICE}, account=${KEYCHAIN_ACCOUNT}) ` +
      `and HIPPO_AGENT_TOKEN env var not set`
    );
  }
  if (token.length < 32) throw new Error("Keychain token too short (<32 chars)");
  return token;
}

// ─────────────────────────────────── MCP HTTP client ────────────────────────────────────

export class HippoClient {
  private sessionId: string | null = null;
  private reqId = 1;

  constructor(private readonly endpoint: string, private readonly token: string) {}

  async init(): Promise<void> {
    const res = await this.fetch({
      jsonrpc: "2.0",
      id: this.reqId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    }, { captureSession: true });
    // `fetch` sets this.sessionId on captureSession
    if (!this.sessionId) throw new Error("initialize did not return mcp-session-id");
    // Consume the result so any SSE stream drains
    void res;
    await this.fetch({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  }

  async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.fetch({
      jsonrpc: "2.0",
      id: this.reqId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    // Tool responses come back as { content: [{type: "text", text: "..."}] }
    // where `text` is JSON of the tool's actual return value.
    const content = (result as { content?: Array<{ type: string; text: string }> }).content;
    if (!content || content.length === 0) {
      throw new Error(`tool ${name}: empty content in response`);
    }
    const first = content[0];
    if (first.type !== "text") throw new Error(`tool ${name}: non-text content`);

    // An MCP tool failure is IN-BAND: HTTP 200, a normal content array, and
    // `isError: true` alongside it. Without this check the error text falls
    // through to the JSON.parse below, fails to parse, and is returned as a
    // plain string — so every caller received a `string` where it expected its
    // result type. That was not merely a confusing crash downstream: `cmdPush`
    // wraps these calls in try/catch and counts `ok++` on no-throw, so a
    // `remember` that the server rejected printed a tick and the run exited 0
    // having written nothing. Same shape as the exit-code trap in the global
    // notes — a success signal that is not measuring success.
    if ((result as { isError?: boolean }).isError === true) {
      throw new Error(`tool ${name} failed: ${first.text.slice(0, 500)}`);
    }

    try {
      return JSON.parse(first.text) as T;
    } catch {
      // Some tools may return plain text
      return first.text as unknown as T;
    }
  }

  private async fetch(
    body: unknown,
    opts: { captureSession?: boolean } = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await globalThis.fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (opts.captureSession) {
      this.sessionId = res.headers.get("mcp-session-id");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }
    // Notifications return 202 with no body
    if (res.status === 202) return null;
    const ct = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    if (!raw) return null;
    let envelope: { result?: unknown; error?: { code: number; message: string } };
    if (ct.includes("text/event-stream")) {
      // Parse the first `data:` line (we do not stream multi-event responses)
      const dataLine = raw
        .split(/\r?\n/)
        .find((l) => l.startsWith("data:"));
      if (!dataLine) throw new Error("SSE response had no data line");
      envelope = JSON.parse(dataLine.replace(/^data:\s*/, ""));
    } else {
      envelope = JSON.parse(raw);
    }
    if (envelope.error) {
      throw new Error(`JSON-RPC error ${envelope.error.code}: ${envelope.error.message}`);
    }
    return envelope.result;
  }
}

// ───────────────────────────────────── Commands ─────────────────────────────────────────

function loadTasksFromDisk(): AgentEntity[] {
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (!existsSync(TASKS_DIR)) {
    throw new Error(`tasks directory not found: ${TASKS_DIR}`);
  }
  const entries = readdirSync(TASKS_DIR).filter((d) => {
    const p = join(TASKS_DIR, d);
    return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"));
  });
  entries.sort();

  const agents: AgentEntity[] = [];
  for (const taskId of entries) {
    const skillPath = join(TASKS_DIR, taskId, "SKILL.md");
    const content = readFileSync(skillPath, "utf8");
    const { fm, body } = parseFrontmatter(content);
    if (fm.name !== taskId) {
      console.warn(
        `⚠ ${taskId}: directory name differs from frontmatter name "${fm.name}"; using frontmatter`
      );
    }
    const m = manifest.agents[fm.name];
    const schedule: ScheduleMeta = {
      cron: m?.cron ?? "",
      timezone: m?.timezone ?? "Europe/Helsinki",
      enabled: m?.enabled ?? false,
      requires: m?.requires ?? ["hippocampus"],
      description: fm.description ?? "",
      model: fm.model,
      runtime_hint: m?.runtime_hint,
    };
    if (!m) {
      console.warn(`⚠ ${fm.name}: no manifest entry, using defaults (disabled, no cron)`);
    }
    agents.push({ name: fm.name, instruction: body, schedule, frontmatter: fm });
  }
  return agents;
}

async function cmdPush(dryRun: boolean): Promise<void> {
  const agents = loadTasksFromDisk();
  console.log(`Found ${agents.length} tasks on disk at ${TASKS_DIR}`);

  if (dryRun) {
    for (const a of agents) {
      const entity = `agent:${a.name}`;
      console.log(`\n→ ${entity}`);
      console.log(`  cron="${a.schedule.cron}" enabled=${a.schedule.enabled} requires=${JSON.stringify(a.schedule.requires)}`);
      console.log(`  instruction: ${a.instruction.length} chars`);
      console.log(`  schedule yaml:\n${indent(stringifyScheduleYaml(a.schedule), "    ")}`);
    }
    console.log("\n(dry run — no network calls made)");
    return;
  }

  const client = new HippoClient(ENDPOINT, getToken());
  await client.init();
  console.log(`Connected to ${ENDPOINT}`);

  let ok = 0;
  let failed = 0;
  for (const a of agents) {
    const entity = `agent:${a.name}`;
    try {
      await client.call("remember", {
        entity,
        type: "agent",
        kind: "instruction",
        replace_kind: true,
        content: a.instruction,
        source: "sync-agents",
      });
      await client.call("remember", {
        entity,
        type: "agent",
        kind: "schedule",
        replace_kind: true,
        content: stringifyScheduleYaml(a.schedule),
        source: "sync-agents",
      });
      console.log(`✓ ${entity}`);
      ok++;
    } catch (err) {
      console.error(`✗ ${entity}: ${(err as Error).message}`);
      failed++;
    }
  }
  console.log(`\nPushed ${ok}/${agents.length} agents${failed ? ` (${failed} failed)` : ""}`);
  if (failed > 0) process.exit(1);
}

export interface RecallIndex {
  success: boolean;
  count: number;
  text: string;
  degraded?: boolean;
  degraded_reason?: string;
}

/**
 * `recall` reports a failed semantic leg as `degraded: true` and answers from
 * the keyword leg alone (D16). For this script that is not a cosmetic warning:
 * the agent index IS the work list, so a degraded index means a silently
 * shorter list of agents, and every count printed afterwards is measured
 * against it — `Materialized 3/3` is a true statement about a wrong 3.
 *
 * `degraded` is optional here only to stay honest about the wire: an older
 * server does not send the field, and absence must not be read as a healthy
 * `false`. It is treated as "unknown, assume healthy" rather than asserted,
 * because this script has to keep working against a server it did not deploy.
 */
export function describeDegradation(index: RecallIndex): string | null {
  if (index.degraded !== true) return null;
  return index.degraded_reason
    ? `semantic search was unavailable on the server — ${index.degraded_reason}`
    : "semantic search was unavailable on the server";
}

export async function cmdPull(
  dryRun: boolean,
  allowDegraded: boolean,
  // Injectable so the degraded REFUSAL below can be pinned by a test. Without
  // this the guard was deletable while the suite stayed green — the helper that
  // decides `degraded` was covered, the branch that acts on it was not, which is
  // the repo's own "a guard test needs a positive control" lesson in miniature.
  injectedClient?: HippoClient
): Promise<void> {
  const client = injectedClient ?? new HippoClient(ENDPOINT, getToken());
  if (!injectedClient) await client.init();

  const index = await client.call<RecallIndex>("recall", {
    query: "agent scheduled task",
    type: "agent",
    format: "index",
    limit: 50,
  });

  // `pull` writes to disk from this list, and its whole promise is that disk
  // ends up matching Hippocampus. A partial list cannot keep that promise: the
  // agents missing from it are not reported as missing, they are simply absent,
  // and nothing on disk or in the output says so. `list` prints a warning and
  // continues because showing a labelled subset is still an honest answer to
  // "what is there"; `pull` stops, because a labelled subset is not an honest
  // sync. Same split as D16 itself — disclose when there is something honest to
  // return, refuse when the operation would quietly mean something else.
  const degradation = describeDegradation(index);
  if (degradation && !allowDegraded) {
    throw new Error(
      `refusing to pull from a degraded index: ${degradation}. ` +
      `The agent list may be missing entries, and a partial pull looks identical to a complete one ` +
      `on disk. Re-run once the server is healthy, or pass --allow-degraded to accept a partial sync.`
    );
  }
  if (degradation) {
    console.warn(`⚠ pulling from a DEGRADED index (--allow-degraded): ${degradation}`);
    console.warn("  the agent list below may be incomplete — treat a missing agent as unknown, not absent");
  }

  // index format: "#I N results, M entities\n<entity>|<type>|<N obs>|<score>|v:<hash>"
  // Each line after the header starts with the entity name followed by a pipe.
  const entityNames = Array.from(
    index.text.matchAll(/^(agent:[\w.-]+)\|/gm)
  ).map((m) => m[1]);

  if (entityNames.length === 0) {
    console.log("No agent entities found in Hippocampus.");
    return;
  }
  console.log(`Found ${entityNames.length} agent entities in Hippo`);

  let written = 0;
  let failed = 0;
  let skipped = 0;
  for (const entity of entityNames) {
    try {
      const taskId = entity.slice("agent:".length);
      const ctx = await client.call<{
        success: boolean;
        entity: { name: string; observations: Array<{ content: string; kind?: string | null }> };
      }>("context", { topic: entity, depth: 0 });

      const observations = ctx.entity?.observations ?? [];
      // Prefer the kind field when the server exposes it; fall back to content
      // shape detection for pre-v0.4.2 servers where context omits kind.
      const looksLikeSchedule = (s: string) =>
        /^cron:\s*/m.test(s) && /^enabled:\s*/m.test(s);
      const instruction = (
        observations.find((o) => o.kind === "instruction") ??
        observations.find((o) => !looksLikeSchedule(o.content))
      )?.content;
      const scheduleRaw = (
        observations.find((o) => o.kind === "schedule") ??
        observations.find((o) => looksLikeSchedule(o.content))
      )?.content;

        if (!instruction) {
        // Counted, not just warned. `continue` used to bypass both counters, so
        // an entity whose instruction observation had been lost produced
        // `Materialized 0/1 agents to disk` and exit 0 — a sync that
        // materialized nothing, reporting success. The caller asked for this
        // agent on disk and did not get it; that is a failure, whatever the
        // cause sits in.
        console.warn(`⚠ ${entity}: no 'instruction' observation, skipping`);
        skipped++;
        continue;
      }
      const schedule = scheduleRaw ? parseScheduleYaml(scheduleRaw) : null;

      const fm: SkillFrontmatter = {
        name: taskId,
        description: schedule?.description,
        model: schedule?.model,
      };
      const skillMd = stringifyFrontmatter(fm) + instruction + "\n";

      const taskDir = join(TASKS_DIR, taskId);
      const skillPath = join(taskDir, "SKILL.md");

      if (dryRun) {
        console.log(`\n→ ${skillPath}`);
        console.log(indent(skillMd, "    "));
        continue;
      }

      mkdirSync(taskDir, { recursive: true });
      if (existsSync(skillPath)) {
        const bak = `${skillPath}.bak`;
        copyFileSync(skillPath, bak);
        console.log(`  backed up existing SKILL.md → ${bak}`);
      }
      writeFileSync(skillPath, skillMd, "utf8");
      console.log(`✓ ${skillPath}`);
      written++;
    } catch (err) {
      // Isolated per agent, matching cmdPush. Before the isError fix a failed
      // `context` call surfaced as an empty observation list and was reported as
      // "no 'instruction' observation, skipping" — a false explanation for a
      // call that never succeeded. It now says what actually happened, and one
      // unreachable agent no longer decides the fate of the other forty-nine.
      console.error(`✗ ${entity}: ${(err as Error).message}`);
      failed++;
    }
  }

  if (dryRun) {
    console.log("\n(dry run — no files written)");
  } else {
    const notes = [
      failed ? `${failed} failed` : null,
      skipped ? `${skipped} skipped` : null,
    ].filter(Boolean).join(", ");
    console.log(`\nMaterialized ${written}/${entityNames.length} agents to disk${notes ? ` (${notes})` : ""}`);
  }
  if (failed > 0 || skipped > 0) process.exit(1);
}

async function cmdList(): Promise<void> {
  const client = new HippoClient(ENDPOINT, getToken());
  await client.init();

  const index = await client.call<RecallIndex>("recall", {
    query: "agent scheduled task",
    type: "agent",
    format: "index",
    limit: 50,
  });
  const degradation = describeDegradation(index);
  if (degradation) {
    console.warn(`⚠ DEGRADED listing: ${degradation}`);
    console.warn("  this is a keyword-only subset — agents may be missing from it\n");
  }
  console.log(index.text);
}

// ───────────────────────────────────── Main ────────────────────────────────────────────

function indent(s: string, pad: string): string {
  return s.replace(/^/gm, pad);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dryRun = args.includes("--dry-run");
  const allowDegraded = args.includes("--allow-degraded");

  switch (cmd) {
    case "push":
      await cmdPush(dryRun);
      break;
    case "pull":
      await cmdPull(dryRun, allowDegraded);
      break;
    case "list":
      await cmdList();
      break;
    default:
      console.error(
        "usage: tsx scripts/sync-agents.ts <push|pull|list> [--dry-run] [--allow-degraded]\n\n" +
        "  push   migrate ~/.claude/scheduled-tasks/* → Hippocampus\n" +
        "  pull   materialize Hippocampus agents → ~/.claude/scheduled-tasks/*\n" +
        "  list   print the agent index from Hippocampus\n\n" +
        "  --allow-degraded   let pull proceed when the server reports a degraded\n" +
        "                     (keyword-only) index; the agent list may be incomplete"
      );
      process.exit(64);
  }
}

// Same main-module gate as src/index.ts: run the CLI only when this file IS the
// entrypoint, so a test can import HippoClient without the script firing main()
// (which would demand a token and hit the network). The fixes above are on a
// write path that reports its own success, which is exactly the kind that needs
// to stay regression-testable.
// Deliberately NOT byte-identical to the same gate in src/index.ts, which
// compares `import.meta.url` to `pathToFileURL(process.argv[1])`. Node resolves
// symlinks for `import.meta.url` but NOT for `process.argv[1]`, so behind a
// symlinked path the two disagree and the gate reads false. For the server that
// is nearly harmless — nothing starts listening and you notice at once. For a
// sync CLI it means exit 0 with no output, which is indistinguishable from
// "nothing to sync": precisely the silent-success failure this file was just
// fixed to stop producing. Reachable if the repo is ever checked out under a
// symlinked path — a symlinked ~/GitHub, an external volume, or a CI scratch
// dir under /tmp (on macOS /tmp is itself a symlink to /private/tmp).
function resolveRealPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolveRealPath(process.argv[1]) === resolveRealPath(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error(`\nerror: ${(err as Error).message}`);
    process.exit(1);
  });
}
