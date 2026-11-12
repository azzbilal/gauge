import { useCallback, useEffect, useState } from 'react';
import { api, Campaign, Expert, Task } from './api';

const CRITERIA = ['verifiable', 'unambiguous', 'correct_reference', 'complete_constraints', 'difficulty'] as const;

// Mirrors the backend acceptance rule (docs/pipeline.md §2):
// every criterion >= 3 and verifiable >= 4.
function isAccepted(scores: Record<string, number>): boolean {
  return CRITERIA.every((c) => (scores[c] ?? 3) >= 3) && (scores['verifiable'] ?? 3) >= 4;
}

type ToastMsg = { id: number; text: string; kind: 'ok' | 'error' };
let toastListeners: Array<(t: ToastMsg) => void> = [];
function notify(text: string, kind: 'ok' | 'error' = 'ok') {
  toastListeners.forEach((l) => l({ id: Date.now() + Math.random(), text, kind }));
}

type Tab = 'campaigns' | 'author' | 'review';

const LABELS: Record<Tab, string> = {
  campaigns: 'Campaigns',
  author: 'Author Task',
  review: 'Review',
};

export default function App() {
  const [tab, setTab] = useState<Tab>('campaigns');
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Gauge</span>
        <nav>
          {(Object.keys(LABELS) as Tab[]).map((t) => (
            <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {LABELS[t]}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        {tab === 'campaigns' && <CampaignsView />}
        {tab === 'author' && <AuthorView />}
        {tab === 'review' && <ReviewView />}
      </main>
      <Toasts />
    </div>
  );
}

function CampaignsView() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<Campaign[]>('/api/campaigns').then(setCampaigns).catch((e) => setError(String(e.message)));
  }, []);

  useEffect(load, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/campaigns', { name, targetCount: Number(target) || 0 });
      setName('');
      setTarget('');
      load();
      notify('Campaign created');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Campaigns</h2>
      <form className="row" onSubmit={create}>
        <div className="field">
          <label htmlFor="campaign-name">Campaign name</label>
          <input id="campaign-name" placeholder="e.g. Bracket series" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field" style={{ flex: '0 0 130px' }}>
          <label htmlFor="campaign-target">Target tasks</label>
          <input id="campaign-target" type="number" placeholder="10" value={target} onChange={(e) => setTarget(e.target.value)} />
        </div>
        <button disabled={busy || !name.trim()}>Create</button>
      </form>
      {error && <p className="error">{error}</p>}
      {campaigns.length === 0 ? (
        <EmptyState title="No campaigns yet" body="Create one to open a task campaign." />
      ) : (
        <ul className="list">
          {campaigns.map((c) => (
            <li key={c.id}>
              <span className="strong">{c.name}</span>
              <span className="muted">
                {c._count?.tasks ?? 0} tasks · spec {c.specVersion}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AuthorView() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [experts, setExperts] = useState<Expert[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [expertId, setExpertId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [spec, setSpec] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Campaign[]>('/api/campaigns').then(setCampaigns).catch(() => undefined);
    api.get<Expert[]>('/api/experts').then(setExperts).catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const task = await api.post<Task>('/api/tasks', {
        campaignId,
        authorId: expertId,
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

  return (
    <section>
      <h2>Author a task</h2>
      <form className="stack" onSubmit={submit}>
        <div className="row">
          <div className="field">
            <label htmlFor="task-campaign">Campaign</label>
            <select id="task-campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">Choose…</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="task-author">Author</label>
            <select id="task-author" value={expertId} onChange={(e) => setExpertId(e.target.value)}>
              <option value="">Choose…</option>
              {experts.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="task-prompt">Prompt</label>
          <textarea id="task-prompt" placeholder="The instruction a solver reads" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="task-spec">Spec</label>
          <textarea id="task-spec" placeholder="Precise requirements: shape, dimensions, constraints" value={spec} onChange={(e) => setSpec(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="task-reference">Reference (CadQuery)</label>
          <textarea id="task-reference" className="mono" placeholder="A working CadQuery solution" value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <button disabled={busy || !campaignId || !expertId || !prompt.trim()}>Submit task</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function ReviewView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [experts, setExperts] = useState<Expert[]>([]);
  const [reviewerId, setReviewerId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // With a reviewer chosen the API returns that reviewer's own queue: only the
  // tasks they may review or adjudicate. Without one it is the read-only overview.
  const load = useCallback(() => {
    const url = reviewerId ? `/api/tasks?reviewerId=${encodeURIComponent(reviewerId)}` : '/api/tasks';
    api.get<Task[]>(url).then(setTasks).catch((e) => setError(String(e.message)));
  }, [reviewerId]);

  useEffect(load, [load]);
  useEffect(() => {
    api.get<Expert[]>('/api/experts').then(setExperts).catch(() => undefined);
  }, []);

  function open(task: Task) {
    setOpenId(openId === task.id ? null : task.id);
    setScores(Object.fromEntries(CRITERIA.map((c) => [c, 3])));
    setReason('');
    setError('');
  }

  async function send(url: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      await api.post(url, body);
      setOpenId(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const submitReview = (taskId: string) =>
    send(`/api/tasks/${taskId}/reviews`, { reviewerId, scores });

  const adjudicate = (taskId: string, verdict: 'accept' | 'reject') =>
    send(`/api/tasks/${taskId}/adjudication`, { adjudicatorId: reviewerId, verdict, reason });

  return (
    <section>
      <h2>Review queue</h2>
      <div className="row">
        <select value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
          <option value="">Reviewing as…</option>
          {experts.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <span className="muted">
          {reviewerId
            ? 'Your queue — two reviewers per task; a split goes to a third.'
            : 'All tasks. Choose who you are to review.'}
        </span>
      </div>
      {error && <p className="error">{error}</p>}
      {tasks.length === 0 ? (
        <EmptyState
          title={reviewerId ? 'Nothing to review' : 'No tasks yet'}
          body={
            reviewerId
              ? 'There is nothing waiting for you right now.'
              : 'Tasks authors submit will show up here for review.'
          }
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
                <p className="muted">Choose who you are reviewing as, above.</p>
              )}
              {openId === t.id && reviewerId && t.reviewState === 'awaiting_adjudication' && (
                <div className="review-form">
                  <p className="muted">The two reviewers disagreed. Your decision is final.</p>
                  <textarea
                    placeholder="Reason for your decision (required)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
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
                    {isAccepted(scores) ? (
                      <span className="ok">Your verdict: accept ✓</span>
                    ) : (
                      <span className="error">Your verdict: reject ✗ — verifiable ≥ 4, all ≥ 3</span>
                    )}
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

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <div data-hl="task-stack" className="empty-figure" aria-label={title} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function Toasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  useEffect(() => {
    toastListeners.push((t) => {
      setToasts((p) => [...p, t]);
      setTimeout(() => setToasts((p) => p.filter((x) => x.id !== t.id)), 3000);
    });
    return () => {
      toastListeners = [];
    };
  }, []);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
