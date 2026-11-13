import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { api, AuthUser, can, Task } from '../api';
import { notify } from '../toast';
import { navigate } from '../useHashRoute';
import { EmptyState } from '../components/EmptyState';
import { PrimaryButton } from '../components/PrimaryButton';
import { staggerAt } from '../stagger';

const CRITERIA = ['verifiable', 'unambiguous', 'correct_reference', 'complete_constraints', 'difficulty'] as const;
type Criterion = (typeof CRITERIA)[number];
// A criterion is absent until the reviewer scores it: nothing is pre-filled, so a skipped
// criterion cannot reach the agreement statistic as a score nobody gave.
type Scores = Partial<Record<Criterion, number>>;
type Evidence = Partial<Record<Criterion, string>>;

const STOPS = [0, 1, 2, 3, 4, 5];
const MAX = 5;
const REVIEWS_REQUIRED = 2;

// Mirrors the backend acceptance rule (docs/pipeline.md §2):
// every criterion >= 3 and verifiable >= 4.
const threshold = (c: Criterion) => (c === 'verifiable' ? 4 : 3);
const label = (c: Criterion) => c.replace(/_/g, ' ');
const failing = (scores: Scores) =>
  CRITERIA.filter((c) => scores[c] !== undefined && (scores[c] as number) < threshold(c));
const unscored = (scores: Scores) => CRITERIA.filter((c) => scores[c] === undefined);
const unevidenced = (evidence: Evidence) => CRITERIA.filter((c) => !evidence[c]?.trim());

/** Position along the slider track, 0..1, consumed by the CSS as --p. */
const at = (value: number) => ({ '--p': value / MAX }) as CSSProperties;

type Mode = 'read' | 'decided' | 'review' | 'adjudicate';

/** What the signed-in user may do with this task; the API enforces the same roles. */
function modeOf(task: Task, user: AuthUser): Mode {
  if (task.reviewState === 'decided') return 'decided';
  // The API decides: a conflicted lead or admin may adjudicate only when nobody independent can.
  if (task.reviewState === 'awaiting_adjudication') return task.canAdjudicate ? 'adjudicate' : 'read';
  return can(user, 'REVIEWER') ? 'review' : 'read';
}

/**
 * Reviewers, adjudicators and admins get a work queue; an author sees every task, read-only.
 * An author who is the lead keeps the full list and adjudicates from it (task.canAdjudicate).
 */
const hasQueue = (user: AuthUser) => can(user, 'REVIEWER') || can(user, 'ADJUDICATOR');

function isTyping(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range';
}

