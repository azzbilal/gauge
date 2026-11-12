import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, Campaign, Task } from '../api';
import { notify } from '../toast';
import { EmptyState } from '../components/EmptyState';

const DEFAULT_TARGET = 10;
const MAX_TARGET = 9999;

interface Tally {
  total: number;
  accepted: number;
}

const clampTarget = (n: number) => Math.min(MAX_TARGET, Math.max(0, Math.round(n) || 0));

export function CampaignsView() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  // null until /api/tasks answers; stays null if it fails, so cards fall back gracefully
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState(DEFAULT_TARGET);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    api
      .get<Campaign[]>('/api/campaigns')
      .then((rows) => {
        setCampaigns(rows);
        setLoadError('');
      })
      .catch((e: Error) => setLoadError(e.message));
    api
      .get<Task[]>('/api/tasks')
      .then(setTasks)
      .catch(() => setTasks(null));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (open) nameRef.current?.focus();
  }, [open]);

  const tallies = useMemo(() => {
    if (!tasks) return null;
    const byCampaign = new Map<string, Tally>();
    for (const t of tasks) {
      const tally = byCampaign.get(t.campaign.id) ?? { total: 0, accepted: 0 };
      tally.total += 1;
      if (t.status === 'ACCEPTED') tally.accepted += 1;
      byCampaign.set(t.campaign.id, tally);
    }
    return byCampaign;
  }, [tasks]);

  function close() {
    setOpen(false);
    setName('');
    setTarget(DEFAULT_TARGET);
    setFormError('');
    openerRef.current?.focus();
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setFormError('');
    try {
      await api.post('/api/campaigns', { name: name.trim(), targetCount: target });
      close();
      load();
      notify('Campaign created');
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cp">
      <header className="cp-head">
        <h2>Campaigns</h2>
        <button
          ref={openerRef}
          type="button"
          className="cp-primary"
          aria-expanded={open}
          aria-controls="campaign-form"
          onClick={() => (open ? nameRef.current?.focus() : setOpen(true))}
        >
          New campaign
        </button>
      </header>

      {open && (
        <form
          id="campaign-form"
          className="cp-form"
          aria-label="New campaign"
          onSubmit={create}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !busy) close();
          }}
        >
          <div className="field cp-form-name">
            <label htmlFor="campaign-name">Campaign name</label>
            <input
              id="campaign-name"
              ref={nameRef}
              placeholder="e.g. Bracket series"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="campaign-target">Target tasks</label>
            <div className="cp-stepper">
              <button
                type="button"
                aria-label="Decrease target"
                disabled={target <= 0}
                onClick={() => setTarget((n) => clampTarget(n - 1))}
              >
                −
              </button>
              <input
                id="campaign-target"
                className="num"
                inputMode="numeric"
                autoComplete="off"
                value={target}
                onChange={(e) => setTarget(clampTarget(Number(e.target.value.replace(/\D/g, ''))))}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setTarget((n) => clampTarget(n + 1));
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setTarget((n) => clampTarget(n - 1));
                  }
                }}
              />
              <button
                type="button"
                aria-label="Increase target"
                disabled={target >= MAX_TARGET}
                onClick={() => setTarget((n) => clampTarget(n + 1))}
              >
                +
              </button>
            </div>
          </div>

          <div className="cp-form-actions">
            <button type="submit" className="cp-primary" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create campaign'}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>

          {formError && <p className="error">{formError}</p>}
        </form>
      )}

      {loadError && <p className="error">{loadError}</p>}

      {campaigns.length === 0 ? (
        <EmptyState title="No campaigns yet" body="Create one to open a task campaign." />
      ) : (
        <ul className="cp-grid">
          {campaigns.map((c) => {
            const tally = tallies ? (tallies.get(c.id) ?? { total: 0, accepted: 0 }) : null;
            const done = tally ? tally.total : (c._count?.tasks ?? 0);
            const progress = c.targetCount > 0 ? Math.min(1, done / c.targetCount) : 0;
            const rate = tally && tally.total > 0 ? Math.round((tally.accepted / tally.total) * 100) : null;
            return (
              <li key={c.id}>
                <a className="cp-card" href={`#/campaigns/${c.id}`}>
                  <div className="cp-card-head">
                    <h3>{c.name}</h3>
                    <span className="cp-spec">
                      spec <span className="num">{c.specVersion}</span>
                    </span>
                  </div>
  
                  <div className="cp-progress">
                    <div className="cp-line">
                      <span>Tasks</span>
                      <span className="num">
                        {done}/{c.targetCount}
                      </span>
                    </div>
                    <div
                      className="cp-bar"
                      role="progressbar"
                      aria-label={`${c.name} tasks toward target`}
                      aria-valuemin={0}
                      aria-valuemax={c.targetCount}
                      aria-valuenow={Math.min(done, c.targetCount)}
                    >
                      <i style={{ width: `${progress * 100}%` }} />
                    </div>
                  </div>
  
                  <div className="cp-line">
                    <span>Accept rate</span>
                    {rate === null || !tally ? (
                      <span className="num">—</span>
                    ) : (
                      <span className="num" title={`${tally.accepted} accepted of ${tally.total}`}>
                        {rate}%
                      </span>
                    )}
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
