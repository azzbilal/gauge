import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

/** Attempts allowed per client IP, per route, per window. */
export const AUTH_RATE_LIMIT = 10;
export const AUTH_RATE_WINDOW_MS = 60_000;

/**
 * Fixed-window counter in process memory. One API instance is all Gauge runs, so there is no
 * shared store; a restart clears the counts. Expired windows are swept at most once per
 * window, so the map holds at most the keys seen in the last two windows.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private nextSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one attempt for `key`; returns how long to wait when it is over the limit. */
  hit(key: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const now = this.now();
    if (now >= this.nextSweep) {
      for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
      this.nextSweep = now + this.windowMs;
    }
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count <= this.limit) return { allowed: true };
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
  }

  get size(): number {
    return this.windows.size;
  }
}

/**
 * Basic brute-force brake for POST /auth/login and POST /auth/register: AUTH_RATE_LIMIT
 * attempts per client IP per route per minute, then 429 with Retry-After. Every attempt
 * counts, successful or not.
 *
 * The client IP is Express's `req.ip`. Behind a proxy that is the proxy's address unless
 * TRUST_PROXY is set (main.ts), and then every client shares one bucket.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  // A field, not a constructor parameter: Nest would try to inject one. Tests replace it.
  limiter = new FixedWindowLimiter(AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_MS);

  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    const req = http.getRequest<{ ip?: string; method?: string; route?: { path?: string }; path?: string }>();
    const route = `${req.method ?? ''} ${req.route?.path ?? req.path ?? ''}`;
    const result = this.limiter.hit(`${route}|${req.ip ?? 'unknown'}`);
    if (result.allowed) return true;
    http.getResponse<{ setHeader(name: string, value: string): void }>()
      .setHeader('Retry-After', String(result.retryAfterSec));
    throw new HttpException(
      `Too many attempts, try again in ${result.retryAfterSec} s`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * TRUST_PROXY (read in main.ts): how many proxies sit in front of the API, so `req.ip` is the
 * client's address and not the proxy's. A number is a hop count; any other value is passed to
 * Express as is. Unset: off (direct connections, local dev). Too high a count lets a client
 * pick its own IP with a forged X-Forwarded-For; too low makes clients share a bucket.
 */
export function trustProxySetting(raw: string | undefined): number | string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return /^\d+$/.test(value) ? Number(value) : value;
}
