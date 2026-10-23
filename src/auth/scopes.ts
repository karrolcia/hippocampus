// Agent-token scopes (D28).
//
// Every HIPPO_AGENT_TOKEN entry may carry a scope prefix: `read:<token>`,
// `write:<token>`, `full:<token>`. A bare entry is `full`, so every token
// minted before D28 keeps working unchanged until it is rotated onto a scope.
// OAuth access tokens, the legacy HIPPO_TOKEN and the no-auth dev path are
// also `full`: they are the owner's interactive clients.
//
// A scope is a ceiling on which TOOLS a session can list and call. It is
// enforced in two places (see createMcpServer): out-of-scope tools are
// disabled, so `tools/list` never shows them, and `tools/call` refuses them
// with an error that names the scope. MCP resources are reads and stay
// available at every scope.
//
// `write` means "no explicit-delete tools", NOT "no deletion": `remember`
// can still evict an observation through dedup-replace, and `replace_kind`
// deletes every same-kind observation on the entity. Both are bounded and
// disclosed (`replaced: true` + the evicted text), and the AppKeep radar push
// needs `replace_kind`. What `write` cannot do is delete by id or by entity
// (`forget`), rewrite an arbitrary observation (`update`), or consolidate
// (`merge`, `merge_entities`).
//
// `consolidate` is `read`: it proposes and never deletes, its output (content
// plus observation ids) is what `recall` already returns to a read token, and
// the scheduled dreaming digest runs it unattended. Acting on a proposal
// needs `full`.

export const SCOPES = ['read', 'write', 'full'] as const;
export type Scope = (typeof SCOPES)[number];

const RANK: Record<Scope, number> = { read: 0, write: 1, full: 2 };

// The lowest scope that may list and call each tool. Every tool registered in
// src/mcp/server.ts MUST appear here: createMcpServer throws on a registered
// tool with no entry (fail closed — a new tool is never silently granted to a
// read-only token), and tests/agent-scopes.test.ts pins the keys against the
// live tools/list in both directions.
export const TOOL_MIN_SCOPE: Readonly<Record<string, Scope>> = Object.freeze({
  recall: 'read',
  context: 'read',
  export: 'read',
  check_version: 'read',
  get_observation: 'read',
  consolidate: 'read',
  // onboard is a pure read, but what it returns is a prompt telling the AI to
  // remember/update/merge. A read-only client would get instructions it
  // cannot carry out.
  onboard: 'write',
  remember: 'write',
  forget: 'full',
  update: 'full',
  merge: 'full',
  merge_entities: 'full',
});

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

export function narrowerScope(a: Scope, b: Scope): Scope {
  return RANK[a] <= RANK[b] ? a : b;
}

/** True when `scope` may list and call `tool`. Unknown tools are never allowed. */
export function scopeAllows(scope: Scope, tool: string): boolean {
  if (!Object.hasOwn(TOOL_MIN_SCOPE, tool)) return false;
  return RANK[scope] >= RANK[TOOL_MIN_SCOPE[tool]];
}

export interface AgentTokenEntry {
  token: string;
  scope: Scope;
}

export interface ParsedAgentTokens {
  entries: AgentTokenEntry[];
  /**
   * Scope labels that are not a known scope, one per rejected entry. The
   * label only — never the token. Such an entry never matches (fail closed
   * for that one token rather than for the whole server).
   */
  unknownLabels: string[];
}

// Minimum length of the token part of an entry. Applied after the prefix is
// split off, so `read:` cannot carry a short token over the floor.
export const AGENT_TOKEN_MIN_LENGTH = 32;

/**
 * Parse the comma-separated HIPPO_AGENT_TOKEN list.
 *
 * An entry is split on its FIRST colon. The tokens the mint scripts produce
 * are hex and never contain one, so a colon always means a scope prefix.
 * Entries whose token part is below the 32-char floor are dropped, exactly
 * as before D28.
 */
export function parseAgentTokens(raw: string | undefined): ParsedAgentTokens {
  const entries: AgentTokenEntry[] = [];
  const unknownLabels: string[] = [];
  if (!raw) return { entries, unknownLabels };
  for (const field of raw.split(',')) {
    const trimmed = field.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    let scope: Scope = 'full';
    let token = trimmed;
    if (colon !== -1) {
      const label = trimmed.slice(0, colon).trim();
      token = trimmed.slice(colon + 1).trim();
      if (!isScope(label)) {
        // Cap the label so a token pasted without its prefix but with a stray
        // colon deep inside cannot be echoed into a log line in full.
        unknownLabels.push(label.slice(0, 16));
        continue;
      }
      scope = label;
    }
    if (token.length < AGENT_TOKEN_MIN_LENGTH) continue;
    entries.push({ token, scope });
  }
  return { entries, unknownLabels };
}

/** Error text for a call outside the caller's scope. Names tool and scope, never the token. */
export function scopeRefusal(tool: string, scope: Scope): string {
  const needed = Object.hasOwn(TOOL_MIN_SCOPE, tool) ? TOOL_MIN_SCOPE[tool] : undefined;
  return needed
    ? `Tool "${tool}" needs the "${needed}" scope; this token is scoped "${scope}". ` +
        'Ask the server owner for a token with a wider scope.'
    : `Tool "${tool}" not found`;
}
