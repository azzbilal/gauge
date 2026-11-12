import { useEffect, useState } from 'react';
import { api, Campaign, Task } from '../api';
import { notify } from '../toast';
import { PrimaryButton } from '../components/PrimaryButton';

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

// Basic client-side lint. A stand-in until the real verifier runs the reference.
function lint(prompt: string, spec: string, reference: string) {
  return [
    { name: 'Prompt present', ok: prompt.trim() !== '' },
    { name: 'Spec present', ok: spec.trim() !== '' },
    { name: 'Reference starts with import or from', ok: /^(import|from)\s/.test(reference.trimStart()) },
  ];
}

export function AuthorView({ identityId }: { identityId: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [draft] = useState(loadDraft);
  const [campaignId, setCampaignId] = useState(draft.campaignId);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [spec, setSpec] = useState(draft.spec);
  const [reference, setReference] = useState(draft.reference);
  // The text the last check ran against; any edit makes the result stale.
  const [checkedText, setCheckedText] = useState<string | null>(null);
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
  const checks = lint(prompt, spec, reference);
  const checked = checkedText === text;

  // The first thing still missing, said in words: the button alone can't explain itself.
  const missing = !identityId
    ? 'Choose who you are, top right'
    : !campaigns.some((c) => c.id === campaignId)
      ? 'Choose a campaign'
      : !prompt.trim()
        ? 'Write a prompt'
        : '';
  const canSubmit = !busy && !missing;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const task = await api.post<Task>('/api/tasks', {
        campaignId,
        authorId: identityId,
        prompt,
        spec,
        reference,
      });
      notify(`Task created (${task.status}).`);
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
              <button type="button" onClick={() => setCheckedText(text)}>
                Run check
              </button>
              <PrimaryButton type="submit" disabled={!canSubmit} label={busy ? 'Submitting…' : 'Submit task'} />
            </div>
          </form>
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

          <div className="au-lint" aria-live="polite">
            <h3>Basic check, verifier coming</h3>
            <ul>
              {checks.map((c) => {
                const state = !checked ? 'idle' : c.ok ? 'pass' : 'fail';
                return (
                  <li key={c.name} data-state={state}>
                    <i aria-hidden="true" />
                    <span className="au-lint-name">{c.name}</span>
                    <span className="au-lint-word">{state === 'idle' ? 'not run' : state}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
    </section>
  );
}
