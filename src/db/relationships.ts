import { randomUUID } from 'crypto';
import { getDatabase } from './index.js';

export interface Relationship {
  id: string;
  from_entity: string;
  to_entity: string;
  relation_type: string;
  created_at: string;
}

export interface RelationshipWithNames extends Relationship {
  from_name: string;
  to_name: string;
}

export function createRelationship(
  fromEntityId: string,
  toEntityId: string,
  relationType: string
): Relationship {
  const db = getDatabase();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO relationships (id, from_entity, to_entity, relation_type)
    VALUES (?, ?, ?, ?)
  `).run(id, fromEntityId, toEntityId, relationType);

  return db.prepare('SELECT * FROM relationships WHERE id = ?').get(id) as Relationship;
}

export function getRelationshipsByEntity(entityId: string): RelationshipWithNames[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT r.*,
      fe.name as from_name,
      te.name as to_name
    FROM relationships r
    JOIN entities fe ON r.from_entity = fe.id
    JOIN entities te ON r.to_entity = te.id
    WHERE r.from_entity = ? OR r.to_entity = ?
    ORDER BY r.created_at DESC
  `).all(entityId, entityId) as RelationshipWithNames[];
}

export function getRelatedEntities(
  entityId: string,
  maxDepth: number = 1
): Map<string, { depth: number; name: string; type: string | null }> {
  const db = getDatabase();
  const visited = new Map<string, { depth: number; name: string; type: string | null }>();
  const queue: Array<{ id: string; depth: number }> = [{ id: entityId, depth: 0 }];

  const stmt = db.prepare(`
    SELECT
      CASE WHEN r.from_entity = ? THEN r.to_entity ELSE r.from_entity END as related_id,
      e.name, e.type
    FROM relationships r
    JOIN entities e ON e.id = CASE WHEN r.from_entity = ? THEN r.to_entity ELSE r.from_entity END
    WHERE r.from_entity = ? OR r.to_entity = ?
  `);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id) || current.depth > maxDepth) continue;

    if (current.id !== entityId) {
      const entity = db.prepare('SELECT name, type FROM entities WHERE id = ?').get(current.id) as { name: string; type: string | null } | undefined;
      if (entity) {
        visited.set(current.id, { depth: current.depth, name: entity.name, type: entity.type });
      }
    } else {
      visited.set(current.id, { depth: 0, name: '', type: null }); // mark as visited
    }

    if (current.depth < maxDepth) {
      const related = stmt.all(current.id, current.id, current.id, current.id) as Array<{ related_id: string; name: string; type: string | null }>;
      for (const r of related) {
        if (!visited.has(r.related_id)) {
          queue.push({ id: r.related_id, depth: current.depth + 1 });
        }
      }
    }
  }

  // Remove the seed entity from results
  visited.delete(entityId);
  return visited;
}

export function relationshipExists(entityIdA: string, entityIdB: string): boolean {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT 1 FROM relationships
    WHERE (from_entity = ? AND to_entity = ?)
       OR (from_entity = ? AND to_entity = ?)
    LIMIT 1
  `).get(entityIdA, entityIdB, entityIdB, entityIdA);
  return !!row;
}

export function deleteRelationship(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM relationships WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteRelationshipsByEntity(entityId: string): number {
  const db = getDatabase();
  const result = db.prepare(
    'DELETE FROM relationships WHERE from_entity = ? OR to_entity = ?'
  ).run(entityId, entityId);
  return result.changes;
}
