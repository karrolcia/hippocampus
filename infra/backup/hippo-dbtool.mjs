// hippo-dbtool.mjs — the only code in the backup path that opens the database.
//
//   node hippo-dbtool.mjs snapshot <out.db>               (inside the live container)
//   node hippo-dbtool.mjs verify   <restored.db> <manifest.json>   (drill scratch container)
//
// Self-contained on purpose: the nightly job feeds it over stdin into the RUNNING
// hippocampus container (`docker exec -i hippocampus node --input-type=module - snapshot …`),
// so it cannot import a sibling file, and the drill runs it in a scratch image that
// holds only the driver. The passphrase comes from HIPPO_PASSPHRASE in the environment,
// never argv. Prints exactly one JSON object on stdout; exits non-zero on any failure.
//
// Why VACUUM INTO and not the online backup API: under SQLite3MultipleCiphers
// `db.backup()` refuses an encrypted source ("incompatible source and target databases"),
// while VACUUM INTO writes a transactionally consistent copy ENCRYPTED WITH THE SAME KEY
// (random header, SQLITE_NOTADB without the key). Measured 2026-10-22; D27. A `cp` of
// the live file is never consistent: the newest pages sit in the -wal file.
//
// The tool must open whatever src/db/index.ts initDatabase creates. Measured 2026-10-22 on
// both a fresh database and prod: the cipher is SQLite3MultipleCiphers' DEFAULT, ChaCha20
// (`PRAGMA cipher` = chacha20), not SQLCipher AES-256, because initDatabase issues no
// `cipher` pragma, and its `cipher_page_size` / `kdf_iter` pragmas come AFTER `key`, where
// they do not change how an existing file opens (a 64000 kdf_iter after key still opens it).
// So `key` alone is the open sequence, and recovery needs this driver, not the sqlcipher
// CLI. tests/backup-dbtool.test.ts opens an initDatabase-created file with this tool and
// pins the cipher, so if the app ever changes cipher this suite fails (mutation-checked).
import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, readFileSync, statSync } from 'node:fs';

const COUNTED = ['entities', 'observations', 'relationships', 'embeddings'];

function die(stage, reason) {
  process.stdout.write(JSON.stringify({ ok: false, stage, reason: String(reason).slice(0, 300) }) + '\n');
  process.exit(1);
}

function openEncrypted(path, { readonly }) {
  const passphrase = process.env.HIPPO_PASSPHRASE;
  if (!passphrase) die('open', 'HIPPO_PASSPHRASE is not set');
  if (!existsSync(path)) die('open', `no such file: ${path}`);
  const db = new Database(path, { readonly, fileMustExist: true });
  db.pragma(`key = "${passphrase.replace(/"/g, '""')}"`);
  try {
    db.pragma('cipher_integrity_check');
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (e) {
    die('open', `cannot open encrypted database (wrong passphrase or not a database): ${e.code ?? e.message}`);
  }
  return db;
}

function measure(db) {
  const integrity = db.pragma('integrity_check', { simple: true });
  const counts = {};
  for (const t of COUNTED) counts[t] = db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
  const schema_version = db.prepare('SELECT max(version) AS v FROM schema_version').get().v;
  const cipher = db.pragma('cipher', { simple: true });
  return { integrity, counts, schema_version, cipher };
}

const [cmd, a, b] = process.argv.slice(2);

if (cmd === 'snapshot') {
  if (!a) die('usage', 'snapshot <out.db>');
  if (existsSync(a)) die('snapshot', `refusing to overwrite ${a}`);
  let live;
  try {
    live = openEncrypted(process.env.HIPPO_DB_PATH || '/data/hippocampus.db', { readonly: false });
    live.prepare('VACUUM INTO ?').run(a);
  } catch (e) {
    die('snapshot', `VACUUM INTO failed: ${e.code ?? e.message}`);
  } finally {
    live?.close();
  }
  // Measure the SNAPSHOT, not the live db: the manifest must describe the bytes we ship.
  const snap = openEncrypted(a, { readonly: true });
  const m = measure(snap);
  snap.close();
  if (m.integrity !== 'ok') die('snapshot', `integrity_check on the fresh snapshot: ${m.integrity}`);
  const header = readFileSync(a).subarray(0, 16).toString('latin1');
  if (header.startsWith('SQLite format 3')) die('snapshot', 'snapshot has a plaintext SQLite header; refusing to ship it');
  process.stdout.write(JSON.stringify({
    ok: true, kind: 'hippo-snapshot', format: 1,
    taken_at: new Date().toISOString(), bytes: statSync(a).size, ...m,
  }) + '\n');
} else if (cmd === 'verify') {
  if (!a || !b) die('usage', 'verify <restored.db> <manifest.json>');
  let manifest;
  try { manifest = JSON.parse(readFileSync(b, 'utf8')); } catch (e) { die('manifest', `unreadable manifest: ${e.message}`); }
  if (manifest.kind !== 'hippo-snapshot' || !manifest.counts) die('manifest', 'not a hippo-snapshot manifest');
  let m;
  try {
    const db = openEncrypted(a, { readonly: true });
    m = measure(db);
    db.close();
  } catch (e) {
    die('verify', `reading the restored database failed: ${e.code ?? e.message}`);
  }
  if (m.integrity !== 'ok') die('integrity', `integrity_check: ${String(m.integrity).slice(0, 200)}`);
  if (m.schema_version !== manifest.schema_version) {
    die('schema', `schema_version ${m.schema_version} != manifest ${manifest.schema_version}`);
  }
  const diffs = COUNTED.filter((t) => m.counts[t] !== manifest.counts[t])
    .map((t) => `${t} ${m.counts[t]} != ${manifest.counts[t]}`);
  if (diffs.length) die('counts', diffs.join('; '));
  if (m.counts.entities < 1 || m.counts.observations < 1) die('counts', 'restored database is empty');
  process.stdout.write(JSON.stringify({ ok: true, kind: 'hippo-verify', ...m, manifest_taken_at: manifest.taken_at }) + '\n');
} else {
  die('usage', 'hippo-dbtool.mjs snapshot <out.db> | verify <restored.db> <manifest.json>');
}
