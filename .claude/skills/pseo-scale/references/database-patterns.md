# Database Patterns for pSEO at Scale

## Database Options by Scale

| Scale | Recommended | Why |
|-------|------------|-----|
| 10K-50K | PostgreSQL, MySQL | Mature, full SQL, JSONB support (Postgres) |
| 50K-100K | PostgreSQL + Redis cache | DB for source of truth, Redis for index-tier cache |
| 100K+ | PostgreSQL + Redis + CDN KV | Edge KV for sub-50ms reads, DB as source |

SQLite is insufficient at scale due to single-writer lock and lack of connection pooling.

## PostgreSQL Patterns

### Index-Tier Query (Safe to Cache)

```sql
-- Lightweight query for listing, sitemap, related pages
-- Returns only PageIndex fields — no body, FAQs, or images
SELECT slug, title, h1, meta_description, canonical_path,
       category, subcategory, last_modified
FROM pages
WHERE status = 'published'
  AND category = $1
ORDER BY title
LIMIT 50 OFFSET 0;
```

### Full-Tier Query (Per-Page Only)

```sql
-- Full page content — only load one at a time
SELECT *
FROM pages
WHERE slug = $1 AND status = 'published';
```

### Cursor-Based Pagination for Sitemap

At 100K rows, `OFFSET` becomes slow. Use cursor-based (keyset) pagination:

```sql
-- First page
SELECT slug, category, last_modified
FROM pages
WHERE status = 'published'
ORDER BY slug
LIMIT 1000;

-- Subsequent pages (use last slug as cursor)
SELECT slug, category, last_modified
FROM pages
WHERE status = 'published'
  AND slug > $1  -- cursor: last slug from previous batch
ORDER BY slug
LIMIT 1000;
```

### Similarity Detection with pg_trgm

PostgreSQL's `pg_trgm` extension enables built-in trigram similarity:

```sql
-- Enable the extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create trigram index on titles
CREATE INDEX idx_pages_title_trgm ON pages USING gin(title gin_trgm_ops);

-- Find pages with similar titles (potential cannibalization)
SELECT a.slug, b.slug, similarity(a.title, b.title) AS sim
FROM pages a
JOIN pages b ON a.slug < b.slug  -- avoid self-join and duplicate pairs
WHERE similarity(a.title, b.title) > 0.7
  AND a.status = 'published'
  AND b.status = 'published';
```

### JSONB Queries for FAQs

```sql
-- Count pages with insufficient FAQs
SELECT COUNT(*)
FROM pages
WHERE status = 'published'
  AND (faqs IS NULL OR jsonb_array_length(faqs) < 3);

-- Find pages where a specific FAQ question appears (dedup)
SELECT slug, title
FROM pages
WHERE faqs @> '[{"question": "What is the price?"}]';
```

## Redis Cache Layer

Use Redis to cache index-tier data for sub-millisecond reads during page rendering:

```typescript
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);
const CACHE_TTL = 3600; // 1 hour

async function getCachedPageIndex(slug: string): Promise<PageIndex | null> {
  const cached = await redis.get(`page:index:${slug}`);
  if (cached) return JSON.parse(cached);

  const page = await db.query(
    `SELECT slug, title, h1, meta_description, canonical_path,
            category, last_modified
     FROM pages WHERE slug = $1 AND status = 'published'`,
    [slug]
  );
  if (!page) return null;

  await redis.setex(`page:index:${slug}`, CACHE_TTL, JSON.stringify(page));
  return page;
}

// Cache invalidation on data change
async function invalidatePageCache(slug: string) {
  await redis.del(`page:index:${slug}`);
  const page = await db.query("SELECT category FROM pages WHERE slug = $1", [slug]);
  if (page) {
    await redis.del(`category:pages:${page.category}`);
  }
}
```

## Connection Pooling Configuration

### Next.js / Node.js with pg

```typescript
import { Pool } from "pg";

// Build-time: fewer connections, longer timeout
const buildPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,                       // builds are sequential-ish
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000,
});

// Runtime (ISR/SSR): more connections, shorter timeout
const runtimePool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                      // handle concurrent requests
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 3000,
});

export const pool = process.env.BUILD_PHASE ? buildPool : runtimePool;
```

### Prisma

```
// schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  // Connection pooling for serverless
  directUrl = env("DIRECT_DATABASE_URL")
}

// In code: Prisma handles pooling automatically, but limit:
// DATABASE_URL="postgresql://...?connection_limit=10&pool_timeout=10"
```

### Drizzle

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export const db = drizzle(pool);
```

## Migration Strategy

Moving from JSON/files to database:

1. Create the database schema
2. Write a migration script that reads existing JSON/files and inserts into the database
3. Update the data layer functions to query the database instead of files
4. Run data validation to confirm all records migrated correctly
5. Compute data sufficiency scores for all records
6. Remove the file-based data layer
7. Update `.env` with database connection string

```typescript
// scripts/migrate-to-db.ts
import data from "../data/pages.json";

async function migrate() {
  for (const page of data) {
    await db.query(
      `INSERT INTO pages (slug, title, h1, meta_description, ...)
       VALUES ($1, $2, $3, $4, ...)
       ON CONFLICT (slug) DO UPDATE SET ...`,
      [page.slug, page.title, page.h1, page.metaDescription, ...]
    );
  }
  console.log(`Migrated ${data.length} pages`);
}
```
