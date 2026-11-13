import { Injectable } from '@nestjs/common';
import { DifficultyTier } from '@prisma/client';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type {
  ExtractedRubricItem,
  Extraction,
  PacketRequirement,
  RequirementExtractor,
  TaskPacket,
} from './packet-builder';
import {
  ProbeModelUnreachableError,
  VerifyContractError,
  VerifyUnreachableError,
} from './verify.errors';

/** One M7 Packet Lint finding; the same fields as the LintFinding model. */
export interface LintFindingResult {
  rule: string;
  severity: string; // info | warning | critical
  detail: string | null;
}

/** One M8 Verifier Pack verdict, as verify/verifiers/verifiers.py returns it. */
export interface VerifierVerdict {
  rubric_item_id: string;
  requirement_id: string | null;
  check: string;
  status: string; // pass | fail | not_run
  pass: boolean;
  detail: string;
}

/** The M9 Probe Gate answer, as verify/probe/probe.py returns it, with the tier as stored. */
export interface ProbeResult {
  tier: DifficultyTier;
  solve_rate: number;
  model: string;
  /** One entry per attempt: {code, solved, verdicts, error}, passed through as given. */
  rollouts: unknown[];
}

const DEFAULT_BASE_URL = 'http://localhost:4000';
const VERIFY_TIMEOUT_MS = 5000;

const PROBE_TIERS: Record<string, DifficultyTier> = {
  t0: DifficultyTier.T0,
  t1: DifficultyTier.T1,
  t2: DifficultyTier.T2,
  broken: DifficultyTier.BROKEN,
};
// Per rollout: one Ollama completion (OLLAMA_TIMEOUT_MS, as the API's own Ollama calls) plus
// time for the verifier to run the generated code. PROBE_TIMEOUT_MS overrides the total.
const OLLAMA_TIMEOUT_MS = 300_000;
const PROBE_VERIFY_MARGIN_MS = 60_000;

export function probeTimeoutMs(rollouts: number): number {
  const total = Number(process.env.PROBE_TIMEOUT_MS);
  if (Number.isFinite(total) && total > 0) return total;
  const perCompletion = Number(process.env.OLLAMA_TIMEOUT_MS);
  const ollama = Number.isFinite(perCompletion) && perCompletion > 0 ? perCompletion : OLLAMA_TIMEOUT_MS;
  return rollouts * (ollama + PROBE_VERIFY_MARGIN_MS);
}

/**
 * HTTP client for the Layer 2 verify service (verify/service/main.py).
 * Uses Node's built-in fetch. Every call throws one of two errors (verify.errors.ts) and
 * the caller decides what each means:
 *   VerifyUnreachableError  no answer: connection refused, or the timeout ran out
 *   VerifyContractError     an answer that cannot be used: an error status, or anything
 *                           but the expected shape
 * Nothing is contacted at construction, so the API boots without the service.
 */
