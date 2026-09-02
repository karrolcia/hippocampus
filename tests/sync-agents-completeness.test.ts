/**
 * Two ways `scripts/sync-agents.ts` can still read an incomplete agent list and
 * not notice (D18). Follow-up to D17, which closed the in-band-error and
 * degraded-index legs of the same problem; these are the two it did not reach.
 *
 * 1. SATURATION. The enumeration passes `limit: 50`, which is `recall`'s schema
 *    maximum — it cannot be raised — and it bounds OBSERVATIONS, not entities.
 *    Each agent holds two or three, so the real ceiling is roughly 16-25 agents,
 *    and past it `recall` drops the tail silently: `success: true`,
 *    `degraded: false`, a full-looking result set that is simply short. Nothing
 *    in D17's checks fires, because nothing failed.
 *
 * 2. FUZZY TOPIC RESOLUTION. `context` matches `topic` loosely — production
 *    answers a request for `agent:signal-sca` with `agent:signal-scan` and
 *    `success: true` (verified live 2026-09-02). `pull` read the observations
 *    without checking which entity came back, so a near-miss would write one
 *    agent's instruction into another agent's SKILL.md.
 *
 * Both fail the same direction as everything in the D13/D15/D16/D17 chain:
 * quietly, toward fewer or wrong agents, wearing a healthy run's shape.
 *
 * Each guard is pinned through `cmdPull` itself, not only through its predicate.
 * D17's own review round is why: deleting the refusal branch left that suite
 * green because the helper was covered and the branch acting on it was not.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { describeSaturation, cmdPull, PULL_RECALL_LIMIT } = await import('../scripts/sync-agents.ts');

const HEALTHY_TEXT = '#I 0 results, 0 entities';

function index(over: Record<string, unknown> = {}) {
  return { success: true, count: 0, text: HEALTHY_TEXT, degraded: false, ...over };
}

/** Answers `recall` with one index and `context` with whatever the test wants. */
function fakeClient(
  idx: Record<string, unknown>,
  contextFor?: (topic: string) => unknown
) {
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      if (name === 'context') {
        if (!contextFor) throw new Error('unexpected context call');
        return contextFor(String(args.topic));
      }
      return idx;
    },
  } as never;
}

/**
 * `cmdPull` signals per-agent failure with `process.exit(1)` rather than a
 * return value, so an in-process test has to intercept it. Stubbed rather than
 * refactored: the exit is D17's landed contract and this change does not
 * relitigate it.
 */
async function runCapturingExit(fn: () => Promise<void>): Promise<number | undefined> {
  const realExit = process.exit;
  let code: number | undefined;
  const SENTINEL = '__process_exit_stub__';
  (process as { exit: unknown }).exit = (c?: number) => {
    code = c;
    throw new Error(SENTINEL);
  };
  try {
    await fn();
  } catch (err) {
    if ((err as Error).message !== SENTINEL) throw err;
  } finally {
    (process as { exit: unknown }).exit = realExit;
  }
  return code;
}

