import { useEffect, useRef, useState } from 'react';
import { api, AuthUser, Campaign, can, Task, TaskPreview } from '../api';
import { notify } from '../toast';
import { PrimaryButton } from '../components/PrimaryButton';
import { CheckRows, isBuiltInNoise, isCritical, Row, severityRank, words } from '../components/CheckRows';

// The rubric a reviewer will score this task on (docs/pipeline.md §2), shown to the
// author as a read-only self-check. Order and names match the backend CRITERIA.
const CRITERIA = [
  { key: 'verifiable', name: 'Verifiable', ask: 'Can a deterministic checker decide pass/fail?' },
  { key: 'unambiguous', name: 'Unambiguous', ask: 'Would two solvers read the spec the same way?' },
  { key: 'correct_reference', name: 'Correct reference', ask: 'Does the reference actually satisfy the spec?' },
  { key: 'complete_constraints', name: 'Complete constraints', ask: 'Dimensions and tolerances fully specified, no free parameters.' },
  { key: 'difficulty', name: 'Difficulty', ask: 'In scope, not trivial, not impossible.' },
] as const;
const MAX = 5;

// Mirrors the backend acceptance rule (docs/pipeline.md §2):
// every criterion >= 3 and verifiable >= 4.
const threshold = (key: string) => (key === 'verifiable' ? 4 : 3);

// The unsent draft survives a reload: written on every change, read once on mount.
const DRAFT_KEY = 'gauge.author.draft';
type Draft = { prompt: string; spec: string; reference: string; campaignId: string };

function loadDraft(): Draft {
  const empty: Draft = { prompt: '', spec: '', reference: '', campaignId: '' };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return empty;
    const draft = { ...empty };
    for (const k of Object.keys(empty) as (keyof Draft)[]) {
      const v = (saved as Record<string, unknown>)[k];
      if (typeof v === 'string') draft[k] = v;
    }
    return draft;
  } catch {
    return empty;
  }
}

// A check that could not be asked for at all reads the same as one the API could not run.
function notRun(note: string): TaskPreview {
  return {
    lint: { status: 'not_run', findings: [], note },
    verify: { status: 'not_run', verdicts: [], note },
  };
}

function lintRows(preview: TaskPreview | null): Row[] {
  if (!preview) return [{ state: 'idle', name: 'Packet lint', word: 'not run' }];
  const { status, note } = preview.lint;
  if (status !== 'ok') return [{ state: 'idle', name: 'Packet lint', word: 'not run', detail: note }];
  const findings = preview.lint.findings.filter((f) => !isBuiltInNoise(f));
  if (findings.length === 0) return [{ state: 'pass', name: 'No findings', word: 'pass' }];
  return [...findings]
    .sort((a, b) => severityRank(a) - severityRank(b))
    .map((f) => ({
      state: isCritical(f) ? 'fail' : 'idle',
      name: words(f.rule),
      word: f.severity,
      detail: f.detail,
    }));
}

function verdictRows(preview: TaskPreview | null): Row[] {
  if (!preview) return [{ state: 'idle', name: 'Reference', word: 'not run' }];
  const { status, verdicts, note } = preview.verify;
  if (status !== 'ok') return [{ state: 'idle', name: 'Reference', word: 'not run', detail: note }];
  // No verdict is not a pass: nothing was checked.
  if (verdicts.length === 0) {
    return [
      {
        state: 'idle',
        name: 'Reference',
        word: 'not run',
        detail: 'The spec states no named dimension a machine can check.',
      },
    ];
  }
  return verdicts.map((v) => ({
    state: v.status === 'pass' ? 'pass' : v.status === 'fail' ? 'fail' : 'idle',
    name: v.requirement ?? words(v.criterion),
    word: v.status === 'pass' || v.status === 'fail' ? v.status : 'not run',
    detail: [words(v.check), v.detail].filter(Boolean).join(': '),
  }));
}