@Injectable()
export class VerifyClient implements RequirementExtractor {
  private get baseUrl(): string {
    return (process.env.VERIFY_SERVICE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * POST /extract: the requirements a prompt and spec state, and the rubric items with
   * their check methods. Strict: one malformed entry rejects the whole answer, because a
   * requirement dropped here would be a requirement nobody checks.
   */
  async extract(source: { prompt: string; spec: string | null }): Promise<Extraction> {
    const path = '/extract';
    const json = await this.post(path, source);
    const malformed = (what: string) =>
      new VerifyContractError(`verify service ${path} returned a malformed answer (${what})`);

    const version = json.version;
    if (typeof version !== 'string' || version === '') throw malformed('no version');
    if (!Array.isArray(json.requirements)) throw malformed('no "requirements" list');
    if (!Array.isArray(json.rubric_items)) throw malformed('no "rubric_items" list');

    // Only the stored fields are kept; these objects are written to the database as is.
    const requirements = json.requirements.map((row: unknown): PacketRequirement => {
      if (!isRecord(row) || !isId(row.id) || typeof row.text !== 'string') {
        throw malformed('a requirement without id or text');
      }
      return {
        id: row.id,
        text: row.text,
        kind: typeof row.kind === 'string' ? row.kind : 'dimension',
        value: typeof row.value === 'string' ? row.value : null,
        tolerance: typeof row.tolerance === 'string' ? row.tolerance : null,
      };
    });

    const rubricItems = json.rubric_items.map((row: unknown): ExtractedRubricItem => {
      if (
        !isRecord(row) ||
        !isId(row.id) ||
        typeof row.criterion !== 'string' ||
        typeof row.text !== 'string'
      ) {
        throw malformed('a rubric item without id, criterion or text');
      }
      const method = row.check_method;
      if (method !== 'machine' && method !== 'manual') {
        throw malformed(`rubric item "${row.criterion}" has check method ${JSON.stringify(method)}`);
      }
      const ids = row.requirement_ids;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
        throw malformed(`rubric item "${row.criterion}" has no "requirement_ids" list`);
      }
      const weight = row.weight;
      if (typeof weight !== 'number' || !Number.isFinite(weight)) {
        throw malformed(`rubric item "${row.criterion}" has no weight`);
      }
      return {
        id: row.id,
        criterion: row.criterion,
        text: row.text,
        checkMethod: method,
        requirementIds: ids as string[],
        weight,
      };
    });

    return { version, requirements, rubricItems };
  }

  /**
   * POST /lint: the lint findings for a packet. Strict like `extract`: a finding that
   * cannot be read rejects the whole answer, because it may be the critical one.
   */
  async lint(packet: TaskPacket): Promise<LintFindingResult[]> {
    const path = '/lint';
    const rows = await this.postForList(path, packet, 'findings');
    return rows.map((row): LintFindingResult => {
      if (!isRecord(row) || typeof row.rule !== 'string' || typeof row.severity !== 'string') {
        throw new VerifyContractError(
          `verify service ${path} returned a malformed answer (a finding without rule or severity)`,
        );
      }
      return {
        rule: row.rule,
        severity: row.severity,
        detail: typeof row.detail === 'string' ? row.detail : null,
      };
    });
  }

  /** POST /verify: one verdict per machine-checkable rubric item. */
  async verify(packet: TaskPacket): Promise<VerifierVerdict[]> {
    const rows = await this.postForList('/verify', packet, 'verdicts');
    return rows.filter(isRecord).flatMap((row) =>
      typeof row.rubric_item_id === 'string'
        ? [
            {
              rubric_item_id: row.rubric_item_id,
              requirement_id: typeof row.requirement_id === 'string' ? row.requirement_id : null,
              check: String(row.check ?? ''),
              status: String(row.status ?? ''),
              // Anything but an explicit true is not a pass.
              pass: row.pass === true,
              detail: String(row.detail ?? ''),
            },
          ]
        : [],
    );
  }

  /**
   * POST /probe: `rollouts` attempts of the local Ollama `model` at the task, scored by the
   * verifier, and the difficulty tier the solve rate gives. Strict like `extract`: a tier is
   * stored and read as a fact about the task, so an answer that is not exactly one is
   * rejected. Throws ProbeModelUnreachableError when the service reports Ollama down (502).
   *
   * A probe takes minutes (one Ollama completion per rollout, then the verifier), so it does
   * not use the 5 s timeout of the other calls, nor fetch: Node's fetch gives up on any
   * answer whose headers take over 300 s, however long its own signal allows.
   */
  async probe(packet: TaskPacket, model: string, rollouts: number): Promise<ProbeResult> {
    const path = '/probe';
    let json: Record<string, unknown>;
    try {
      json = await this.postSlow(path, { packet, model, rollouts }, probeTimeoutMs(rollouts));
    } catch (err) {
      if (err instanceof VerifyContractError && err.status === 502) {
        throw new ProbeModelUnreachableError(`model server unreachable: ${err.message}`);
      }
      throw err;
    }
    const malformed = (what: string) =>
      new VerifyContractError(`verify service ${path} returned a malformed answer (${what})`);

    const tier = typeof json.tier === 'string' ? PROBE_TIERS[json.tier] : undefined;
    if (!tier) throw malformed(`tier ${JSON.stringify(json.tier)}`);
    const rate = json.solve_rate;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw malformed(`solve_rate ${JSON.stringify(rate)}`);
    }
    if (!Array.isArray(json.rollouts) || json.rollouts.length !== rollouts) {
      throw malformed(`expected ${rollouts} rollouts`);
    }
    return {
      tier,
      solve_rate: rate,
      model: typeof json.model === 'string' ? json.model : model,
      rollouts: json.rollouts,
    };
  }

  private async postForList(path: string, packet: TaskPacket, key: string): Promise<unknown[]> {
    const rows = (await this.post(path, packet))[key];
    if (!Array.isArray(rows)) {
      throw new VerifyContractError(`verify service ${path} did not return a "${key}" list`);
    }
    return rows;
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
    } catch (err) {
      throw new VerifyUnreachableError(`verify service unreachable at ${url} (${describe(err)})`);
    }
    if (!res.ok) {
      // The service answered, and refused: the status is the answer, whatever the body.
      const body = await res.text().catch(() => '');
      throw new VerifyContractError(
        `verify service ${path} answered ${res.status} ${body.slice(0, 200)}`.trim(),
        res.status,
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      // A body that is not JSON is a wrong answer. Anything else is the body not arriving:
      // the timeout also covers reading it, and the connection can drop half way.
      if (!(err instanceof SyntaxError)) {
        throw new VerifyUnreachableError(
          `verify service at ${url} did not finish answering (${describe(err)})`,
        );
      }
      json = null;
    }
    if (!isRecord(json)) {
      throw new VerifyContractError(`verify service ${path} did not return a JSON object`);
    }
    return json;
  }

  /**
   * `post` for a call that may take minutes, over node:http, which has no built-in limit on
   * how long the answer may take; `timeoutMs` is the only one. Same errors as `post`.
   */
  private postSlow(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);
    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      let answered = false;
      const req = send(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        },
        (res) => {
          answered = true;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', (err) =>
            reject(
              new VerifyUnreachableError(
                `verify service at ${url} did not finish answering (${describe(err)})`,
              ),
            ),
          );
          res.on('end', () => {
            clearTimeout(timer);
            const status = res.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString('utf-8');
            if (status < 200 || status >= 300) {
              reject(
                new VerifyContractError(
                  `verify service ${path} answered ${status} ${text.slice(0, 200)}`.trim(),
                  status,
                ),
              );
              return;
            }
            let json: unknown = null;
            try {
              json = JSON.parse(text);
            } catch {
              // not JSON: a wrong answer, reported below
            }
            if (!isRecord(json)) {
              reject(new VerifyContractError(`verify service ${path} did not return a JSON object`));
              return;
            }
            resolve(json);
          });
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)),
        timeoutMs,
      );
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new VerifyUnreachableError(
            answered
              ? `verify service at ${url} did not finish answering (${describe(err)})`
              : `verify service unreachable at ${url} (${describe(err)})`,
          ),
        );
      });
      req.end(payload);
    });
  }
}

/** A usable row id. Packet rubric item ids join two ids with ":", so an id has none. */
function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.includes(':');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** fetch reports "fetch failed" and keeps the real reason (ECONNREFUSED, …) in `cause`. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : undefined;
  return code ? `${err.message}: ${code}` : err.message;
}