const realFetch = globalThis.fetch;
before(() => {
  // Nothing here should reach the network; a fake client is passed to every
  // call. This is a tripwire, not plumbing — if a code path ever builds its own
  // client, the test fails loudly instead of hitting prod.
  globalThis.fetch = (async () => {
    throw new Error('no test in this file may touch the network');
  }) as unknown as typeof globalThis.fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

describe('describeSaturation: a full result set is a truncated one', () => {
  test('a count reaching the limit is reported, and names the exhaustive primitive', () => {
    const msg = describeSaturation(index({ count: 50 }), 50);
    assert.ok(msg, 'a saturated index must be reported');
    assert.match(msg, /50 observations against a limit of 50/);
    // "Raise the limit" is not available — 50 IS recall's schema max — so the
    // message has to point somewhere that actually works, or it sends the
    // operator to edit a constant that will be rejected by the server.
    assert.match(msg, /export\(/);
    assert.doesNotMatch(msg, /raise the limit/i);
  });

  test('CONTROL: one observation below the limit is not reported', () => {
    assert.equal(describeSaturation(index({ count: 49 }), 50), null);
  });

  test('CONTROL: an empty index is not reported', () => {
    assert.equal(describeSaturation(index({ count: 0 }), 50), null);
  });

  test('the limit checked is the limit sent', () => {
    // The constant exists so the guard and the request cannot drift apart; if
    // they do, the check silently measures against the wrong ceiling.
    assert.equal(PULL_RECALL_LIMIT, 50);
    assert.ok(describeSaturation(index({ count: PULL_RECALL_LIMIT }), PULL_RECALL_LIMIT));
  });
});

describe('pull refuses a truncated index, and no flag buys past it', () => {
  const SATURATED = index({ count: PULL_RECALL_LIMIT });

  test('a saturated index stops the pull', async () => {
    await assert.rejects(
      () => cmdPull(true, false, fakeClient(SATURATED)),
      (err: Error) => {
        assert.match(err.message, /refusing to pull from a truncated index/);
        assert.match(err.message, /export\(/, 'the message must name the way forward');
        return true;
      }
    );
  });

  test('--allow-degraded does NOT bypass it — the two failures are different bargains', async () => {
    // The distinction this test exists to hold: --allow-degraded means "I
    // accept a search that could not run fully". Truncation is deterministic
    // loss of named agents with the limit already at the server's maximum, so
    // there is nothing to accept it FOR.
    await assert.rejects(
      () => cmdPull(true, true, fakeClient(SATURATED)),
      /refusing to pull from a truncated index/
    );
  });

  test('saturation is checked before degradation, so the unbypassable one wins', async () => {
    const both = index({ count: PULL_RECALL_LIMIT, degraded: true, degraded_reason: 'Error: boom' });
    await assert.rejects(
      () => cmdPull(true, true, fakeClient(both)),
      /truncated/,
      'with --allow-degraded set, the degraded check passes and saturation must still fire'
    );
  });

  test('CONTROL: an unsaturated index is never refused', async () => {
    // Without this, a refusal that fired unconditionally would pass every
    // assertion above.
    await cmdPull(true, false, fakeClient(index({ count: 3 })));
  });
});

describe('pull will not materialize one agent from another agent’s observations', () => {
  const ONE_AGENT = index({ count: 2, text: '#I 2 results, 1 entities\nagent:signal-sca|agent|2 obs|0.31' });

  function ctx(name: string) {
    return {
      success: true,
      entity: { name, observations: [{ content: 'do the thing', kind: 'instruction' }] },
    };
  }

  test('a fuzzy resolution to a different entity is a failure, not a silent write', async () => {
    const code = await runCapturingExit(() =>
      // dry run: the guard fires before any write, and this keeps the real
      // ~/.claude/scheduled-tasks out of the test either way.
      cmdPull(true, false, fakeClient(ONE_AGENT, () => ctx('agent:signal-scan')))
    );
    assert.equal(code, 1, 'a mismatched entity must make the run fail');
  });

  test('CONTROL: the same agent resolving to its own name completes cleanly', async () => {
    // Proves the test above is measuring the name check and not merely that
    // this fixture always exits 1.
    const code = await runCapturingExit(() =>
      cmdPull(true, false, fakeClient(ONE_AGENT, () => ctx('agent:signal-sca')))
    );
    assert.equal(code, undefined, 'an exact match must not exit non-zero');
  });

  test('a context response carrying no entity is attributed to the name check', async () => {
    // Exit 1 alone does not discriminate here: without the name check this
    // response also reaches `no 'instruction' observation` and exits 1 as a
    // SKIP. So the assertion is on the reason, which is the thing that sends
    // the operator to the right file — a fetch that returned the wrong shape,
    // not an agent missing its instruction.
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(' '));
    let code: number | undefined;
    try {
      code = await runCapturingExit(() =>
        cmdPull(true, false, fakeClient(ONE_AGENT, () => ({ success: false })))
      );
    } finally {
      console.error = realError;
    }
    assert.equal(code, 1);
    assert.ok(
      errors.some((e) => /context resolved to no entity/.test(e)),
      `expected the mismatch reason, got: ${JSON.stringify(errors)}`
    );
  });
});

describe('a server that cannot report degradation says so', () => {
  test('an absent degraded flag warns but does not refuse', async () => {
    // D17 settled that absent must not mean degraded — the script has to work
    // against a server it did not deploy, and prod itself answered without the
    // field earlier on the day this was written. What is added here is only
    // disclosure: the run proceeds, and says the guarantee is missing.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
    try {
      await cmdPull(true, false, fakeClient({ success: true, count: 0, text: HEALTHY_TEXT }));
    } finally {
      console.warn = realWarn;
    }
    assert.ok(
      warnings.some((w) => /does not report the 'degraded' flag/.test(w)),
      `expected an unverified-completeness warning, got: ${JSON.stringify(warnings)}`
    );
  });

  test('CONTROL: degraded: false is a real all-clear and warns about nothing', async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
    try {
      await cmdPull(true, false, fakeClient(index({ count: 0 })));
    } finally {
      console.warn = realWarn;
    }
    assert.deepEqual(warnings, []);
  });
});