export function ReviewView({ user, taskId }: { user: AuthUser; taskId?: string }) {
  const queued = hasQueue(user);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [scores, setScores] = useState<Scores>({});
  const [evidence, setEvidence] = useState<Evidence>({});
  const [crit, setCrit] = useState(0);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const sliders = useRef<(HTMLInputElement | null)[]>([]);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  // The slider a pointer went down on, so a release only scores the slider it was pressed on.
  const pressed = useRef<Criterion | null>(null);

  const load = useCallback(() => {
    // The queue is the signed-in user's: the API reads who from the token.
    const url = queued ? '/api/tasks?queue=1' : '/api/tasks';
    api
      .get<Task[]>(url)
      .then(setTasks)
      .catch((e) => setError(String(e.message)))
      .finally(() => setLoaded(true));
  }, [queued]);

  useEffect(load, [load]);

  // The address is the selection: '/review/:id'. One task is always open.
  const selected = tasks.find((t) => t.id === taskId) ?? tasks[0];
  const selectedId = selected?.id;
  const mode: Mode = selected ? modeOf(selected, user) : 'read';
  const editable = mode === 'review' || mode === 'adjudicate';
  const failed = failing(scores);
  const missingScores = unscored(scores);
  // The adjudication endpoint takes a verdict and a reason; evidence belongs to peer reviews.
  const missingEvidence = mode === 'review' ? unevidenced(evidence) : [];
  const scored = missingScores.length === 0;
  const accepted = scored && failed.length === 0;
  const canSubmit =
    editable &&
    !busy &&
    scored &&
    missingEvidence.length === 0 &&
    (mode === 'review' || reason.trim().length > 0);

  useEffect(() => {
    setScores({});
    setEvidence({});
    setCrit(0);
    setReason('');
    setError('');
    pressed.current = null;
    if (selectedId) rows.current.get(selectedId)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const select = (id: string) => navigate(`/review/${id}`);

  function step(delta: number) {
    if (!selected) return;
    // Read the address, not the last render: held J/K outruns hashchange.
    const hashId = window.location.hash.split('/')[2];
    const from = tasks.findIndex((t) => t.id === hashId);
    const next = tasks[(from >= 0 ? from : tasks.findIndex((t) => t.id === selected.id)) + delta];
    if (next) select(next.id);
  }

  function focusCriterion(i: number) {
    const next = Math.max(0, Math.min(CRITERIA.length - 1, i));
    setCrit(next);
    sliders.current[next]?.focus();
  }

  const setScore = (c: Criterion, value: number) => setScores((s) => ({ ...s, [c]: value }));
  const setNote = (c: Criterion, text: string) => setEvidence((e) => ({ ...e, [c]: text }));

  async function submit() {
    if (!selected || !canSubmit) return;
    const i = tasks.findIndex((t) => t.id === selected.id);
    const next = tasks[i + 1] ?? tasks[i - 1];
    setBusy(true);
    setError('');
    try {
      if (mode === 'adjudicate') {
        await api.post(`/api/tasks/${selected.id}/adjudication`, {
          verdict: accepted ? 'accept' : 'reject',
          reason: reason.trim(),
        });
        notify('Adjudication saved');
      } else {
        const notes = Object.fromEntries(CRITERIA.map((c) => [c, evidence[c]?.trim() ?? '']));
        await api.post(`/api/tasks/${selected.id}/reviews`, { scores, evidence: notes });
        notify('Review saved');
      }
      navigate(next ? `/review/${next.id}` : '/review');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // One listener; the ref keeps it reading current state.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e) => {
    if (e.altKey) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      // A held chord must not walk down the queue submitting one review after another.
      if (!e.repeat) void submit();
      return;
    }
    if (e.ctrlKey || e.metaKey || isTyping(e.target as HTMLElement | null)) return;

    const key = e.key.toLowerCase();
    if (key === 'j' || key === 'k') {
      e.preventDefault();
      step(key === 'j' ? 1 : -1);
      return;
    }
    if (!editable) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); // a focused range would otherwise change its value
      focusCriterion(crit + (e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (/^[0-5]$/.test(e.key)) {
      e.preventDefault();
      setScore(CRITERIA[crit], Number(e.key));
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Forget the press on every release, wherever it lands. A press released off its slider
  // fires no onPointerUp there, and a remembered press would let a later drag that starts
  // elsewhere score that slider. Bubble-phase window listeners run after React's root-level
  // handlers, so the slider's own onPointerUp still sees the press first. Every new press
  // also starts clean (capture phase, before the slider's onPointerDown records it), in case
  // a release never reached the window.
  useEffect(() => {
    const release = () => {
      pressed.current = null;
    };
    window.addEventListener('pointerdown', release, true);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerdown', release, true);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);

  if (!selected) {
    return (
      <section>
        <h2>Review queue</h2>
        {error && <p className="error">{error}</p>}
        {loaded && (
          <EmptyState
            title={queued ? 'Nothing to review' : 'No tasks yet'}
            body={queued ? 'There is nothing waiting for you right now.' : 'Tasks authors submit will show up here for review.'}
          />
        )}
      </section>
    );
  }

  // Reviewer scores are only present once the API releases them.
  const [first, second] = selected.taskReviews;
  const peers = mode === 'adjudicate' && first?.scores && second?.scores ? [first.scores, second.scores] : null;

  return (
    <section className="rv">
      <aside className="rv-queue" aria-label="Review queue">
        <header className="rv-queue-head">
          <h2>Review queue</h2>
          <span className="num">{tasks.length}</span>
        </header>
        <ul className="rv-rows stagger">
          {tasks.map((t, i) => {
            const split = t.reviewState === 'awaiting_adjudication';
            const done = Math.min(t.taskReviews.length, REVIEWS_REQUIRED);
            return (
              <li key={t.id} style={staggerAt(i)}>
                <button
                  ref={(el) => {
                    if (el) rows.current.set(t.id, el);
                    else rows.current.delete(t.id);
                  }}
                  className="rv-row"
                  aria-current={t.id === selected.id ? 'true' : undefined}
                  onClick={() => select(t.id)}
                >
                  <span className="rv-row-prompt">{t.prompt}</span>
                  <span className="rv-row-meta">
                    <span className="rv-row-who">
                      {t.author ? `${t.author.name} · ` : ''}
                      {t.campaign.name}
                    </span>
                    <span className="rv-dots" role="img" aria-label={`${done} of ${REVIEWS_REQUIRED} reviews`}>
                      {Array.from({ length: REVIEWS_REQUIRED }, (_, i) => (
                        <i key={i} className={i < done ? 'done' : undefined} />
                      ))}
                    </span>
                    <span className={`rv-status${split ? ' split' : ''}`}>
                      {split ? 'split' : t.status.toLowerCase().replace(/_/g, ' ')}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <article className="rv-task" key={selected.id}>
        <p className="rv-prompt">{selected.prompt}</p>

        <div className="rv-sources">
          <div>
            <h3>Spec</h3>
            {selected.spec ? <pre>{selected.spec}</pre> : <p className="muted">No spec</p>}
          </div>
          <div>
            <h3>Reference</h3>
            {selected.reference ? <pre>{selected.reference}</pre> : <p className="muted">No reference</p>}
          </div>
        </div>

        {mode === 'read' && <p className="muted rv-note">Choose who you are (top right) to review.</p>}

        {mode === 'decided' && (
          <p className="muted rv-note">
            Decided: {selected.status.toLowerCase()}
            {selected.adjudication?.reason ? ` by adjudication — ${selected.adjudication.reason}` : ''}
          </p>
        )}

        {editable && (
          <div className="rv-form">
            {mode === 'adjudicate' && <p className="muted">The two reviewers disagreed. Your decision is final.</p>}

            <div className="rv-rubric">
              {CRITERIA.map((c, i) => {
                const value = scores[c];
                const set = value !== undefined;
                const min = threshold(c);
                const disagree = peers ? peers[0][c] !== peers[1][c] : false;
                const commit = (e: { currentTarget: HTMLInputElement }) =>
                  setScore(c, Number(e.currentTarget.value));
                return (
                  <div key={c} className={`rv-crit${i === crit ? ' focus' : ''}`}>
                    <label htmlFor={`rv-${c}`}>{label(c)}</label>
                    <div className="rv-slider">
                      <input
                        id={`rv-${c}`}
                        ref={(el) => {
                          sliders.current[i] = el;
                        }}
                        type="range"
                        // Unscored, the thumb still has to rest somewhere; it is drawn hollow.
                        className={set ? undefined : 'unset'}
                        min={0}
                        max={MAX}
                        step={1}
                        value={value ?? 0}
                        aria-valuetext={
                          set ? `${value} of ${MAX}, passes at ${min}` : `not scored, passes at ${min}`
                        }
                        onFocus={() => setCrit(i)}
                        onChange={commit}
                        // Pressing the value the thumb already shows fires no change event, so
                        // without the release commit an unscored slider could not take its
                        // resting value. It commits only when the press began on this same
                        // slider: a drag that starts elsewhere and is released here must not
                        // score it. Not onClick: activating the <label> synthesises a click,
                        // which would score the criterion without the reviewer choosing a value.
                        onPointerDown={() => {
                          pressed.current = c;
                        }}
                        onPointerUp={(e) => {
                          if (pressed.current === c) commit(e);
                          pressed.current = null;
                        }}
                      />
                      <div className="rv-ticks" aria-hidden="true">
                        {STOPS.map((s) => (
                          <i key={s} className={s === min ? 'pass' : undefined} style={at(s)} />
                        ))}
                      </div>
                    </div>
                    <output htmlFor={`rv-${c}`} className={set && value >= min ? 'ok' : undefined}>
                      {set ? value : '–'}
                    </output>
                    {mode === 'review' && (
                      <textarea
                        className="rv-evidence"
                        aria-label={`${label(c)} evidence`}
                        placeholder="Evidence: what in the task justifies this score (required)"
                        rows={2}
                        required
                        value={evidence[c] ?? ''}
                        onFocus={() => setCrit(i)}
                        onChange={(e) => setNote(c, e.target.value)}
                      />
                    )}
                    {peers?.map((p, r) => (
                      <div key={r} className={`rv-peer${disagree ? ' disagree' : ''}`}>
                        <span>reviewer {r + 1}</span>
                        <div className="rv-peer-track">
                          <i style={at(p[c] ?? 0)} />
                        </div>
                        <b>{p[c] ?? '–'}</b>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

            {mode === 'adjudicate' && (
              <div className="field">
                <label htmlFor="adjudication-reason">Reason</label>
                <textarea
                  id="adjudication-reason"
                  placeholder="Why (required)"
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            )}

            <p className={`rv-verdict${accepted ? ' accept' : ''}`} aria-live="polite">
              {scored ? (
                <>
                  <b>{accepted ? 'Accept' : 'Reject'}</b>
                  {failed.map((c) => (
                    <span key={c}>
                      {label(c)}{' '}
                      <span className="num">
                        {scores[c]} &lt; {threshold(c)}
                      </span>
                    </span>
                  ))}
                </>
              ) : (
                <>
                  <b>Not scored</b>
                  {missingScores.map((c) => (
                    <span key={c}>{label(c)}</span>
                  ))}
                </>
              )}
            </p>
            {missingEvidence.length > 0 && (
              <p className="rv-missing">Evidence needed: {missingEvidence.map(label).join(', ')}</p>
            )}

            {error && <p className="error">{error}</p>}

            <div className="rv-actions">
              <PrimaryButton
                disabled={!canSubmit}
                onClick={() => void submit()}
                label={
                  mode === 'adjudicate'
                    ? scored
                      ? `${accepted ? 'Accept' : 'Reject'} task`
                      : 'Score every criterion'
                    : 'Submit review'
                }
              />
              <span className="rv-keys">
                <kbd>0</kbd>–<kbd>5</kbd> score · <kbd>↑</kbd>
                <kbd>↓</kbd> criterion · <kbd>J</kbd>
                <kbd>K</kbd> task · <kbd>Ctrl</kbd>
                <kbd>Enter</kbd> submit
              </span>
            </div>
          </div>
        )}

        {!editable && error && <p className="error">{error}</p>}
      </article>
    </section>
  );
}
