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
 * same aliasing rules apply whether a caller hits the server through a custom
 * bash wrapper or directly via MCP. Both layers are idempotent: canonical
 * inputs pass through unchanged. Rejection is NOT mirrored and must not be —
 * the bash layer forwards keys it does not recognize ("let the server reject
 * it"), so for `STRICT_TOOLS` below this module is the only enforcement point
 * on that path.
 */

const TOOL_PARAMS: Record<string, Set<string>> = {
  remember: new Set(['content', 'entity', 'type', 'source', 'importance', 'kind', 'replace_kind']),
  recall: new Set(['query', 'limit', 'type', 'since', 'kind', 'spread', 'format']),
  forget: new Set(['entity', 'observation_id', 'content']),
  update: new Set(['entity', 'old_content', 'new_content', 'kind']),
  context: new Set(['topic', 'depth']),
  merge: new Set(['observation_ids', 'content']),
  merge_entities: new Set(['source_entities', 'target_entity', 'target_type']),
  consolidate: new Set(['entity', 'threshold', 'mode', 'age_days', 'include_append_only']),
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

// Tools carrying a parameter whose silent loss WIDENS the operation. The
// criterion is scope, not destructiveness: these tools take *restricting*
// arguments, so one that Zod strips makes the call act on more than was asked
// for — while the response still says `success`, describing an operation
// nobody requested. One such parameter is enough to qualify a tool.
//   forget — `observation_id` / `content` scope a delete to one observation;
//     drop one and `forget({entity})` deletes the whole entity (2026-07-27,
//     `skill:pseo-llm-visibility`).
//   recall — `since` / `type` / `kind` restrict an answer; drop one and the
//     caller gets history it did not ask for, indistinguishable from a genuine
//     result set. A scheduled sweep asking "what landed since my last run"
//     reads all of it as new (D14, the key-side mirror of D13's value-side
//     bug).
// Not every parameter on a strict tool restricts, and the exceptions are the
// reason this says "carrying a parameter" rather than "every parameter":
// `recall`'s `spread` WIDENS when present, so losing it fails safe (fewer
// results, never a false "everything is new"); `format` only changes
// rendering; `limit` cuts both ways against its default of 10. Strictness is
// justified by the restricting params and costs nothing on the others.
// The map value is the consequence clause quoted back to the caller — what
// dropping the argument would have changed, in that tool's own terms.
// The error names the key only, never its value (observation content and
// search queries must not leak into logs or error responses).
const STRICT_TOOLS = new Map<string, string>([
  ['forget', 'dropping it could change what gets deleted'],
  ['recall', 'dropping it could change what gets returned'],
]);

// Every map above is a plain object literal, so a bare `obj[key]` or `key in
// obj` also finds `Object.prototype`'s members — `constructor`, `toString`,
// `__proto__`, `valueOf`, … Left unguarded that is not cosmetic: `constructor`
// took the alias branch and skipped the strict throw entirely, and a tool
// named `constructor` resolved to the `Object` function and died on
// `canonical.has is not a function`. Own-property checks only, everywhere.
function toSnake(s: string): string {
  return s.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();
}

function toCamel(s: string): string {
  const parts = s.split('_');
  return parts[0] + parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/**
 * Assigns an own data property. A plain `out[k] = v` with `k === '__proto__'`
 * invokes the prototype setter instead of creating a key — so on a non-strict
 * tool a caller could smuggle in `{"__proto__": {"topic": "..."}}` and have
 * Zod read `topic` off the prototype as if it had been sent normally.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function normalizeParams(toolName: string, args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const canonical = Object.hasOwn(TOOL_PARAMS, toolName) ? TOOL_PARAMS[toolName] : undefined;
  if (!canonical) return args;
  const aliases = Object.hasOwn(SEMANTIC_ALIASES, toolName) ? SEMANTIC_ALIASES[toolName] : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (canonical.has(k)) {
      setOwn(out, k, v);
    } else if (Object.hasOwn(aliases, k)) {
      setOwn(out, aliases[k], v);
    } else {
      const snake = toSnake(k);
      const camel = toCamel(k);
      if (canonical.has(snake)) {
        setOwn(out, snake, v);
      } else if (canonical.has(camel)) {
        setOwn(out, camel, v);
      } else if (STRICT_TOOLS.has(toolName)) {
        // Truncate the key: a malformed call could put content-like text in
        // the key position, and this error echoes into client logs.
        const keyLabel = k.length > 50 ? `${k.slice(0, 50)}…` : k;
        throw new Error(
          `${toolName}: unrecognized argument "${keyLabel}". Refusing to proceed — ` +
            `${STRICT_TOOLS.get(toolName)}. ` +
            `Accepted arguments: ${[...canonical].join(', ')}.`
        );
      } else {
        setOwn(out, k, v); // unknown key — pass through, Zod strips it
      }
    }
  }
  return out;
}

// Exposed for unit tests only — not part of the public module surface.
export const _internal = { TOOL_PARAMS, SEMANTIC_ALIASES, STRICT_TOOLS, toSnake, toCamel };
