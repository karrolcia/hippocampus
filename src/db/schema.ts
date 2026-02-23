import type Database from 'better-sqlite3-multiple-ciphers';

const SCHEMA_VERSION = 3;

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
`;

const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  text_content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_observation ON embeddings(observation_id);
CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_entity);
CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_entity);
CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(relation_type);
`;

const SCHEMA_V3_SQL = `
ALTER TABLE observations ADD COLUMN last_recalled_at TEXT;
ALTER TABLE observations ADD COLUMN recall_count INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_observations_recall_count ON observations(recall_count);
`;

export function initializeSchema(db: Database.Database): void {
  db.exec(SCHEMA_V1_SQL);

  const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  const currentVersion = versionRow?.version ?? 0;

  if (currentVersion < 2) {
    db.exec(SCHEMA_V2_SQL);
  }

  if (currentVersion < 3) {
    // V3: access tracking columns on observations
    // ALTER TABLE ADD COLUMN is safe — no table rebuild, defaults apply to existing rows
    db.exec(SCHEMA_V3_SQL);
  }

  if (!versionRow) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  } else if (currentVersion < SCHEMA_VERSION) {
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
}

export function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  return row?.version ?? 0;
}
