/**
 * infra/backup/hippo-dbtool.mjs against a database the APP created (D27).
 *
 * The tool carries its own copy of initDatabase's cipher open sequence, because it
 * runs over stdin in the live container and in a scratch image that holds only the
 * driver. This suite is the drift guard: the fixture is created by initDatabase, so if
 * the two open sequences ever diverge, `snapshot` cannot open it and the first test
 * fails. Every FAIL path below has a PASS twin on the same fixture, so none of them
 * can pass because the fixture was broken to begin with.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, truncateSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DIR = mkdtempSync(join(tmpdir(), 'hippo-backup-dbtool-'));
const DB_PATH = join(DIR, 'live.db');
const PASS = 'test-passphrase-for-backup-dbtool';
process.env.HIPPO_PASSPHRASE = PASS;
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { findOrCreateEntity } = await import('../src/db/entities.js');
const { createObservation } = await import('../src/db/observations.js');

const TOOL = join(import.meta.dirname, '..', 'infra', 'backup', 'hippo-dbtool.mjs');

function run(args: string[], env: Record<string, string> = {}) {
  // Fed over stdin from the repo root, exactly as the nightly job feeds it into the
  // container (where cwd is /app), so module resolution is tested the real way too.
  const r = spawnSync(process.execPath, ['--input-type=module', '-', ...args], {
    input: readFileSync(TOOL),
    cwd: join(import.meta.dirname, '..'),
    env: { PATH: process.env.PATH ?? '', HIPPO_PASSPHRASE: PASS, HIPPO_DB_PATH: DB_PATH, ...env },
    encoding: 'utf8',
  });
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return { status: r.status, out: line ? JSON.parse(line) : null, stderr: r.stderr };
}

const SNAP = join(DIR, 'snap.db');
const MANIFEST = join(DIR, 'manifest.json');

before(() => {
  initDatabase();
  const e = findOrCreateEntity('backup-test-entity', 'project');
  createObservation(e.id, 'first observation', undefined, 1.0, 'fact');
  createObservation(e.id, 'second observation about something else', undefined, 1.0, 'fact');
  findOrCreateEntity('backup-test-other', 'person');
  // Leave the app's connection OPEN in WAL mode with uncheckpointed pages, which is the
  // state the nightly snapshot meets in production.
  assert.equal(getDatabase().pragma('journal_mode', { simple: true }), 'wal');
});

after(() => {
  closeDatabase();
  rmSync(DIR, { recursive: true, force: true });
});

describe('hippo-dbtool snapshot', () => {
  test('snapshots an app-created database while the app holds it open', () => {
    const r = run(['snapshot', SNAP]);
    assert.equal(r.status, 0, JSON.stringify(r.out) + r.stderr);
    assert.equal(r.out.ok, true);
    assert.equal(r.out.integrity, 'ok');
    assert.deepEqual(r.out.counts, { entities: 2, observations: 2, relationships: 0, embeddings: 0 });
    assert.equal(r.out.bytes, statSync(SNAP).size);
    // The cipher the app actually writes, read from the app's own connection. If this
    // ever stops being equal, the restore runbook's "open it with this driver" is stale.
    assert.equal(r.out.cipher, getDatabase().pragma('cipher', { simple: true }));
    writeFileSync(MANIFEST, JSON.stringify(r.out));
  });

  test('the snapshot is encrypted: no plaintext header, unreadable without the key', () => {
    const header = readFileSync(SNAP).subarray(0, 16).toString('latin1');
    assert.ok(!header.startsWith('SQLite format 3'));
    const r = run(['verify', SNAP, MANIFEST], { HIPPO_PASSPHRASE: 'the-wrong-passphrase' });
    assert.equal(r.status, 1);
    assert.equal(r.out.stage, 'open');
  });

  test('refuses to overwrite an existing file', () => {
    const r = run(['snapshot', SNAP]);
    assert.equal(r.status, 1);
    assert.equal(r.out.stage, 'snapshot');
  });
});

describe('hippo-dbtool verify', () => {
  test('PASS: the good snapshot verifies against its own manifest', () => {
    const r = run(['verify', SNAP, MANIFEST]);
    assert.equal(r.status, 0, JSON.stringify(r.out));
    assert.equal(r.out.ok, true);
  });

  test('FAIL: a truncated snapshot', () => {
    const bad = join(DIR, 'truncated.db');
    copyFileSync(SNAP, bad);
    truncateSync(bad, Math.floor(statSync(bad).size / 2));
    const r = run(['verify', bad, MANIFEST]);
    assert.equal(r.status, 1);
    assert.equal(r.out.ok, false);
    assert.ok(['open', 'verify', 'integrity', 'counts'].includes(r.out.stage), r.out.stage);
  });

  test('FAIL: counts that do not match the manifest', () => {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    m.counts.observations += 1;
    const wrong = join(DIR, 'manifest-wrong.json');
    writeFileSync(wrong, JSON.stringify(m));
    const r = run(['verify', SNAP, wrong]);
    assert.equal(r.status, 1);
    assert.equal(r.out.stage, 'counts');
    assert.match(r.out.reason, /observations 2 != 3/);
  });

  test('FAIL: a manifest that is not a hippo-snapshot manifest', () => {
    const junk = join(DIR, 'junk.json');
    writeFileSync(junk, '{"ok":true}');
    const r = run(['verify', SNAP, junk]);
    assert.equal(r.status, 1);
    assert.equal(r.out.stage, 'manifest');
  });
});

describe('drill image', () => {
  test('pins the same driver version as package-lock.json', () => {
    const lock = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package-lock.json'), 'utf8'));
    const locked = lock.packages['node_modules/better-sqlite3-multiple-ciphers'].version;
    const dockerfile = readFileSync(join(import.meta.dirname, '..', 'infra', 'backup', 'drill.Dockerfile'), 'utf8');
    const pinned = dockerfile.match(/^ARG DRIVER_VERSION=(\S+)$/m)?.[1];
    assert.equal(pinned, locked);
  });
});
