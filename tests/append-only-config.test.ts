/**
 * The append-only exemption list is configurable (D10) — a deployment with
 * different log-entity naming must be able to protect its own entities without
 * a code change. Config is read eagerly at import, so the env var is set before
 * the project modules load. No DB or embedding model needed.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-append-only-config';
process.env.HIPPO_APPEND_ONLY_PREFIXES = ' journal: , Notes:Log: ';

const { config, DEFAULT_APPEND_ONLY_PREFIXES, parseAppendOnlyPrefixes } = await import(
  '../src/config.js'
);
const { isAppendOnlyEntity } = await import('../src/mcp/tools/remember.js');

describe('HIPPO_APPEND_ONLY_PREFIXES', () => {
  test('parses a comma-separated list, trimmed and lowercased', () => {
    assert.deepEqual(config.appendOnlyPrefixes, ['journal:', 'notes:log:']);
  });

  test('the configured prefixes replace the defaults', () => {
    assert.equal(isAppendOnlyEntity('journal:2026-08-21'), true);
    assert.equal(isAppendOnlyEntity('Notes:Log:standup'), true);
    assert.equal(isAppendOnlyEntity('ops:daily-log:hippocampus'), false, 'defaults are overridden');
  });

  test('a blank value falls back to the defaults, it does not disable protection', () => {
    // docker-compose forwards an unset variable as "" via the ${VAR:-} idiom the
    // compose file uses throughout. If blank meant "no exemptions", merely
    // forwarding the variable would silently unprotect every log entity.
    for (const blank of ['', '   ', '\n']) {
      assert.deepEqual(
        parseAppendOnlyPrefixes(blank),
        ['ops:daily-log:', 'ops:session-check', 'synthesis:'],
        `blank input ${JSON.stringify(blank)} must fall back to the defaults`
      );
    }
  });

  test('disabling exemptions requires typing it out', () => {
    assert.deepEqual(parseAppendOnlyPrefixes('none'), []);
    assert.deepEqual(parseAppendOnlyPrefixes('  NONE  '), []);
  });

  test('a list is trimmed, lowercased, and empty entries dropped', () => {
    assert.deepEqual(parseAppendOnlyPrefixes('A:, ,B:log:,'), ['a:', 'b:log:']);
  });

  test('the shipped defaults cover the entities that were losing data', () => {
    const defaults = DEFAULT_APPEND_ONLY_PREFIXES.split(',').map(p => p.trim());
    for (const prefix of ['ops:daily-log:', 'ops:session-check', 'synthesis:']) {
      assert.ok(defaults.includes(prefix), `default list must include ${prefix}`);
    }
  });
});
