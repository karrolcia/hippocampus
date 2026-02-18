import Database from 'better-sqlite3-multiple-ciphers';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';
import { initializeSchema } from './schema.js';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function initDatabase(): Database.Database {
  if (db) {
    return db;
  }

  const dbDir = dirname(config.dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.dbPath);

  // SQLCipher configuration
  db.pragma(`key = "${config.passphrase.replace(/"/g, '""')}"`);
  db.pragma('cipher_page_size = 4096');
  db.pragma('kdf_iter = 256000');
  db.pragma('cipher_memory_security = ON');
  db.pragma('secure_delete = ON');

  // Verify encryption by attempting a simple query
  try {
    db.pragma('cipher_integrity_check');
  } catch {
    throw new Error('Failed to open encrypted database. Check HIPPO_PASSPHRASE.');
  }

  // Enable foreign keys and WAL mode
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  initializeSchema(db);

  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
