/**
 * Ways `scripts/sync-agents.ts` can still read — or write — an incomplete agent
 * list and not notice (D19). Follow-up to D17, which closed the in-band-error
 * and degraded-index legs of the same problem. The first two below are the ones
 * it did not reach; the rest surfaced in review of the fix for them.
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

const { describeSaturation, describeUnderCount, cmdPull, PULL_RECALL_LIMIT } =
  await import('../scripts/sync-agents.ts');

const HEALTHY_TEXT = '#I 0 results, 0 entities';

function index(over: Record<string, unknown> = {}) {
  return { success: true, count: 0, text: HEALTHY_TEXT, degraded: false, ...over };
}

/**
 * Answers `recall` with one index, `export` with an entity count, and `context`
 * with whatever the test wants.
 *
 * The `recall` branch asserts the limit actually SENT. Without that the drift
 * the constant exists to prevent is invisible: a review mutation that changed
 * cmdPull's request to `limit: 25` while the guard kept comparing against 50
 * left this suite fully green, and in that state a 25-observation truncated
 * index passes straight through into a silent partial pull.
 */
function fakeClient(
  idx: Record<string, unknown>,
  contextFor?: (topic: string) => unknown,
  exportEntityCount?: number
) {
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      if (name === 'context') {
        if (!contextFor) throw new Error('unexpected context call');
        return contextFor(String(args.topic));
      }
      if (name === 'export') {
        // Round 1 pinned the limit on the `recall` branch and left this one
        // ignoring args: deleting `type: "agent"` from cmdPull's export call
        // failed zero tests, while in production it makes export list the whole
        // knowledge base and refuse every pull forever.
        assert.equal(args.type, 'agent', 'the export cross-check must be scoped to agents');
        return {
          success: true,
          entity_count: exportEntityCount ?? countAgentLines(idx),
          observation_count: 0,
        };
      }
      assert.equal(
        args.limit,
        PULL_RECALL_LIMIT,
        'cmdPull must request exactly the limit its saturation guard compares against'
      );
      return idx;
    },
  } as never;
}

/** Resolves every topic to itself, so the name assertion is satisfied. */
function echoContext(topic: string) {
  return {
    success: true,
    entity: { name: topic, observations: [{ content: 'do the thing', kind: 'instruction' }] },
  };
}

/** How many `agent:` lines the fixture index carries — the oracle's default. */
function countAgentLines(idx: Record<string, unknown>): number {
  return Array.from(String(idx.text ?? '').matchAll(/^agent:[\w.-]+\|/gm)).length;
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
      () => cmdPull(true, false, fakeClient(SATURATED, echoContext)),
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
      () => cmdPull(true, true, fakeClient(SATURATED, echoContext)),
      /refusing to pull from a truncated index/
    );
  });

  test('saturation is checked before degradation, so the unbypassable one wins', async () => {
    // Must run with allowDegraded FALSE. With it true the degraded gate only
    // warns, so both orderings throw the same truncation error and the test
    // proves nothing — a review mutation that moved the saturation block after
    // the degraded gate kept this suite green. With it false the order decides
    // which message the operator gets, and the wrong one tells them to re-run
    // with --allow-degraded, which is the single instruction this must not give.
    const both = index({ count: PULL_RECALL_LIMIT, degraded: true, degraded_reason: 'Error: boom' });
    await assert.rejects(
      () => cmdPull(true, false, fakeClient(both, echoContext)),
      (err: Error) => {
        assert.match(err.message, /truncated/);
        assert.doesNotMatch(
          err.message,
          /--allow-degraded/,
          'a truncated index must never be reported as something a flag can accept'
        );
        return true;
      }
    );
  });

  test('CONTROL: with --allow-degraded the same fixture still refuses on truncation', async () => {
    const both = index({ count: PULL_RECALL_LIMIT, degraded: true, degraded_reason: 'Error: boom' });
    await assert.rejects(() => cmdPull(true, true, fakeClient(both, echoContext)), /truncated/);
  });

  test('CONTROL: an unsaturated index is never refused', async () => {
    // Without this, a refusal that fired unconditionally would pass every
    // assertion above.
    await cmdPull(true, false, fakeClient(index({ count: 3 }), echoContext));
  });
});

