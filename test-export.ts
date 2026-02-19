/**
 * Test script for the export MCP tool.
 *
 * Seeds a temp encrypted DB with entities, observations, and relationships,
 * then verifies all three export formats plus entity/type filtering and
 * error handling.
 *
 * Run: HIPPO_PASSPHRASE=test HIPPO_DB_PATH=/tmp/hippo-test-export.db npx tsx test-export.ts
 */

import { unlinkSync, existsSync } from 'fs';

const DB_PATH = process.env.HIPPO_DB_PATH!;

// Clean up any leftover DB from a previous run
for (const suffix of ['', '-wal', '-shm']) {
  const p = DB_PATH + suffix;
  if (existsSync(p)) unlinkSync(p);
}

import { initDatabase, closeDatabase } from './src/db/index.js';
import { findOrCreateEntity } from './src/db/entities.js';
import { createObservation } from './src/db/observations.js';
import { createRelationship } from './src/db/relationships.js';
import { exportMemories } from './src/mcp/tools/export.js';

// ── Helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

// ── Setup ────────────────────────────────────────────────────────────

initDatabase();

// Seed entities
const karolina = findOrCreateEntity('karolina', 'person');
const hippocampus = findOrCreateEntity('hippocampus', 'project');
const cycling = findOrCreateEntity('cycling', 'preference');
const gallant = findOrCreateEntity('gallant', 'project');
const caper = findOrCreateEntity('caper', 'pet');

// Seed observations
createObservation(karolina.id, 'PhD in atmospheric physics from TU Delft', 'conversation');
createObservation(karolina.id, 'Cycles year-round in Helsinki');
createObservation(karolina.id, 'Relocating to Stockholm in ~18 months', 'explicit');

createObservation(hippocampus.id, 'Open-source MCP memory server', 'conversation');
createObservation(hippocampus.id, 'Stack: Node.js, Hono, SQLCipher, local embeddings');

createObservation(cycling.id, 'Year-round cyclist regardless of weather');

createObservation(gallant.id, 'Board member role — strategy and investment', 'conversation');
createObservation(gallant.id, 'European expansion of accounting business');

createObservation(caper.id, 'Dog named Caper');

// Seed relationships
createRelationship(karolina.id, hippocampus.id, 'creator_of');
createRelationship(karolina.id, gallant.id, 'board_member');
createRelationship(karolina.id, caper.id, 'owner_of');
createRelationship(karolina.id, cycling.id, 'relates_to');

// ── Tests ────────────────────────────────────────────────────────────

// 1. JSON — full export
section('JSON full export');
{
  const result = exportMemories({ format: 'json' });
  assert(result.success === true, 'success is true');
  assert(result.format === 'json', 'format is json');
  assert(result.entity_count === 5, `entity_count is 5 (got ${result.entity_count})`);
  assert(result.observation_count === 9, `observation_count is 9 (got ${result.observation_count})`);

  const data = JSON.parse(result.data);
  assert(typeof data.exported_at === 'string', 'has exported_at timestamp');
  assert(Array.isArray(data.entities), 'entities is array');
  assert(data.entities.length === 5, `5 entities in data (got ${data.entities.length})`);
  assert(Array.isArray(data.relationships), 'relationships is array');
  assert(data.relationships.length === 4, `4 relationships in data (got ${data.relationships.length})`);

  // Verify observation structure
  const karolinaEntity = data.entities.find((e: any) => e.name === 'karolina');
  assert(karolinaEntity !== undefined, 'karolina entity present');
  assert(karolinaEntity.observations.length === 3, `karolina has 3 observations (got ${karolinaEntity?.observations?.length})`);
  assert(karolinaEntity.type === 'person', 'karolina type is person');

  const obs0 = karolinaEntity.observations[0];
  assert(typeof obs0.id === 'string', 'observation has id');
  assert(typeof obs0.content === 'string', 'observation has content');
  assert(typeof obs0.created_at === 'string', 'observation has created_at');

  // Verify relationship deduplication — each relationship appears exactly once
  const relIds = data.relationships.map((r: any) => `${r.from}-${r.relation_type}-${r.to}`);
  const uniqueRels = new Set(relIds);
  assert(uniqueRels.size === relIds.length, 'no duplicate relationships');
}

// 2. JSON — single entity filter
section('JSON single entity export');
{
  const result = exportMemories({ format: 'json', entity: 'karolina' });
  assert(result.success === true, 'success is true');
  assert(result.entity_count === 1, `entity_count is 1 (got ${result.entity_count})`);
  assert(result.observation_count === 3, `observation_count is 3 (got ${result.observation_count})`);

  const data = JSON.parse(result.data);
  assert(data.entities.length === 1, 'only karolina exported');
  assert(data.entities[0].name === 'karolina', 'correct entity name');
  // Relationships include all of karolina's (since she's the only entity, dedup still works)
  assert(data.relationships.length === 4, `4 relationships for karolina (got ${data.relationships.length})`);
}

