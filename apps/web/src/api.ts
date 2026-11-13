const TOKEN_KEY = 'gauge.token';

export type Role = 'AUTHOR' | 'REVIEWER' | 'ADJUDICATOR' | 'ADMIN';

/** The signed-in user, as the API returns it from /auth/login and /auth/me. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
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
  // Withheld until the task is decided, so reviews stay independent.
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
  author: { id: string; name: string };
  taskReviews: TaskReview[];
  reviewState: ReviewState;
  adjudication: Adjudication | null;
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

/** `not_run` means the verify service could not be reached; `note` says why. */
export interface TaskPreview {
  lint: { status: 'ok' | 'not_run'; findings: LintFinding[]; note?: string };
  verify: { status: 'ok' | 'not_run'; verdicts: PreviewVerdict[]; note?: string };
}
