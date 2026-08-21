import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION } from '../config.js';
import { remember } from './tools/remember.js';
import { recall } from './tools/recall.js';
import { forget } from './tools/forget.js';
import { update } from './tools/update.js';
import { merge } from './tools/merge.js';
import { mergeEntities } from './tools/merge-entities.js';
import { context } from './tools/context.js';
import { consolidate } from './tools/consolidate.js';
import { exportMemories } from './tools/export.js';
import { checkVersion } from './tools/check-version.js';
import { onboard } from './tools/onboard.js';
import { registerContextResources } from './resources/context.js';
import { normalizeParams } from './param-normalization.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'hippocampus',
    version: VERSION,
  });

  server.tool(
    'remember',
    'Store a memory or piece of information. Use this to save facts, preferences, decisions, reasoning, or exploratory thinking. For facts and preferences, use telegraphic form — "PhD atmospheric physics, TU Delft" not "Karolina has a PhD in atmospheric physics from TU Delft". For rationale and exploration, capture the full reasoning — why a decision was made, what tradeoffs were weighed, or half-formed ideas worth preserving. Near-duplicate writes are deduplicated, which can DELETE the observation being duplicated: if the response has replaced: true, check replaced_observation before moving on — that text is gone otherwise. Dedup never touches observations from an earlier day, or entities in the configured append-only namespaces (log-style entities, flagged append_only in the response).',
    {
      content: z
        .string()
        .min(1)
        .max(50000)
        .describe('The information to remember (max 50000 chars. Note: semantic search uses first ~1500 chars for matching; longer content is still fully stored and retrievable by entity name, keyword, or context tool). Telegraphic for facts. Richer for reasoning and exploration.'),
      entity: z
        .string()
        .max(200)
        .optional()
        .describe('Entity this memory relates to (e.g., "user", "project:myapp", "preference"). Defaults to "general".'),
      type: z
        .string()
        .max(50)
        .optional()
        .describe('Category of entity (e.g., "person", "project", "preference")'),
      source: z
        .string()
        .max(100)
        .optional()
        .describe('Source of the information (e.g., "conversation", "explicit")'),
      importance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Importance score (0.0-1.0, default 1.0). Higher = boosted in recall ranking. Use for facts that should always surface.'),
      kind: z
        .string()
        .max(50)
        .optional()
        .describe('Classification: fact, decision, preference, rationale (why a decision was made, tradeoffs weighed), exploration (half-formed ideas, open questions), question, or custom. Filterable in recall.'),
      replace_kind: z
        .boolean()
        .optional()
        .describe('When true, atomically replaces any existing observation(s) with the same kind on this entity. Requires kind to be set. Use for state that should have exactly one observation per kind (e.g., agent checkpoints, schedules). Skips dedup — the caller explicitly wants replacement.'),
    },
    async (args) => {
      try {
        const sanitizedArgs = {
          content: args.content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
          entity: args.entity?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
          type: args.type,
          source: args.source,
          importance: args.importance,
          kind: args.kind,
          replace_kind: args.replace_kind,
        };

        const result = await remember(sanitizedArgs);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'recall',
    'Search memories by semantic similarity and keyword match. Returns relevant stored information ranked by relevance.',
    {
      query: z
        .string()
        .min(1)
        .max(500)
        .describe('Search query to find relevant memories'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('Maximum number of results (default 10, max 50)'),
      type: z
        .string()
        .max(50)
        .optional()
        .describe('Filter by entity type'),
      since: z
        .string()
        .optional()
        .describe('Only return memories after this ISO date'),
      kind: z
        .string()
        .max(50)
        .optional()
        .describe('Filter by observation kind (e.g., "fact", "decision", "question")'),
      spread: z
        .boolean()
        .default(false)
        .describe('Follow relationships 1 hop from matched entities and include related observations (dampened). Discovers contextually connected memories.'),
      format: z
        .enum(['full', 'compact', 'wire', 'index'])
        .default('full')
        .describe('"full" (JSON with all fields), "compact" (grouped markdown), "wire" (minimal shorthand, ~2x fewer tokens than compact), "index" (entity summary only — use context tool to expand). Use compact or wire unless you need observation IDs. When using index format, call the context tool to get full details on entities you need.'),
    },
    async (args) => {
      try {
        const result = await recall({
          query: args.query,
          limit: args.limit,
          type: args.type,
          since: args.since,
          kind: args.kind,
          spread: args.spread,
          format: args.format,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'forget',
    'Delete a specific memory or an entire entity and all its associated data. Use with care — this is permanent. Scopes: observation_id deletes one observation; entity + content deletes the single observation matching that exact content; entity alone deletes the WHOLE entity.',
    {
      entity: z
        .string()
        .max(200)
        .optional()
        .describe('Entity name. Alone: delete the entity entirely (all observations, embeddings, relationships). With content: only scopes the content match.'),
      observation_id: z
        .string()
        .optional()
        .describe('Specific observation ID to delete (takes precedence over content)'),
      content: z
        .string()
        .min(1)
        .max(50000)
        .optional()
        .describe('Exact content of a single observation to delete (requires entity). Deletes only that observation, never the entity.'),
    },
    async (args) => {
      try {
        // Strip control chars like remember/update do at write — stored
        // content is sanitized, so an unsanitized needle can never match.
        const result = await forget({
          entity: args.entity?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
          observation_id: args.observation_id,
          content: args.content?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'update',
    'Replace an existing observation with new content. Finds the old observation by exact content match and replaces it. The old observation\'s kind and importance carry over unless kind is set explicitly.',
    {
      entity: z
        .string()
        .min(1)
        .max(200)
        .describe('Entity name that owns the observation'),
      old_content: z
        .string()
        .min(1)
        .max(50000)
        .describe('Exact content of the observation to replace'),
      new_content: z
        .string()
        .min(1)
        .max(50000)
        .describe('New content to replace with'),
      kind: z
        .string()
        .min(1)
        .max(50)
        .optional()
        .describe('Set the observation kind (e.g., "fact", "decision"). Omit to keep the old observation\'s kind.'),
    },
    async (args) => {
      try {
        const sanitized = {
          entity: args.entity.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
          // Sanitize the needle too — stored content is control-char-stripped
          // at write, so a raw needle with control chars can never match.
          old_content: args.old_content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
          new_content: args.new_content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
          kind: args.kind?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
        };
        const result = await update(sanitized);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'merge',
    'Merge multiple observations into one. Atomic operation: provide merged text + list of observation IDs. Creates the merged observation, deletes the originals, handles embeddings. Use after consolidate to act on clusters.',
    {
      observation_ids: z
        .array(z.string())
        .min(2)
        .describe('IDs of observations to merge (minimum 2). All must belong to the same entity.'),
      content: z
        .string()
        .min(1)
        .max(50000)
        .describe('The merged content combining information from all observations'),
    },
    async (args) => {
      try {
        const sanitizedContent = args.content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
        const result = await merge({
          observation_ids: args.observation_ids,
          content: sanitizedContent,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'merge_entities',
    'Merge multiple entities into one. Moves all observations, embeddings, and relationships from source entities to target, then deletes sources. Use after consolidate mode:"entities" to act on detected duplicates.',
    {
      source_entities: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(10)
        .describe('Entity names to merge from (1-10). These entities will be deleted after their data is moved.'),
      target_entity: z
        .string()
        .min(1)
        .max(200)
        .describe('Entity name to merge into. Created if it does not exist.'),
      target_type: z
        .string()
        .max(50)
        .optional()
        .describe('Type for the target entity (only used if creating new)'),
    },
    async (args) => {
      try {
        const result = await mergeEntities({
          source_entities: args.source_entities,
          target_entity: args.target_entity.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
          target_type: args.target_type,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'context',
    'Get full context about a topic: the entity, its observations, relationships, and related entities. Follows relationship graph to discover connected information.',
    {
      topic: z
        .string()
        .min(1)
        .max(200)
        .describe('Topic or entity name to get context for'),
      depth: z
        .number()
        .min(0)
        .max(3)
        .default(1)
        .describe('How many relationship hops to follow (0-3, default 1)'),
    },
    async (args) => {
      try {
        const result = await context({
          topic: args.topic,
          depth: args.depth,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'consolidate',
    'Identify groups of similar or overlapping memories that could be merged into fewer, denser observations. Returns clusters — review each cluster and use merge to consolidate. "sleep" mode runs batch lifecycle analysis: identifies observations to compress (redundant), prune (never recalled), or refresh (actively used but stale). Append-only entities (log-style namespaces) are excluded from every mode and never proposed for merging, pruning or refreshing — dated entries that share a format are not duplicates. The count is disclosed as excluded_append_only.',
    {
      entity: z
        .string()
        .max(200)
        .optional()
        .describe('Entity name to consolidate. If omitted, scans all entities.'),
      threshold: z
        .number()
        .min(0.5)
        .max(1.0)
        .default(0.8)
        .describe('Cosine similarity threshold for clustering (0.5-1.0, default 0.8). Lower = more aggressive grouping.'),
      mode: z
        .enum(['observations', 'entities', 'contradictions', 'sleep'])
        .default('observations')
        .describe('"observations" (default) finds similar observations to merge. "entities" finds entity names that likely refer to the same thing. "contradictions" finds same-topic observations with conflicting content. "sleep" runs batch lifecycle analysis — identifies compress/prune/refresh candidates.'),
      age_days: z
        .number()
        .min(1)
        .max(365)
        .default(30)
        .describe('Minimum age in days for sleep mode candidates (default 30). Only observations older than this are analyzed.'),
      include_append_only: z
        .boolean()
        .optional()
        .describe('Include append-only (log-style) entities, which are excluded by default because every cluster on them is a false positive — dated entries sharing a format are not duplicates. Set true ONLY to hunt accidental double-writes on a specific log entity; never for a routine or store-wide consolidation pass, and never act on the result without reading both entries in full.'),
    },
    async (args) => {
      try {
        const result = await consolidate({
          entity: args.entity,
          threshold: args.threshold,
          mode: args.mode,
          age_days: args.age_days,
          include_append_only: args.include_append_only,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'export',
    'Export memories as a CLAUDE.md context file, readable markdown, JSON, wire format, or Obsidian vault. Use claude-md for context files, markdown for human reading, json for backup/portability, wire for minimal tokens, obsidian for vault export with wikilinks.',
    {
      format: z
        .enum(['claude-md', 'markdown', 'json', 'wire', 'obsidian'])
        .describe('Output format: claude-md (compact context), markdown (full with metadata), json (structured backup), wire (minimal shorthand, lowest tokens), obsidian (vault-ready files with YAML frontmatter and [[wikilinks]])'),
      entity: z
        .string()
        .max(200)
        .optional()
        .describe('Export a single entity by name'),
      type: z
        .string()
        .max(50)
        .optional()
        .describe('Filter entities by type (e.g., "person", "project")'),
    },
    async (args) => {
      try {
        const result = await exportMemories({
          format: args.format,
          entity: args.entity,
          type: args.type,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'check_version',
    'Check if cached entity content is still current. Pass a previously received version_hash to verify freshness. Returns current version info.',
    {
      entity: z
        .string()
        .min(1)
        .max(200)
        .describe('Entity name to check version for'),
      version_hash: z
        .string()
        .optional()
        .describe('Previously received version_hash to compare against current'),
    },
    async (args) => {
      try {
        const result = checkVersion({
          entity: args.entity,
          version_hash: args.version_hash,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'onboard',
    'Bootstrap memory from the current AI session. Returns extraction instructions — follow them to capture user context into Hippocampus.',
    {
      source: z
        .string()
        .optional()
        .describe('AI platform name (e.g., "claude", "chatgpt", "cursor", "gemini")'),
    },
    async (args) => {
      try {
        const result = onboard({ source: args.source });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Resources — proactive context for warm-start AI sessions
  registerContextResources(server);

  // Lenient inbound param-name handling — see param-normalization.ts.
  installParamNormalization(server);

  return server;
}

type CallToolRequest = {
  params?: { name?: string; arguments?: unknown };
};
type RequestHandler = (request: CallToolRequest, extra: unknown) => unknown;

/**
 * Wraps the SDK's `tools/call` request handler so inbound `params.arguments`
 * is normalized to canonical names before Zod validates it. Installed after
 * all `server.tool()` registrations (the SDK wires its handler lazily on
 * first registration), so we replace an existing entry rather than creating
 * one. Reaches into the SDK's internal `_requestHandlers` Map — if a future
 * SDK version renames that field this will throw, which is the right failure
 * mode (loud) over silently dropping normalization.
 */
function installParamNormalization(server: McpServer): void {
  const handlers = (server as unknown as {
    server: { _requestHandlers: Map<string, RequestHandler> };
  }).server._requestHandlers;
  const method = 'tools/call';
  const original = handlers.get(method);
  if (!original) {
    throw new Error(
      'param normalization: SDK tools/call handler not found. Install after tool registrations.'
    );
  }
  handlers.set(method, (request, extra) => {
    const params = request?.params;
    if (
      params &&
      typeof params.name === 'string' &&
      params.arguments &&
      typeof params.arguments === 'object'
    ) {
      params.arguments = normalizeParams(params.name, params.arguments);
    }
    return original(request, extra);
  });
}
