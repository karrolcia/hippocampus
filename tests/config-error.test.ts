/**
 * A bad environment must fail with the readable "Configuration error" list, not a
 * TypeError from inside the error path. zod 4 renamed ZodError.errors to .issues;
 * tsx strips types, so the suite stayed green while that path would have thrown on
 * `undefined.map` (D30). Config is read eagerly at import, so each case is a child.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadWith(env: Record<string, string>) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/config.ts')"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('config error path', () => {
  test('an invalid value names the field and its message', () => {
    const { status, out } = loadWith({ HIPPO_PASSPHRASE: 'p', HIPPO_AGENT_TOKEN: 'too-short' });
    assert.notEqual(status, 0);
    assert.match(out, /Configuration error:\nagentToken: /);
    assert.doesNotMatch(out, /TypeError/);
  });

  test('a missing passphrase reports its own message', () => {
    const { status, out } = loadWith({ HIPPO_PASSPHRASE: '' });
    assert.notEqual(status, 0);
    assert.match(out, /passphrase: HIPPO_PASSPHRASE is required/);
  });

  test('a valid environment loads', () => {
    const { status, out } = loadWith({ HIPPO_PASSPHRASE: 'p' });
    assert.equal(status, 0, out);
  });
});
