import { randomUUID } from 'crypto';
import { getDatabase } from '../db/index.js';

const EMBEDDING_DIM = 384;
const EMBEDDING_BYTES = EMBEDDING_DIM * 4; // Float32 = 4 bytes

// Lazy-loaded pipeline
let pipelineInstance: any = null;

async function getPipeline() {
  if (!pipelineInstance) {
    const { pipeline } = await import('@xenova/transformers');
    pipelineInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      cache_dir: process.env.TRANSFORMERS_CACHE || undefined,
    });
  }
  return pipelineInstance;
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

export interface StoredEmbedding {
  id: string;
  entity_id: string;
  observation_id: string;
  vector: Buffer;
  text_content: string;
  created_at: string;
}

export function storeEmbedding(
  entityId: string,
  observationId: string,
  vector: Float32Array,
  textContent: string
): string {
  const db = getDatabase();
  const id = randomUUID();
  const vectorBlob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

  db.prepare(`
    INSERT INTO embeddings (id, entity_id, observation_id, vector, text_content)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, entityId, observationId, vectorBlob, textContent);

  return id;
}

export interface StoredVector {
  observation_id: string;
  entity_id: string;
  entity_name: string;
  entity_type: string | null;
  content: string;
  source: string | null;
  created_at: string;
  vector: Float32Array;
}

export function getEmbeddingsByEntity(entityId?: string): StoredVector[] {
  const db = getDatabase();

  let sql = `
    SELECT emb.observation_id, emb.entity_id, emb.vector,
      o.content, o.source, o.created_at,
      e.name as entity_name, e.type as entity_type
    FROM embeddings emb
    JOIN observations o ON emb.observation_id = o.id
    JOIN entities e ON emb.entity_id = e.id
  `;

  const params: string[] = [];
  if (entityId) {
    sql += ' WHERE emb.entity_id = ?';
    params.push(entityId);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    observation_id: string;
    entity_id: string;
    vector: Buffer;
    content: string;
    source: string | null;
    created_at: string;
    entity_name: string;
    entity_type: string | null;
  }>;

  return rows.map(row => ({
    observation_id: row.observation_id,
    entity_id: row.entity_id,
    entity_name: row.entity_name,
    entity_type: row.entity_type,
    content: row.content,
    source: row.source,
    created_at: row.created_at,
    vector: new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      EMBEDDING_DIM
    ),
  }));
}

export interface SemanticSearchResult {
  observation_id: string;
  entity_id: string;
  entity_name: string;
  entity_type: string | null;
  content: string;
  source: string | null;
  created_at: string;
  similarity: number;
}

export async function semanticSearch(
  query: string,
  options?: { limit?: number; type?: string; since?: string }
): Promise<SemanticSearchResult[]> {
  const limit = options?.limit ?? 10;
  const queryVector = await generateEmbedding(query);

  const db = getDatabase();

  // Build query with optional filters
  let sql = `
    SELECT emb.observation_id, emb.entity_id, emb.vector,
      o.content, o.source, o.created_at,
      e.name as entity_name, e.type as entity_type
    FROM embeddings emb
    JOIN observations o ON emb.observation_id = o.id
    JOIN entities e ON emb.entity_id = e.id
  `;

  const conditions: string[] = [];
  const params: string[] = [];

  if (options?.type) {
    conditions.push('e.type = ?');
    params.push(options.type);
  }
  if (options?.since) {
    conditions.push('o.created_at >= ?');
    params.push(options.since);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    observation_id: string;
    entity_id: string;
    vector: Buffer;
    content: string;
    source: string | null;
    created_at: string;
    entity_name: string;
    entity_type: string | null;
  }>;

  // Compute similarities via dot product (vectors are normalized → dot = cosine)
  const scored = rows.map(row => {
    const storedVector = new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      EMBEDDING_DIM
    );
    let similarity = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      similarity += queryVector[i] * storedVector[i];
    }
    return {
      observation_id: row.observation_id,
      entity_id: row.entity_id,
      entity_name: row.entity_name,
      entity_type: row.entity_type,
      content: row.content,
      source: row.source,
      created_at: row.created_at,
      similarity,
    };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

export function deleteEmbedding(observationId: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM embeddings WHERE observation_id = ?').run(observationId);
  return result.changes > 0;
}

export function deleteEmbeddingsByEntity(entityId: string): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM embeddings WHERE entity_id = ?').run(entityId);
  return result.changes;
}

export async function backfillEmbeddings(): Promise<number> {
  const db = getDatabase();

  const missing = db.prepare(`
    SELECT o.id, o.entity_id, o.content
    FROM observations o
    LEFT JOIN embeddings emb ON o.id = emb.observation_id
    WHERE emb.id IS NULL
  `).all() as Array<{ id: string; entity_id: string; content: string }>;

  if (missing.length === 0) return 0;

  console.log(`Backfilling embeddings for ${missing.length} observations...`);

  let count = 0;
  for (const obs of missing) {
    const vector = await generateEmbedding(obs.content);
    storeEmbedding(obs.entity_id, obs.id, vector, obs.content);
    count++;
  }

  console.log(`Backfilled ${count} embeddings.`);
  return count;
}
