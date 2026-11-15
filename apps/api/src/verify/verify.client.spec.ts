import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { DifficultyTier } from '@prisma/client';
import { TaskPacket } from './packet-builder';
import { probeTimeoutMs, VerifyClient } from './verify.client';
import {
  ProbeModelUnreachableError,
  VerifyContractError,
  VerifyUnreachableError,
} from './verify.errors';

// POST /probe against a real local HTTP server standing in for verify/service/main.py.

const packet: TaskPacket = {
  prompt: 'a plate',
  spec: '60 mm wide',
  reference: '',
  requirements: [],
  rubricItems: [],
};

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

let server: Server;
let handler: Handler;
const env = { ...process.env };

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

beforeEach(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.VERIFY_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  process.env = { ...env };
});

const answer = (n: number, over: Record<string, unknown> = {}) => ({
  tier: 't1',
  solve_rate: 0.5,
  solved: 1,
  verifier_errors: 0,
  model: 'm',
  rollouts: Array.from({ length: n }, () => ({ code: '', solved: false, verdicts: [], error: null })),
  ...over,
});

describe('VerifyClient.probe', () => {
  it('posts the packet, model and rollouts to /probe and maps the tier', async () => {
    let seen: { url?: string; body?: unknown } = {};
    handler = (req, body, res) => {
      seen = { url: req.url, body: JSON.parse(body) };
      reply(res, 200, answer(2, { tier: 'broken', solve_rate: 0, model: 'qwen' }));
    };
    const result = await new VerifyClient().probe(packet, 'qwen', 2);
    expect(seen).toEqual({ url: '/probe', body: { packet, model: 'qwen', rollouts: 2 } });
    expect(result).toMatchObject({ tier: DifficultyTier.BROKEN, solve_rate: 0, model: 'qwen' });
    expect(result.rollouts).toHaveLength(2);
  });

  it('accepts the seeded-sampling answer (temperature, seeds, a seed per rollout)', async () => {
    handler = (_req, _body, res) =>
      reply(
        res,
        200,
        answer(3, {
          tier: 't1',
          solve_rate: 2 / 3,
          temperature: 0.7,
          seeds: [1, 2, 3],
          rollouts: [1, 2, 3].map((seed) => ({ code: '', solved: seed !== 2, verdicts: [], error: null, seed })),
        }),
      );
    const result = await new VerifyClient().probe(packet, 'm', 3);
    expect(result).toMatchObject({ tier: DifficultyTier.T1, solve_rate: 2 / 3 });
    expect(result.rollouts).toHaveLength(3);
  });

  it('tells Ollama down (502) apart from a service error (500)', async () => {
    handler = (_req, _body, res) => reply(res, 502, { error: 'ollama request failed: refused' });
    const down = await new VerifyClient().probe(packet, 'm', 1).catch((e) => e);
    expect(down).toBeInstanceOf(ProbeModelUnreachableError);
    expect(down.message).toContain('ollama request failed');

    handler = (_req, _body, res) => reply(res, 500, { error: 'internal server error' });
    const broken = await new VerifyClient().probe(packet, 'm', 1).catch((e) => e);
    expect(broken).toBeInstanceOf(VerifyContractError);
    expect(broken.status).toBe(500);
  });

  it.each([
    ['an unknown tier', answer(1, { tier: 't9' })],
    ['a solve rate out of range', answer(1, { solve_rate: 1.5 })],
    ['a missing solve rate', answer(1, { solve_rate: undefined })],
    ['the wrong number of rollouts', answer(3)],
    ['a body that is not JSON', 'not json'],
  ])('rejects %s as a contract error', async (_what, body) => {
    handler = (_req, _body, res) => reply(res, 200, body);
    await expect(new VerifyClient().probe(packet, 'm', 1)).rejects.toBeInstanceOf(VerifyContractError);
  });

  it('reports a service that is not listening as unreachable', async () => {
    process.env.VERIFY_SERVICE_URL = 'http://127.0.0.1:1';
    await expect(new VerifyClient().probe(packet, 'm', 1)).rejects.toBeInstanceOf(VerifyUnreachableError);
  });

  it('waits past the 5 s of the other calls, and gives up at its own timeout', async () => {
    // Default: per rollout, one Ollama completion plus the verifier, far above 5 s.
    delete process.env.PROBE_TIMEOUT_MS;
    delete process.env.OLLAMA_TIMEOUT_MS;
    expect(probeTimeoutMs(1)).toBeGreaterThan(5000);
    expect(probeTimeoutMs(3)).toBe(3 * probeTimeoutMs(1));
    process.env.OLLAMA_TIMEOUT_MS = '1000';
    expect(probeTimeoutMs(2)).toBe(2 * (1000 + 60_000));

    process.env.PROBE_TIMEOUT_MS = '200';
    handler = () => undefined; // never answers
    const err = await new VerifyClient().probe(packet, 'm', 1).catch((e) => e);
    expect(err).toBeInstanceOf(VerifyUnreachableError);
    expect(err.message).toContain('no answer within');
  });
});

describe('VerifyClient service token', () => {
  const lintAnswer = (res: ServerResponse) => reply(res, 200, { findings: [] });

  it('sends no Authorization header when VERIFY_SERVICE_TOKEN is unset or blank', async () => {
    const seen: (string | undefined)[] = [];
    handler = (req, _body, res) => {
      seen.push(req.headers.authorization);
      lintAnswer(res);
    };
    delete process.env.VERIFY_SERVICE_TOKEN;
    await new VerifyClient().lint(packet);
    process.env.VERIFY_SERVICE_TOKEN = '   ';
    await new VerifyClient().lint(packet);
    expect(seen).toEqual([undefined, undefined]);
  });

  it('sends the bearer token on fetch calls and on the slow /probe path', async () => {
    process.env.VERIFY_SERVICE_TOKEN = ' s3cret ';
    const seen: Record<string, string | undefined> = {};
    handler = (req, _body, res) => {
      seen[req.url ?? ''] = req.headers.authorization;
      if (req.url === '/probe') reply(res, 200, answer(1));
      else lintAnswer(res);
    };
    await new VerifyClient().lint(packet);
    await new VerifyClient().probe(packet, 'm', 1);
    expect(seen).toEqual({ '/lint': 'Bearer s3cret', '/probe': 'Bearer s3cret' });
  });

  it('reports a 401 from the service as a contract error, not unreachable', async () => {
    handler = (_req, _body, res) => reply(res, 401, { error: 'missing or invalid verify service token' });
    const err = await new VerifyClient().lint(packet).catch((e) => e);
    expect(err).toBeInstanceOf(VerifyContractError);
    expect(err.status).toBe(401);
  });
});
