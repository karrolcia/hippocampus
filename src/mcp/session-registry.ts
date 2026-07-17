/**
 * Tracks live MCP sessions and evicts idle ones so the per-session McpServer
 * (tools, schemas, SDK handler maps) can be garbage-collected.
 *
 * Why this exists: the Streamable HTTP transport only drops a session on an
 * explicit client DELETE (`onsessionclosed`). Claude.ai and most HTTP MCP
 * clients reconnect with a fresh session and never DELETE, so without a
 * server-side idle sweep the session map grows without bound — one retained
 * McpServer per session — until the process OOMs. Observed 2026-07-17: ~1.9 GB
 * of live heap after ~7 weeks uptime while the DB held only ~5.8 MB.
 *
 * Removing the map entry is what actually stops the leak (the transport and its
 * wired server become an unreferenced island); closing the transport also frees
 * any open stream controllers promptly.
 */

/** Minimal shape the registry needs from a transport. */
export interface SessionTransport {
  sessionId?: string;
  close(): void | Promise<void>;
}

interface Entry<T> {
  transport: T;
  lastSeen: number;
  inFlight: number;
}

export interface SessionRegistryOptions {
  /** Evict sessions with no activity for longer than this (ms). */
  idleMs: number;
  /** Hard cap on concurrent sessions; the oldest idle one is evicted over cap. */
  maxSessions: number;
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number;
}

export class SessionRegistry<T extends SessionTransport> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly idleMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(opts: SessionRegistryOptions) {
    this.idleMs = opts.idleMs;
    this.maxSessions = opts.maxSessions;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Look up an active session and stamp it as just-used. */
  touch(sessionId: string): T | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    entry.lastSeen = this.now();
    return entry.transport;
  }

  /** Register a newly-initialized session; evicts the oldest idle one over cap. */
  register(sessionId: string, transport: T): void {
    this.entries.set(sessionId, { transport, lastSeen: this.now(), inFlight: 0 });
    if (this.entries.size > this.maxSessions) this.evictOldest();
  }

  /** Bump the in-flight request count so a busy session is never evicted. */
  setInFlight(sessionId: string, delta: 1 | -1): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.inFlight = Math.max(0, entry.inFlight + delta);
  }

  /** Remove a session's entry WITHOUT closing (for the transport.onclose backstop). */
  drop(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** Remove a session and close its transport. Idempotent; swallows close errors. */
  close(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    try {
      const result = entry.transport.close();
      // Fire-and-forget close: never let an async rejection go unhandled.
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      /* already closed */
    }
  }

  /** Evict the least-recently-used session that is not mid-request. */
  evictOldest(): void {
    let oldestId: string | null = null;
    let oldestSeen = Infinity;
    for (const [id, entry] of this.entries) {
      if (entry.inFlight > 0) continue;
      if (entry.lastSeen < oldestSeen) {
        oldestSeen = entry.lastSeen;
        oldestId = id;
      }
    }
    if (oldestId) this.close(oldestId);
  }

  /** Close every session idle beyond idleMs that is not mid-request. */
  sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, entry] of this.entries) {
      // `<= 0` (not `=== 0`) so this stays correct independent of the
      // setInFlight underflow clamp — a stray negative count can't wedge a
      // session into a never-swept state.
      if (entry.inFlight <= 0 && entry.lastSeen < cutoff) this.close(id);
    }
  }
}
