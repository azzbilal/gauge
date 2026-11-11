import { useCallback, useEffect, useState } from 'react';
import { api, Campaign, Expert, Task } from './api';

const CRITERIA = ['verifiable', 'unambiguous', 'correct_reference', 'complete_constraints', 'difficulty'] as const;

// Mirrors the backend acceptance rule (docs/pipeline.md §2):
// every criterion >= 3 and verifiable >= 4.
function isAccepted(scores: Record<string, number>): boolean {
  return CRITERIA.every((c) => (scores[c] ?? 3) >= 3) && (scores['verifiable'] ?? 3) >= 4;
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
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
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
        <input placeholder="Campaign name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="Target tasks"
          type="number"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          style={{ width: 120 }}
        />
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
  const [msg, setMsg] = useState('');
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
    setMsg('');
    try {
      const task = await api.post<Task>('/api/tasks', {
        campaignId,
        authorId: expertId,
        prompt,
        spec,
        reference,
      });
      setMsg(`Task created (${task.status}).`);
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
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">Campaign…</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={expertId} onChange={(e) => setExpertId(e.target.value)}>
            <option value="">Author…</option>
            {experts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
        <textarea placeholder="Prompt — the instruction a solver reads" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <textarea placeholder="Spec — precise requirements: shape, dimensions, constraints" value={spec} onChange={(e) => setSpec(e.target.value)} />
        <textarea placeholder="Reference — a working CadQuery solution" value={reference} onChange={(e) => setReference(e.target.value)} />
        <button disabled={busy || !campaignId || !expertId || !prompt.trim()}>Submit task</button>
      </form>
      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function ReviewView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<Task[]>('/api/tasks').then(setTasks).catch((e) => setError(String(e.message)));
  }, []);

  useEffect(load, [load]);

  function open(task: Task) {
    setOpenId(openId === task.id ? null : task.id);
    setScores(Object.fromEntries(CRITERIA.map((c) => [c, 3])));
    setError('');
  }

  async function submitReview(taskId: string) {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/tasks/${taskId}/reviews`, { reviewerId: 'me', scores });
      setOpenId(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Review queue</h2>
      {error && <p className="error">{error}</p>}
      {tasks.length === 0 ? (
        <EmptyState title="No tasks yet" body="Tasks authors submit will show up here for review." />
      ) : (
        <ul className="list">
          {tasks.map((t) => (
            <li key={t.id} className="task">
              <button className="task-head" onClick={() => open(t)}>
                <span className="strong">{truncate(t.prompt, 70)}</span>
                <span className={`badge badge-${t.status.toLowerCase()}`}>{t.status}</span>
              </button>
              <span className="muted">
                {t.author.name} · {t.campaign.name} · {t.taskReviews.length} review(s)
              </span>
              {openId === t.id && (
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
                      <span className="ok">Accepted ✓</span>
                    ) : (
                      <span className="error">Rejected ✗ — verifiable ≥ 4, all ≥ 3</span>
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