export function AuthorView({ user }: { user: AuthUser }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [draft] = useState(loadDraft);
  const [campaignId, setCampaignId] = useState(draft.campaignId);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [spec, setSpec] = useState(draft.spec);
  const [reference, setReference] = useState(draft.reference);
  // The last check and the text it ran against; any edit makes the result stale.
  const [result, setResult] = useState<{ text: string; preview: TaskPreview } | null>(null);
  const [checking, setChecking] = useState(false);
  // Only the newest check may report: an older answer is for text that has moved on.
  const latestCheck = useRef(0);
  // The text a submit was refused for; the refusal stands until that text changes.
  const [blockedText, setBlockedText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<Campaign[]>('/api/campaigns')
      .then((list) => {
        setCampaigns(list);
        // a restored campaign that no longer exists must not be submitted
        setCampaignId((id) => (list.some((c) => c.id === id) ? id : ''));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ prompt, spec, reference, campaignId }));
    } catch {
      // storage full or blocked: the draft just won't survive a reload
    }
  }, [prompt, spec, reference, campaignId]);

  const text = JSON.stringify([prompt, spec, reference]);
  const preview = result?.text === text ? result.preview : null;
  const blocked = blockedText === text ? preview : null;
  const blocking = blocked?.lint.findings.filter(isCritical) ?? [];
  // A lint that did not run is not a clean lint: the submit was stopped for that alone.
  const unlinted = blocked && blocked.lint.status !== 'ok' ? blocked.lint : null;

  // The first thing still missing, said in words: the button alone can't explain itself.
  const missing = !can(user, 'AUTHOR')
    ? `Only authors can submit tasks; you are signed in as a ${user.role.toLowerCase()}`
    : !campaigns.some((c) => c.id === campaignId)
      ? 'Choose a campaign'
      : !prompt.trim()
        ? 'Write a prompt'
        : '';
  const canSubmit = !busy && !missing;

  /** Lint and verify the draft as it stands. Never throws: a failed request is `not_run`. */
  async function runCheck(): Promise<TaskPreview> {
    const id = ++latestCheck.current;
    setChecking(true);
    let answer: TaskPreview;
    try {
      answer = await api.post<TaskPreview>('/api/tasks/preview', { prompt, spec, reference });
    } catch (err) {
      answer = notRun(`The check could not be requested (${(err as Error).message})`);
    }
    if (id === latestCheck.current) {
      setResult({ text, preview: answer });
      setChecking(false);
    }
    return answer;
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      // The gate is the lint of exactly this text: reuse a finished check of it, otherwise
      // run one now. It fails closed: a lint that could not run stops the submit, and so
      // does a critical finding. The server lints again before it stores anything.
      const checked = preview?.lint.status === 'ok' ? preview : await runCheck();
      if (checked.lint.status !== 'ok' || checked.lint.findings.some(isCritical)) {
        setBlockedText(text);
        return;
      }
      const task = await api.post<Task>('/api/tasks', {
        // The author is whoever is signed in; the API reads it from the token.
        campaignId,
        prompt,
        spec,
        reference,
      });
      // The linter can go away between the check above and the create; the server says so.
      notify(`Task created (${task.status})${task.linted === false ? ', not linted' : ''}.`);
      setPrompt('');
      setSpec('');
      setReference('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void submit();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <section className="au">
      <h2>Author a task</h2>
      <div className="au-layout">
        <div className="au-main">
          <form className="au-composer" onSubmit={onSubmit} onKeyDown={onKeyDown}>
            <div className="au-field au-prompt">
              <label htmlFor="task-prompt">Prompt</label>
              <textarea
                id="task-prompt"
                placeholder="The instruction a solver reads"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            <div className="au-sources">
              <div className="au-field">
                <label htmlFor="task-spec">Spec</label>
                <textarea
                  id="task-spec"
                  spellCheck={false}
                  placeholder="Precise requirements: shape, dimensions, constraints"
                  value={spec}
                  onChange={(e) => setSpec(e.target.value)}
                />
              </div>
              <div className="au-field">
                <label htmlFor="task-reference">Reference (CadQuery)</label>
                <textarea
                  id="task-reference"
                  spellCheck={false}
                  placeholder="A working CadQuery solution"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </div>
            </div>

            <div className="au-tools">
              <select
                id="task-campaign"
                aria-label="Campaign"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
              >
                <option value="">Campaign…</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span className="au-hint" aria-live="polite">
                {missing || (
                  <>
                    <kbd>Ctrl</kbd>
                    <kbd>Enter</kbd>
                  </>
                )}
              </span>
              <button type="button" disabled={checking || !can(user, 'AUTHOR')} onClick={() => void runCheck()}>
                {checking ? 'Checking…' : 'Run check'}
              </button>
              <PrimaryButton type="submit" disabled={!canSubmit} label={busy ? 'Submitting…' : 'Submit task'} />
            </div>
          </form>
          {blocking.length > 0 && (
            <div className="error au-blocked" role="alert">
              <p>
                Not submitted:{' '}
                {blocking.length === 1 ? 'a critical lint finding' : `${blocking.length} critical lint findings`}.
                Fix the draft and submit again.
              </p>
              <ul>
                {blocking.map((f, i) => (
                  <li key={i}>
                    <span className="au-blocked-rule">{words(f.rule)}</span>
                    {f.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {unlinted && (
            <div className="error au-blocked" role="alert">
              <p>
                Not submitted: the lint could not run, so the draft was not checked. Nothing was
                created. Start the verify service and submit again.
              </p>
              {unlinted.note && <p>{unlinted.note}</p>}
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        <aside className="au-check" aria-labelledby="au-check-title">
          <div className="au-check-head">
            <h3 id="au-check-title">Self-check</h3>
            <span>pass at</span>
          </div>
          <ol>
            {CRITERIA.map((c) => (
              <li key={c.key}>
                <span className="au-check-name">{c.name}</span>
                <span className="au-check-min" aria-label={`passes at ${threshold(c.key)} of ${MAX}`}>
                  ≥ {threshold(c.key)}
                </span>
                <p>{c.ask}</p>
              </li>
            ))}
          </ol>
          <p className="au-check-foot">
            Two reviewers score each criterion <span className="num">0–{MAX}</span>. Every row must pass.
          </p>

          <div className="au-lint" aria-live="polite" aria-busy={checking}>
            <CheckRows title="Lint" rows={lintRows(preview)} />
            <CheckRows title="Verifier" rows={verdictRows(preview)} />
          </div>
        </aside>
      </div>
    </section>
  );
}
