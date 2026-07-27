/**
 * Param-name normalization for inbound MCP tool calls.
 *
 * Hippocampus tool schemas mix naming styles across tools — `forget` takes
 * `entity` + `observation_id`, `context` takes `topic` (not `entity`), etc.
 * Callers from every MCP client (Claude Code, Claude.ai, ChatGPT) regularly
 * reach for the wrong form (`entity_name`, `observationId`, `entityName`) and
 * hit opaque Zod validation errors.
 *
 * This module accepts lenient inputs at the wire boundary and rewrites them
 * to canonical schema names before Zod sees them. Canonical names stay the
 * wire contract — only inbound leniency is added.
 *
 * Mirrors the bash-side normalizer in ~/chief-of-staff/hippo-query.sh so the
 * same rules apply whether a caller hits the server through a custom bash
 * wrapper or directly via MCP. Both layers are idempotent: canonical inputs
 * pass through unchanged.
 */

const TOOL_PARAMS: Record<string, Set<string>> = {
  remember: new Set(['content', 'entity', 'type', 'source', 'importance', 'kind', 'replace_kind']),
  recall: new Set(['query', 'limit', 'type', 'since', 'kind', 'spread', 'format']),
  forget: new Set(['entity', 'observation_id', 'content']),
  update: new Set(['entity', 'old_content', 'new_content', 'kind']),
  context: new Set(['topic', 'depth']),
  merge: new Set(['observation_ids', 'content']),
  merge_entities: new Set(['source_entities', 'target_entity', 'target_type']),
  consolidate: new Set(['entity', 'threshold', 'mode', 'age_days']),
  export: new Set(['format', 'entity', 'type']),
  check_version: new Set(['entity', 'version_hash']),
  onboard: new Set(['source']),
};

// Semantic aliases: different param names that mean the same canonical thing.
// Forget's canonical is `entity`, but the disambiguating name `entity_name`
// (and its camelCase twin) is what callers reach for first. Context's
// canonical is `topic`, but most callers think of it as "the entity to fetch".
// Keep this list narrow — aggressive aliasing creates its own confusion.
const SEMANTIC_ALIASES: Record<string, Record<string, string>> = {
  forget: { entity_name: 'entity', entityName: 'entity' },
  context: { entity: 'topic', entity_name: 'topic', entityName: 'topic' },
};

// Destructive tools where a silently-dropped argument can WIDEN the blast
// radius: Zod strips unknown keys, so `forget({entity, contnet})` would fall
// through to a whole-entity delete. For these tools an unrecognized argument
// is a hard error, never a shrug. Error names the key only — never its value
// (observation content must not leak into logs or error responses).
const STRICT_TOOLS = new Set(['forget']);

function toSnake(s: string): string {
  return s.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();
}

function toCamel(s: string): string {
  const parts = s.split('_');
  return parts[0] + parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

export function normalizeParams(toolName: string, args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const canonical = TOOL_PARAMS[toolName];
  if (!canonical) return args;
  const aliases = SEMANTIC_ALIASES[toolName] ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (canonical.has(k)) {
      out[k] = v;
    } else if (k in aliases) {
      out[aliases[k]] = v;
    } else {
      const snake = toSnake(k);
      const camel = toCamel(k);
      if (canonical.has(snake)) {
        out[snake] = v;
      } else if (canonical.has(camel)) {
        out[camel] = v;
      } else if (STRICT_TOOLS.has(toolName)) {
        // Truncate the key: a malformed call could put content-like text in
        // the key position, and this error echoes into client logs.
        const keyLabel = k.length > 50 ? `${k.slice(0, 50)}…` : k;
        throw new Error(
          `${toolName}: unrecognized argument "${keyLabel}". Refusing to proceed — ` +
            `dropping it could change what gets deleted. ` +
            `Accepted arguments: ${[...canonical].join(', ')}.`
        );
      } else {
        out[k] = v; // unknown key — pass through, Zod strips it
      }
    }
  }
  return out;
}

// Exposed for unit tests only — not part of the public module surface.
export const _internal = { TOOL_PARAMS, SEMANTIC_ALIASES, toSnake, toCamel };
