import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { remember } from './tools/remember.js';
import { recall } from './tools/recall.js';
import { forget } from './tools/forget.js';
import { update } from './tools/update.js';
import { context } from './tools/context.js';
import { consolidate } from './tools/consolidate.js';
import { exportMemories } from './tools/export.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'hippocampus',
    version: '0.1.0',
  });

  server.tool(
    'remember',
    'Store a memory or piece of information. Use this to save facts, preferences, context, or anything worth remembering about the user or conversation.',
    {
      content: z
        .string()
        .min(1)
        .max(2000)
        .describe('The information to remember (max 2000 chars)'),
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
    },
    async (args) => {
      try {
        const sanitizedArgs = {
          content: args.content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
          entity: args.entity?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
          type: args.type,
          source: args.source,
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
    },
    async (args) => {
      try {
        const result = await recall({
          query: args.query,
          limit: args.limit,
          type: args.type,
          since: args.since,
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
    'Delete a specific memory or an entire entity and all its associated data. Use with care — this is permanent.',
    {
      entity: z
        .string()
        .max(200)
        .optional()
        .describe('Entity name to delete entirely (all observations, embeddings, relationships)'),
      observation_id: z
        .string()
        .optional()
        .describe('Specific observation ID to delete'),
    },
    async (args) => {
      try {
        const result = forget({
          entity: args.entity,
          observation_id: args.observation_id,
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
    'Replace an existing observation with new content. Finds the old observation by exact content match and replaces it.',
    {
      entity: z
        .string()
        .min(1)
        .max(200)
        .describe('Entity name that owns the observation'),
      old_content: z
        .string()
        .min(1)
        .max(2000)
        .describe('Exact content of the observation to replace'),
      new_content: z
        .string()
        .min(1)
        .max(2000)
        .describe('New content to replace with'),
    },
    async (args) => {
      try {
        const sanitized = {
          entity: args.entity.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
          old_content: args.old_content,
          new_content: args.new_content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''),
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
    'Identify groups of similar or overlapping memories that could be merged into fewer, denser observations. Returns clusters — review each cluster and use remember + forget to consolidate.',
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
    },
    async (args) => {
      try {
        const result = consolidate({
          entity: args.entity,
          threshold: args.threshold,
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
    'Export memories as a CLAUDE.md context file, readable markdown, or JSON. Use claude-md for context files, markdown for human reading, json for backup/portability.',
    {
      format: z
        .enum(['claude-md', 'markdown', 'json'])
        .describe('Output format: claude-md (compact context), markdown (full with metadata), json (structured backup)'),
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
        const result = exportMemories({
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

  return server;
}
