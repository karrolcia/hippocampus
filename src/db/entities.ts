import { randomUUID } from 'crypto';
import { getDatabase } from './index.js';

export interface Entity {
  id: string;
  name: string;
  type: string | null;
  created_at: string;
  updated_at: string;
}

export function findEntityById(id: string): Entity | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as Entity | undefined;
}

export function findEntityByName(name: string): Entity | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM entities WHERE name = ?').get(name) as Entity | undefined;
}

export function findOrCreateEntity(name: string, type?: string): Entity {
  const existing = findEntityByName(name);
  if (existing) {
    return existing;
  }

  const db = getDatabase();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO entities (id, name, type)
    VALUES (?, ?, ?)
  `).run(id, name, type ?? null);

  return findEntityById(id)!;
}

export function listEntities(options?: { type?: string; limit?: number }): Entity[] {
  const db = getDatabase();
  const limit = options?.limit ?? 100;

  if (options?.type) {
    return db.prepare(`
      SELECT * FROM entities
      WHERE type = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(options.type, limit) as Entity[];
  }

  return db.prepare(`
    SELECT * FROM entities
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as Entity[];
}

export function updateEntityTimestamp(id: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE entities SET updated_at = datetime('now') WHERE id = ?
  `).run(id);
}

export function deleteEntity(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM entities WHERE id = ?').run(id);
  return result.changes > 0;
}

export function searchEntities(query: string): Entity[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM entities WHERE name LIKE ? ORDER BY updated_at DESC LIMIT 10
  `).all(`%${query}%`) as Entity[];
}
