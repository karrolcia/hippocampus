import type { Context, Next } from 'hono';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const windows = new Map<string, RateLimitEntry>();

const WINDOW_MS = 60 * 1000; // 1 minute

export function createRateLimiter(maxRequests: number) {
  return async (c: Context, next: Next) => {
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();

    let entry = windows.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
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

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now > entry.resetAt) {
      windows.delete(key);
    }
  }
}, 5 * 60 * 1000);
