import { randomUUID } from 'crypto';
import { getDatabase } from './index.js';
import { updateEntityTimestamp } from './entities.js';

export interface Observation {
  id: string;
  entity_id: string;
  content: string;
  source: string | null;
  created_at: string;
}

export interface ObservationWithEntity extends Observation {
  entity_name: string;
  entity_type: string | null;
}

export function createObservation(
  entityId: string,
  content: string,
  source?: string
): Observation {
  const db = getDatabase();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO observations (id, entity_id, content, source)
    VALUES (?, ?, ?, ?)
  `).run(id, entityId, content, source ?? null);

  updateEntityTimestamp(entityId);

  return db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as Observation;
}

export function getObservationsByEntity(entityId: string): Observation[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM observations
    WHERE entity_id = ?
    ORDER BY created_at DESC
  `).all(entityId) as Observation[];
}

export interface SearchOptions {
  query: string;
  limit?: number;
  type?: string;
  since?: string;
}

export function searchObservations(options: SearchOptions): ObservationWithEntity[] {
  const db = getDatabase();
  const limit = Math.min(options.limit ?? 10, 50);
  const searchTerm = `%${options.query}%`;

  let sql = `
    SELECT
      o.*,
      e.name as entity_name,
      e.type as entity_type
    FROM observations o
    JOIN entities e ON o.entity_id = e.id
    WHERE (o.content LIKE ? OR e.name LIKE ?)
  `;

  const params: (string | number)[] = [searchTerm, searchTerm];

  if (options.type) {
    sql += ' AND e.type = ?';
    params.push(options.type);
  }

  if (options.since) {
    sql += ' AND o.created_at >= ?';
    params.push(options.since);
  }

  sql += ' ORDER BY o.created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as ObservationWithEntity[];
}

export function getObservationsByIds(ids: string[]): Observation[] {
  if (ids.length === 0) return [];
  const db = getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM observations WHERE id IN (${placeholders})`
  ).all(...ids) as Observation[];

  // Preserve requested order
  const byId = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => byId.get(id)).filter((r): r is Observation => r !== undefined);
}

export function deleteObservationsByEntity(entityId: string): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM observations WHERE entity_id = ?').run(entityId);
  return result.changes;
}

export function deleteObservation(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM observations WHERE id = ?').run(id);
  return result.changes > 0;
}