describe('the export cross-check catches an agent the search dropped', () => {
  // This is the check that actually holds. `recall` filters at
  // SIMILARITY_THRESHOLD = 0.15 AFTER slicing, so a count under the limit does
  // not mean the enumeration was exhaustive — measured on prod, export sees 27
  // observations where the same recall sees 22. `export` goes through
  // listEntities with no embeddings and no floor, so its entity_count is ground
  // truth to check the search against.
  const TWO_LISTED = index({
    count: 4,
    text: '#I 4 results, 2 entities\nagent:alpha|agent|2 obs|0.31\nagent:beta|agent|2 obs|0.29',
  });

  test('fewer agents in the index than exist on the server is reported', () => {
    const msg = describeUnderCount(3, 2, 2);
    assert.ok(msg);
    assert.match(msg, /lists 2 agent\(s\) but export reports 3/);
    assert.match(msg, /1 agent\(s\) are missing/);
  });

  test('CONTROL: equal counts are not reported', () => {
    assert.equal(describeUnderCount(2, 2, 2), null);
  });

  test('CONTROL: more in the index than export is not reported', () => {
    // Only under-count is loss. Over-count would mean export is the stale one,
    // which is not a reason to refuse a pull.
    assert.equal(describeUnderCount(2, 3, 3), null);
  });

  test('a server that reports no entity_count fails closed, and names which check could not run', () => {
    const msg = describeUnderCount(undefined as unknown as number, 2, 2);
    assert.ok(msg, 'an unusable oracle must not read as an all-clear');
    assert.match(msg, /did not report an entity_count/);
    assert.doesNotMatch(msg, /agent\(s\) are missing/, 'it must not invent a missing agent');
  });

  test('pull refuses when the server holds an agent the index never showed', async () => {
    await assert.rejects(
      () => cmdPull(true, false, fakeClient(TWO_LISTED, echoContext, 3)),
      (err: Error) => {
        assert.match(err.message, /refusing to pull from an incomplete index/);
        assert.match(err.message, /0\.15 similarity floor/);
        assert.match(
          err.message,
          /no observations at all/,
          'the message must offer both causes — a zero-observation entity produces the same ' +
            'shortfall, and blaming the floor for it is a false explanation'
        );
        return true;
      }
    );
  });

  test('--allow-degraded does not buy past it either', async () => {
    await assert.rejects(
      () => cmdPull(true, true, fakeClient(TWO_LISTED, echoContext, 3)),
      /refusing to pull from an incomplete index/
    );
  });

  test('an index emptied entirely refuses instead of reporting "no agents found"', async () => {
    // The worst cell: every agent filtered out lands in the empty-list branch,
    // whose message states the exact opposite of the truth with total confidence.
    // The oracle is checked before that branch precisely for this.
    await assert.rejects(
      () => cmdPull(true, false, fakeClient(index({ count: 0 }), echoContext, 14)),
      /refusing to pull from an incomplete index/
    );
  });

  test('CONTROL: a genuinely empty server still reports no agents, not a refusal', async () => {
    // Without this, an oracle that refused whenever the index was empty would
    // pass the test above while breaking the legitimate empty case.
    await cmdPull(true, false, fakeClient(index({ count: 0 }), echoContext, 0));
  });

  test('CONTROL: matching counts pass through untouched', async () => {
    // contextFor echoes the requested topic, so the name assertion is satisfied
    // for both agents and this control isolates the oracle. (Returning a fixed
    // name here instead makes the SECOND agent trip the name guard, which exits
    // the process rather than failing an assertion — worth the explicitness.)
    const code = await runCapturingExit(() =>
      cmdPull(true, false, fakeClient(TWO_LISTED, echoContext, 2))
    );
    assert.equal(code, undefined, 'a complete, name-matched index must not exit non-zero');
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

describe('the two sources disagreeing the other way is said out loud', () => {
  test('an index listing MORE agents than export warns, and still proceeds', async () => {
    // Not a refusal: export would be the stale side and the agents listed
    // demonstrably exist. But a contradiction between two sources of truth that
    // nothing mentions is how absence becomes an all-clear, so it warns — and
    // covering that only through the predicate leaves the branch deletable.
    const TWO = index({
      count: 2,
      entity_count: 2,
      text: '#I 2 results, 2 entities\nagent:alpha|agent|1 obs|0.31\nagent:beta|agent|1 obs|0.30',
    });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
    let code: number | undefined;
    try {
      code = await runCapturingExit(() => cmdPull(true, false, fakeClient(TWO, echoContext, 1)));
    } finally {
      console.warn = realWarn;
    }
    assert.equal(code, undefined, 'an over-count must not stop the pull');
    assert.ok(
      warnings.some((w) => /lists 2 agents but export reports 1/.test(w)),
      `expected a disagreement warning, got: ${JSON.stringify(warnings)}`
    );
  });
});

describe('a checkpoint is never mistaken for an instruction', () => {
  // Pre-existing, live, and the reason this file's own "verified healthy on
  // prod" claim was wrong. The content-shape fallback (for pre-v0.4.2 servers
  // that omitted `kind`) ran whenever no instruction was FOUND, so on a server
  // that does report kind, an agent holding only a checkpoint matched "first
  // observation that isn't a schedule" and `last_run: …` became the skill body
  // — written with a ✓, counted as materialized, exit 0. Three prod agents are
  // checkpoint-only. The next `push` then stored that text back as
  // kind: "instruction", putting it in the canonical store.
  const ONE = index({
    count: 1,
    entity_count: 1,
    text: '#I 1 results, 1 entities\nagent:resume-watcher|agent|1 obs|0.29',
  });
  const ckpt = 'last_run: 2026-09-02T16:20:41+03:00\nlast_status: completed\n';

  function ctxWith(observations: Array<{ content: string; kind?: string | null }>) {
    return () => ({ success: true, entity: { name: 'agent:resume-watcher', observations } });
  }

  test('a checkpoint-only agent is skipped, not materialized from its checkpoint', async () => {
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    let code: number | undefined;
    try {
      code = await runCapturingExit(() =>
        cmdPull(true, false, fakeClient(ONE, ctxWith([{ content: ckpt, kind: 'checkpoint' }]), 1))
      );
    } finally {
      console.log = realLog;
    }
    assert.equal(code, 1, 'an agent with no instruction must not be reported as materialized');
    assert.ok(
      !logs.some((l) => /last_run:/.test(l)),
      `a checkpoint must never reach a SKILL.md body, got: ${JSON.stringify(logs)}`
    );
  });

  test('an observation of some other kind is not promoted either', async () => {
    // One prod agent holds a lone `kind: fact` whose prose reads like an
    // instruction. Plausible-looking is exactly why it must not be guessed at.
    const code = await runCapturingExit(() =>
      cmdPull(true, false, fakeClient(ONE, ctxWith([{ content: 'Ping Alex on 2026-05-15', kind: 'fact' }]), 1))
    );
    assert.equal(code, 1);
  });

  test('CONTROL: a real instruction observation still materializes', async () => {
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    let code: number | undefined;
    try {
      code = await runCapturingExit(() =>
        cmdPull(true, false, fakeClient(ONE, ctxWith([
          { content: 'do the real work', kind: 'instruction' },
          { content: 'cron: "0 9 * * *"\nenabled: true\n', kind: 'schedule' },
        ]), 1))
      );
    } finally {
      console.log = realLog;
    }
    assert.equal(code, undefined, 'a well-formed agent must still pull cleanly');
    assert.ok(logs.some((l) => /do the real work/.test(l)));
  });

  test('a mixed-kind entity is skipped with the cause named, not called instruction-less', async () => {
    // `kind` is nullable per observation, so an entity can hold an instruction
    // written before schema V5 (kind NULL) beside a schedule written after it.
    // Falling back here is what promoted checkpoints, so it stays a skip — but
    // "no 'instruction' observation" would be false, and would send the operator
    // to re-create an instruction that already exists.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
    let code: number | undefined;
    try {
      code = await runCapturingExit(() =>
        cmdPull(true, false, fakeClient(ONE, ctxWith([
          { content: 'cron: "0 9 * * *"\nenabled: true\n', kind: 'schedule' },
          { content: 'legacy untagged instruction', kind: null },
        ]), 1))
      );
    } finally {
      console.warn = realWarn;
    }
    assert.equal(code, 1);
    assert.ok(
      warnings.some((w) => /written before schema V5/.test(w)),
      `expected the untagged-observation cause, got: ${JSON.stringify(warnings)}`
    );
  });

  test('CONTROL: a server that reports no kind at all still uses the shape fallback', async () => {
    // The fallback is not deleted — it is scoped. A pre-v0.4.2 server sends no
    // `kind` anywhere, and there the shape heuristic is the only signal there is.
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    let code: number | undefined;
    try {
      code = await runCapturingExit(() =>
        // Explicit `kind: null`, which is what the server actually sends for a
        // pre-V5 observation — an omitted key would pass `!= null` too and would
        // not mirror the wire.
        cmdPull(true, false, fakeClient(ONE, ctxWith([
          { content: 'legacy instruction body', kind: null },
          { content: 'cron: "0 9 * * *"\nenabled: true\n', kind: null },
        ]), 1))
      );
    } finally {
      console.log = realLog;
    }
    assert.equal(code, undefined);
    assert.ok(logs.some((l) => /legacy instruction body/.test(l)));
  });
});

describe('a name the regex dropped is not blamed on the similarity floor', () => {
  test('a parse shortfall says it is a parse shortfall', () => {
    // The search found 3 entities, the regex could only parse 2 (a name with a
    // colon, say). Same numeric shortfall as a floor-dropped agent, entirely
    // different cause and fix.
    const msg = describeUnderCount(3, 3, 2);
    assert.ok(msg);
    assert.match(msg, /could not be parsed/);
    assert.doesNotMatch(msg, /similarity floor/, 'a parse bug must not be blamed on the server');
  });

  test('CONTROL: when the parse matches the index, the floor explanation is the one given', () => {
    const msg = describeUnderCount(3, 2, 2);
    assert.ok(msg);
    assert.match(msg, /similarity floor/);
    assert.doesNotMatch(msg, /could not be parsed/);
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
