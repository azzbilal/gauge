import { useCallback, useEffect, useState } from 'react';
import { api, Task } from '../api';
import { notify } from '../toast';
import { EmptyState } from '../components/EmptyState';

const CRITERIA = ['verifiable', 'unambiguous', 'correct_reference', 'complete_constraints', 'difficulty'] as const;

// Mirrors the backend acceptance rule (docs/pipeline.md §2):
// every criterion >= 3 and verifiable >= 4.
function isAccepted(scores: Record<string, number>): boolean {
  return CRITERIA.every((c) => (scores[c] ?? 3) >= 3) && (scores['verifiable'] ?? 3) >= 4;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function ReviewView({ identityId, taskId }: { identityId: string; taskId?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [openId, setOpenId] = useState<string | null>(taskId ?? null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reviewerId = identityId;

  const load = useCallback(() => {
    const url = reviewerId ? `/api/tasks?reviewerId=${encodeURIComponent(reviewerId)}` : '/api/tasks';
    api.get<Task[]>(url).then(setTasks).catch((e) => setError(String(e.message)));
  }, [reviewerId]);

  useEffect(load, [load]);

  function open(task: Task) {
    setOpenId(openId === task.id ? null : task.id);
    setScores(Object.fromEntries(CRITERIA.map((c) => [c, 3])));
    setReason('');
    setError('');
  }

  async function send(url: string, body: unknown, okMsg: string) {
    setBusy(true);
    setError('');
    try {
      await api.post(url, body);
      setOpenId(null);
      load();
      notify(okMsg);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const submitReview = (id: string) => send(`/api/tasks/${id}/reviews`, { reviewerId, scores }, 'Review saved');

  const adjudicate = (id: string, verdict: 'accept' | 'reject') =>
    send(`/api/tasks/${id}/adjudication`, { adjudicatorId: reviewerId, verdict, reason }, 'Adjudication saved');

  return (
    <section>
      <h2>Review queue</h2>
      {error && <p className="error">{error}</p>}
      {tasks.length === 0 ? (
        <EmptyState
          title={reviewerId ? 'Nothing to review' : 'No tasks yet'}
          body={reviewerId ? 'There is nothing waiting for you right now.' : 'Tasks authors submit will show up here for review.'}
        />
      ) : (
        <ul className="list">
          {tasks.map((t) => (
            <li key={t.id} className="task">
              <button className="task-head" onClick={() => open(t)}>
                <span className="strong">{truncate(t.prompt, 70)}</span>
                <span className={`badge badge-${t.status.toLowerCase()}${t.reviewState === 'awaiting_adjudication' ? ' badge-split' : ''}`}>
                  {t.reviewState === 'awaiting_adjudication' ? 'needs adjudication' : t.status}
                </span>
              </button>
              <span className="muted">
                {t.author.name} · {t.campaign.name} · {t.taskReviews.length} of 2 reviews
              </span>
              {openId === t.id && !reviewerId && (
                <p className="muted">Choose who you are (top right) to review.</p>
              )}
              {openId === t.id && reviewerId && t.reviewState === 'awaiting_adjudication' && (
                <div className="review-form">
                  <p className="muted">The two reviewers disagreed. Your decision is final.</p>
                  <div className="field">
                    <label htmlFor="adjudication-reason">Reason</label>
                    <textarea id="adjudication-reason" placeholder="Why (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
                  </div>
                  <div className="row">
                    <button disabled={busy || !reason.trim()} onClick={() => adjudicate(t.id, 'accept')}>
                      Accept task
                    </button>
                    <button disabled={busy || !reason.trim()} onClick={() => adjudicate(t.id, 'reject')}>
                      Reject task
                    </button>
                  </div>
                </div>
              )}
              {openId === t.id && reviewerId && t.reviewState === 'decided' && (
                <p className="muted">
                  Decided: {t.status.toLowerCase()}
                  {t.adjudication?.reason ? ` by adjudication — ${t.adjudication.reason}` : ''}
                </p>
              )}
              {openId === t.id && reviewerId && t.reviewState === 'awaiting_reviews' && (
                <div className="review-form">
                  {CRITERIA.map((c) => (
                    <label key={c} className="criterion">
                      <span>{c.replace(/_/g, ' ')}</span>
                      <input
                        type="range"
                        min={0}
                        max={5}
                        value={scores[c] ?? 3}
                        onChange={(e) => setScores((s) => ({ ...s, [c]: Number(e.target.value) }))}
                      />
                      <b>{scores[c] ?? 3}</b>
                    </label>
                  ))}
                  <div className="row">
                    <span className="muted">
                      {isAccepted(scores) ? 'Verdict: accept' : 'Verdict: reject — verifiable ≥ 4, all ≥ 3'}
                    </span>
                    <button disabled={busy} onClick={() => submitReview(t.id)}>
                      Submit review
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
