import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

dotenvConfig();

const configSchema = z.object({
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  dbPath: z.string().default('./data/hippocampus.db'),
  passphrase: z.string().min(1, 'HIPPO_PASSPHRASE is required'),
  rateLimitRemember: z.coerce.number().default(20),
  rateLimitRecall: z.coerce.number().default(60),
  token: z.string().optional(),
  oauthIssuer: z.string().url().optional(),
  oauthUser: z.string().optional(),
  oauthPasswordHash: z.string().optional(),
  transformersCache: z.string().optional(),
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
    oauthIssuer: process.env.HIPPO_OAUTH_ISSUER,
    oauthUser: process.env.HIPPO_OAUTH_USER,
    oauthPasswordHash: process.env.HIPPO_OAUTH_PASSWORD_HASH,
    transformersCache: process.env.TRANSFORMERS_CACHE,
  });

  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw new Error(`Configuration error:\n${errors.join('\n')}`);
  }

  return result.data;
}

export const config = loadConfig();
