import type { Context, Next } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isIP } from 'node:net';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// One Map per limiter instance, all swept by the single timer below.
const stores = new Set<Map<string, RateLimitEntry>>();

/**
 * True for addresses that can only be a proxy on this host or its private
 * network: loopback, RFC 1918, CGNAT, link-local, IPv6 ULA. Behind Docker's
 * port publish the app sees the bridge gateway (172.18.0.1 on prod), not
 * 127.0.0.1, which is why the private ranges are here and not loopback alone.
 */
export function isTrustedProxyPeer(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return false;
}

// Node reports an IPv4 peer on a dual-stack socket as ::ffff:a.b.c.d.
function unmapIPv4(address: string): string {
  return address.toLowerCase().startsWith('::ffff:') && isIP(address.slice(7)) === 4
    ? address.slice(7)
    : address;
}

function socketPeer(c: Context): string | undefined {
  try {
    const address = getConnInfo(c).remote.address;
    return address ? unmapIPv4(address) : undefined;
  } catch {
    // No Node socket on the context (app.request() in tests).
    return undefined;
  }
}

/**
 * The address a request is counted against.
 *
 * `X-Forwarded-For` is client-writable, so it is read only when the socket
 * peer is a trusted proxy, and then only its RIGHTMOST entry: the one that
 * proxy wrote itself. Caddy without `trusted_proxies` replaces the header with
 * the real peer; a proxy that appends instead still puts the real peer last.
 * Anything a client prepends is ignored either way. A request straight from a
 * public peer is keyed on that peer, whatever headers it carries.
 *
 * Without a socket (tests) every request shares the 'unknown' key, which
 * fails toward over-limiting rather than toward no limit.
 */
export function clientAddress(c: Context): string {
  const peer = socketPeer(c);
  if (peer && isTrustedProxyPeer(peer)) {
    const forwarded = c.req.header('x-forwarded-for');
    const last = forwarded ? unmapIPv4(forwarded.split(',').pop()!.trim()) : '';
    return isIP(last) ? last : peer;
  }
  return peer ?? 'unknown';
}

/**
 * Fixed-window limiter keyed on client address + path. Mount it per method
 * (`oauth.post(path, limiter, handler)`) when only one method should spend
 * the budget, e.g. so rendering the GET /authorize form costs nothing.
 */
export function createRateLimiter(maxRequests: number, windowMs = 60 * 1000) {
  const windows = new Map<string, RateLimitEntry>();
  stores.add(windows);

  return async (c: Context, next: Next) => {
    const key = `${clientAddress(c)}:${c.req.path}`;
    const now = Date.now();

    let entry = windows.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
    }

    entry.count++;

    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
      return c.json(
        { error: 'Too many requests', retryAfter: Math.ceil((entry.resetAt - now) / 1000) },
        429
      );
    }

    await next();
  };
}

/**
 * A counter shared by every source: for the one account's failed logins,
 * where a per-address limit alone is beaten by rotating addresses (an IPv6
 * /64 is 2^64 of them). `blocked()` is the pre-check, `record()` the
 * increment on the failure branch only.
 */
export function createFailureCounter(maxFailures: number, windowMs: number) {
  let count = 0;
  let resetAt = 0;
  const roll = (now: number) => {
    if (now > resetAt) {
      count = 0;
      resetAt = now + windowMs;
    }
  };
  return {
    blocked(): number | null {
      const now = Date.now();
      roll(now);
      return count >= maxFailures ? Math.ceil((resetAt - now) / 1000) : null;
    },
    record(): void {
      roll(Date.now());
      count++;
    },
  };
}

// Cleanup old entries every 5 minutes. unref() so the timer never keeps the
// process alive on its own (it was hanging node:test workers that import app).
setInterval(() => {
  const now = Date.now();
  for (const windows of stores) {
    for (const [key, entry] of windows) {
      if (now > entry.resetAt) {
        windows.delete(key);
      }
    }
  }
}, 5 * 60 * 1000).unref();
