import { Injectable } from '@nestjs/common';
import type { TaskPacket } from './packet-builder';

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

const DEFAULT_BASE_URL = 'http://localhost:4000';
const VERIFY_TIMEOUT_MS = 5000;

/**
 * HTTP client for the Layer 2 verify service (verify/service/main.py).
 * Uses Node's built-in fetch. Both calls throw when the service is unreachable, slow,
 * or answers with anything but the expected shape; the caller decides what that means.
 * Nothing is contacted at construction, so the API boots without the service.
 */
@Injectable()
export class VerifyClient {
  private get baseUrl(): string {
    return (process.env.VERIFY_SERVICE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /** POST /lint: the lint findings for a packet. */
  async lint(packet: TaskPacket): Promise<LintFindingResult[]> {
    const rows = await this.post('/lint', packet, 'findings');
    return rows.filter(isRecord).flatMap((row) =>
      typeof row.rule === 'string' && typeof row.severity === 'string'
        ? [
            {
              rule: row.rule,
              severity: row.severity,
              detail: typeof row.detail === 'string' ? row.detail : null,
            },
          ]
        : [],
    );
  }

  /** POST /verify: one verdict per machine-checkable rubric item. */
  async verify(packet: TaskPacket): Promise<VerifierVerdict[]> {
    const rows = await this.post('/verify', packet, 'verdicts');
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

  private async post(path: string, packet: TaskPacket, key: string): Promise<unknown[]> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`verify service unreachable at ${url} (${describe(err)})`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`verify service ${path} answered ${res.status} ${body.slice(0, 200)}`.trim());
    }
    const json: unknown = await res.json().catch(() => null);
    const rows = isRecord(json) ? json[key] : undefined;
    if (!Array.isArray(rows)) {
      throw new Error(`verify service ${path} did not return a "${key}" list`);
    }
    return rows;
  }
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
