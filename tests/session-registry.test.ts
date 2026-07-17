import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SessionRegistry, type SessionTransport } from '../src/mcp/session-registry.js';

class FakeTransport implements SessionTransport {
  closed = false;
  constructor(public sessionId?: string) {}
  close() {
    this.closed = true;
  }
}

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('SessionRegistry', () => {
  it('touch returns the transport and refreshes lastSeen so it survives the sweep', () => {
    const clock = makeClock();
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, maxSessions: 10, now: clock.now });
    const t = new FakeTransport('a');
    reg.register('a', t);

    clock.advance(900);
    assert.strictEqual(reg.touch('a'), t); // refreshes lastSeen to now (900)

    clock.advance(900); // 1800 total, but only 900 since touch (< idleMs)
    reg.sweep();
    assert.strictEqual(reg.size, 1, 'a recently-touched session must not be evicted');
    assert.strictEqual(t.closed, false);
  });

  it('sweep evicts and closes sessions idle beyond idleMs', () => {
    const clock = makeClock();
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, maxSessions: 10, now: clock.now });
    const t = new FakeTransport('a');
    reg.register('a', t);

    clock.advance(1001);
    reg.sweep();
    assert.strictEqual(reg.size, 0, 'idle session is evicted — this is the leak fix');
    assert.strictEqual(t.closed, true, 'evicted transport is closed');
  });

  it('register over maxSessions evicts the least-recently-used', () => {
    const clock = makeClock();
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1e9, maxSessions: 2, now: clock.now });
    const a = new FakeTransport('a');
    const b = new FakeTransport('b');
    const c = new FakeTransport('c');
    reg.register('a', a);
    clock.advance(1);
    reg.register('b', b);
    clock.advance(1);
    reg.register('c', c); // size 3 > cap 2 → evict oldest (a)

    assert.strictEqual(reg.size, 2);
    assert.strictEqual(a.closed, true);
    assert.strictEqual(reg.touch('a'), undefined);
    assert.ok(reg.touch('b') && reg.touch('c'), 'b and c remain');
  });

  it('does not evict an in-flight session, and evicts it once idle after completion', () => {
    const clock = makeClock();
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, maxSessions: 10, now: clock.now });
    const t = new FakeTransport('a');
    reg.register('a', t);
    reg.setInFlight('a', 1);

    clock.advance(5000); // well past idleMs
    reg.sweep();
    assert.strictEqual(reg.size, 1, 'in-flight session survives the sweep');
    assert.strictEqual(t.closed, false);

    reg.setInFlight('a', -1);
    reg.sweep();
    assert.strictEqual(reg.size, 0, 'evicted once no longer in-flight');
    assert.strictEqual(t.closed, true);
  });

  it('evictOldest skips in-flight sessions and picks the oldest idle one', () => {
    const clock = makeClock();
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1e9, maxSessions: 2, now: clock.now });
    const a = new FakeTransport('a');
    const b = new FakeTransport('b');
    const c = new FakeTransport('c');
    reg.register('a', a);
    reg.setInFlight('a', 1); // oldest, but busy
    clock.advance(1);
    reg.register('b', b);
    clock.advance(1);
    reg.register('c', c); // over cap → evict oldest non-busy = b

    assert.strictEqual(a.closed, false, 'in-flight oldest is skipped');
    assert.strictEqual(b.closed, true);
    assert.strictEqual(reg.size, 2);
  });

  it('drop removes the entry WITHOUT closing (the onclose backstop path)', () => {
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, maxSessions: 10 });
    const a = new FakeTransport('a');
    reg.register('a', a);
    reg.drop('a');
    assert.strictEqual(reg.size, 0);
    assert.strictEqual(a.closed, false, 'drop must not close — avoids double-close with SDK');
  });

  it('close is a no-op on unknown ids and removes the entry even if close() throws', () => {
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, maxSessions: 10 });
    assert.doesNotThrow(() => reg.close('missing'));

    class ThrowingTransport extends FakeTransport {
      override close() {
        throw new Error('boom');
      }
    }
    const x = new ThrowingTransport('x');
    reg.register('x', x);
    assert.doesNotThrow(() => reg.close('x'));
    assert.strictEqual(reg.size, 0, 'entry removed even when transport.close throws');
  });

  it('setInFlight guards against underflow and ignores unknown sessions', () => {
    const clock = makeClock();
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 10, maxSessions: 10, now: clock.now });
    const a = new FakeTransport('a');
    reg.register('a', a); // inFlight 0
    reg.setInFlight('a', -1); // underflow guard → stays 0, not -1
    reg.setInFlight('ghost', 1); // unknown session → no throw

    clock.advance(11);
    reg.sweep(); // inFlight 0 + idle → must evict (no phantom in-flight count)
    assert.strictEqual(reg.size, 0, 'underflow did not leave a phantom in-flight count');
  });
});
