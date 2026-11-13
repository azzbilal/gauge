const TOKEN_KEY = 'gauge.token';

export type Role = 'AUTHOR' | 'REVIEWER' | 'ADJUDICATOR' | 'ADMIN';

/** The signed-in user, as the API returns it from /auth/login and /auth/me. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** The designated lead: may adjudicate a split nobody independent can, whatever the role. */
  isLead: boolean;
  /** The expert this login acts as: task authors and reviewers are experts. */
  expertId: string;
}

export interface Session {
  accessToken: string;
  user: AuthUser;
}

/** ADMIN may do everything the other roles may. */
export const can = (user: AuthUser, role: Role) => user.role === role || user.role === 'ADMIN';

export const getToken = () => localStorage.getItem(TOKEN_KEY);

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Fired when the API refuses the stored token; the app returns to the login view. */
export const SIGNED_OUT = 'gauge:signed-out';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  // Only a refused token ends the session; a wrong password at login sends none.
  if (res.status === 401 && token) {
    setToken(null);
    window.dispatchEvent(new Event(SIGNED_OUT));
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${msg.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) =>
    request<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
};

export interface Campaign {
  id: string;
  name: string;
  targetCount: number;
  specVersion: string;
  _count?: { tasks: number };
}

export interface TaskReview {
  id: string;
  reviewerId: string;
  // Withheld until both reviews are in (decided, or split and awaiting adjudication), so
  // reviews stay independent. The API then also returns each review's evidence.
  scores?: Record<string, number>;
  accepted?: boolean;
}

export type ReviewState = 'awaiting_reviews' | 'awaiting_adjudication' | 'decided';

export interface Adjudication {
  id: string;
  verdict: 'NEEDS_REVIEW' | 'APPROVE' | 'REJECT';
  adjudicatorId: string | null;
  reason: string | null;
}

export interface Task {
  id: string;
  prompt: string;
  spec: string | null;
  reference: string | null;
  status: string;
  campaign: { id: string; name: string };
  /** Null for reviewers and adjudicators: review is blind to who wrote the task. */
  author: { id: string; name: string } | null;
  taskReviews: TaskReview[];
  reviewState: ReviewState;
  adjudication: Adjudication | null;
  /**
   * Whether the signed-in user may resolve this split now. Decided by the API, which alone
   * knows whether an independent adjudicator exists (the small-team escape).
   */
  canAdjudicate: boolean;
  /** Only on the answer to a create: false when the linter could not be reached. */
  linted?: boolean;
}

/** One packet lint finding from POST /tasks/preview. */
export interface LintFinding {
  rule: string;
  severity: string; // info | warning | critical
  detail: string | null;
}

/** One verifier verdict on the reference solution. */
export interface PreviewVerdict {
  criterion: string;
  requirement: string | null;
  check: string;
  status: string; // pass | fail | not_run
  detail: string;
}

/** One stored verifier verdict, as GET /tasks/:id/verification returns it: ids, not names. */
export interface StoredVerdict {
  rubric_item_id?: string;
  requirement_id?: string | null;
  check?: string;
  status?: string; // pass | fail | not_run
  detail?: string;
  pass?: boolean;
}

/** The Layer 2 results stored when a task was created (GET /tasks/:id/verification). */
export interface TaskVerification {
  taskId: string;
  lintFindings: LintFinding[];
  verifierRuns: Array<{ subjectType: string; passed: boolean; results: unknown }>;
  /** What the stored rows quote by id. Absent from an API older than the Review verifier. */
  requirements?: Array<{ id: string; text: string }>;
  rubricItems?: Array<{ id: string; text: string; requirementId: string | null }>;
}

/** `not_run` means the verify service could not be reached; `note` says why. */
export interface TaskPreview {
  lint: { status: 'ok' | 'not_run'; findings: LintFinding[]; note?: string };
  verify: { status: 'ok' | 'not_run'; verdicts: PreviewVerdict[]; note?: string };
}
