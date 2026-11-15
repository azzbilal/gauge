import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';
import {
  AUTH_RATE_LIMIT,
  AuthRateLimitGuard,
  FixedWindowLimiter,
  trustProxySetting,
} from './rate-limit.guard';

describe('FixedWindowLimiter', () => {
  it('allows `limit` hits per window, then reports the wait, then resets', () => {
    let now = 1_000;
    const limiter = new FixedWindowLimiter(3, 60_000, () => now);
    expect([1, 2, 3].map(() => limiter.hit('a').allowed)).toEqual([true, true, true]);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSec: 60 });
    expect(limiter.hit('b').allowed).toBe(true); // keys are independent
    now += 59_500;
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSec: 1 });
    now += 500;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('sweeps expired windows so the map does not grow without bound', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 1_000, () => now);
    for (let i = 0; i < 100; i++) limiter.hit(`ip${i}`);
    expect(limiter.size).toBe(100);
    now += 1_000;
    limiter.hit('fresh');
    expect(limiter.size).toBe(1);
  });
});

function context(req: Record<string, unknown>, headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ setHeader: (k: string, v: string) => (headers[k] = v) }),
    }),
  } as unknown as ExecutionContext;
}

describe('AuthRateLimitGuard', () => {
  const login = (ip: string) => ({ ip, method: 'POST', route: { path: '/auth/login' } });

  it('answers 429 with Retry-After once an IP is over the limit on a route', () => {
    const guard = new AuthRateLimitGuard();
    const headers: Record<string, string> = {};
    for (let i = 0; i < AUTH_RATE_LIMIT; i++) {
      expect(guard.canActivate(context(login('1.2.3.4'), headers))).toBe(true);
    }
    const err = (() => {
      try {
        guard.canActivate(context(login('1.2.3.4'), headers));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);

    // Another IP, and the same IP on register, have their own counts.
    expect(guard.canActivate(context(login('5.6.7.8'), {}))).toBe(true);
    const register = { ip: '1.2.3.4', method: 'POST', route: { path: '/auth/register' } };
    expect(guard.canActivate(context(register, {}))).toBe(true);
  });

  it('is on POST /auth/login and POST /auth/register, and not on GET /auth/me', () => {
    const guardsOf = (name: keyof AuthController) =>
      Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype[name]) ?? [];
    expect(guardsOf('login')).toContain(AuthRateLimitGuard);
    expect(guardsOf('register')).toContain(AuthRateLimitGuard);
    expect(guardsOf('me')).not.toContain(AuthRateLimitGuard);
  });
});

describe('trustProxySetting', () => {
  it('is off when unset or blank, a hop count for digits, else passed through', () => {
    expect(trustProxySetting(undefined)).toBeUndefined();
    expect(trustProxySetting('  ')).toBeUndefined();
    expect(trustProxySetting(' 1 ')).toBe(1);
    expect(trustProxySetting('loopback')).toBe('loopback');
  });
});

describe('AuthRateLimitGuard in a running Nest app', () => {
  it('lets 10 logins through per client IP, then answers 429 with Retry-After', async () => {
    const { Module } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { AuthService } = await import('./auth.service');
    // vitest's esbuild transform emits no decorator metadata, so tell Nest what the
    // controller's constructor takes (tsc emits this in the real build).
    Reflect.defineMetadata('design:paramtypes', [AuthService], AuthController);

    @Module({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: { login: async () => ({ ok: true }) } }],
    })
    class TestModule {}

    const app = await NestFactory.create<import('@nestjs/platform-express').NestExpressApplication>(
      TestModule,
      { logger: false },
    );
    app.set('trust proxy', trustProxySetting('1'));
    await app.listen(0, '127.0.0.1');
    try {
      const url = `${await app.getUrl()}/auth/login`.replace('[::1]', '127.0.0.1');
      const login = (ip: string) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
          body: JSON.stringify({ email: 'a@b.c', password: 'x' }),
        });
      const statuses: number[] = [];
      for (let i = 0; i < AUTH_RATE_LIMIT; i++) statuses.push((await login('9.9.9.9')).status);
      expect(statuses).toEqual(Array(AUTH_RATE_LIMIT).fill(200));

      const limited = await login('9.9.9.9');
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await limited.json()).message).toContain('Too many attempts');

      // With trust proxy on, the forwarded client address is the key: another client is fine.
      expect((await login('8.8.8.8')).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
