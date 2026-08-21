import { createRequire } from 'node:module';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

dotenvConfig();

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
export const VERSION: string = pkg.version;

// Entities whose observations are append-only by contract: each write is a new
// log entry, never a restatement of an earlier one. Dedup-on-write must not
// touch them — a >= 0.85 similarity match between two entries written weeks
// apart is the shared skeleton of the log format, not redundant information.
// See D10 / CLAUDE.md "Dedup on write".
export const DEFAULT_APPEND_ONLY_PREFIXES = 'ops:daily-log:,ops:session-check,synthesis:';

const configSchema = z.object({
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  dbPath: z.string().default('./data/hippocampus.db'),
  passphrase: z.string().min(1, 'HIPPO_PASSPHRASE is required'),
  rateLimitRemember: z.coerce.number().default(20),
  rateLimitRecall: z.coerce.number().default(60),
  token: z.string().optional(),
  agentToken: z.string().min(32).optional(),
  oauthIssuer: z.string().url().optional(),
  oauthUser: z.string().optional(),
  oauthPasswordHash: z.string().optional(),
  transformersCache: z.string().optional(),
  contextMaxObservations: z.coerce.number().min(10).max(10000).default(100),
  // Comma-separated entity-name prefixes exempt from dedup-on-write.
  // Unset -> the defaults above; empty string -> no exemptions at all.
  appendOnlyPrefixes: z
    .string()
    .default(DEFAULT_APPEND_ONLY_PREFIXES)
    .transform(s =>
      s
        .split(',')
        .map(prefix => prefix.trim().toLowerCase())
        .filter(prefix => prefix.length > 0)
    ),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const result = configSchema.safeParse({
    port: process.env.PORT,
    host: process.env.HOST,
    dbPath: process.env.HIPPO_DB_PATH,
    passphrase: process.env.HIPPO_PASSPHRASE,
    rateLimitRemember: process.env.RATE_LIMIT_REMEMBER,
    rateLimitRecall: process.env.RATE_LIMIT_RECALL,
    token: process.env.HIPPO_TOKEN,
    agentToken: process.env.HIPPO_AGENT_TOKEN,
    oauthIssuer: process.env.HIPPO_OAUTH_ISSUER,
    oauthUser: process.env.HIPPO_OAUTH_USER,
    oauthPasswordHash: process.env.HIPPO_OAUTH_PASSWORD_HASH,
    transformersCache: process.env.TRANSFORMERS_CACHE,
    contextMaxObservations: process.env.HIPPO_CONTEXT_MAX_OBSERVATIONS,
    appendOnlyPrefixes: process.env.HIPPO_APPEND_ONLY_PREFIXES,
  });

  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw new Error(`Configuration error:\n${errors.join('\n')}`);
  }

  return result.data;
}

export const config = loadConfig();