// 3. JSON — type filter
section('JSON type filter export');
{
  const result = exportMemories({ format: 'json', type: 'project' });
  assert(result.success === true, 'success is true');
  assert(result.entity_count === 2, `entity_count is 2 (got ${result.entity_count})`);

  const data = JSON.parse(result.data);
  const names = data.entities.map((e: any) => e.name).sort();
  assert(names[0] === 'gallant' && names[1] === 'hippocampus', `project entities: ${names.join(', ')}`);
}

// 4. JSON — nonexistent entity
section('JSON nonexistent entity');
{
  const result = exportMemories({ format: 'json', entity: 'nonexistent' });
  assert(result.success === false, 'success is false');
  assert(result.entity_count === 0, 'entity_count is 0');
  assert(result.data === '', 'data is empty');
  assert(result.message.includes('not found'), `message says not found: "${result.message}"`);
}

// 5. JSON — nonexistent type (returns empty, not error)
section('JSON nonexistent type');
{
  const result = exportMemories({ format: 'json', type: 'nonexistent' });
  assert(result.success === true, 'success is true (empty result, not error)');
  assert(result.entity_count === 0, 'entity_count is 0');
  assert(result.data === '', 'data is empty');
}

// 6. claude-md — full export
section('claude-md full export');
{
  const result = exportMemories({ format: 'claude-md' });
  assert(result.success === true, 'success is true');
  assert(result.format === 'claude-md', 'format is claude-md');

  const data = result.data;
  assert(data.startsWith('# Memory Export\n'), 'starts with Memory Export heading');

  // Grouped by type
  assert(data.includes('## Person'), 'has Person section');
  assert(data.includes('## Project'), 'has Project section');
  assert(data.includes('## Preference'), 'has Preference section');
  assert(data.includes('## Pet'), 'has Pet section');

  // Entity names as H3
  assert(data.includes('### karolina'), 'karolina as H3');
  assert(data.includes('### hippocampus'), 'hippocampus as H3');

  // Observations as bullet points
  assert(data.includes('- PhD in atmospheric physics from TU Delft'), 'observation as bullet');
  assert(data.includes('- Open-source MCP memory server'), 'hippocampus observation');

  // No metadata noise (no dates, no sources, no IDs)
  assert(!data.includes('source:'), 'no source metadata');
  assert(!data.includes('conversation'), 'no source values');
  assert(!data.includes('---'), 'no horizontal rules');
}

// 7. claude-md — single entity
section('claude-md single entity');
{
  const result = exportMemories({ format: 'claude-md', entity: 'caper' });
  const data = result.data;
  assert(data.includes('### caper'), 'has caper heading');
  assert(data.includes('- Dog named Caper'), 'has observation');
  assert(!data.includes('karolina'), 'no other entities');
}

// 8. markdown — full export
section('markdown full export');
{
  const result = exportMemories({ format: 'markdown' });
  assert(result.success === true, 'success is true');
  assert(result.format === 'markdown', 'format is markdown');

  const data = result.data;
  assert(data.startsWith('# Hippocampus Memory Export\n'), 'starts with heading');
  assert(data.includes('Generated:'), 'has generated timestamp');

  // Entity with type annotation
  assert(data.includes('## karolina (person)'), 'karolina with type');
  assert(data.includes('## hippocampus (project)'), 'hippocampus with type');

  // Observations with metadata
  assert(data.includes('source: conversation'), 'has source metadata');
  assert(data.includes('['), 'has bracket metadata');

  // Relationships section under entities
  assert(data.includes('### Relationships'), 'has relationships section');
  assert(data.includes('karolina → creator_of → hippocampus'), 'has creator_of relationship');
  assert(data.includes('karolina → board_member → gallant'), 'has board_member relationship');

  // Horizontal rules between entities
  assert(data.includes('---'), 'has horizontal rules');
}

// 9. markdown — type filter
section('markdown type filter');
{
  const result = exportMemories({ format: 'markdown', type: 'person' });
  const data = result.data;
  assert(data.includes('## karolina (person)'), 'has karolina');
  assert(!data.includes('## hippocampus'), 'no hippocampus');
  assert(!data.includes('## gallant'), 'no gallant');
}

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(40));

// Clean up
closeDatabase();
for (const suffix of ['', '-wal', '-shm']) {
  const p = DB_PATH + suffix;
  if (existsSync(p)) unlinkSync(p);
}

process.exit(failed > 0 ? 1 : 0);
