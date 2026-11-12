import { useCallback, useEffect, useState } from 'react';
import { api, Campaign } from '../api';
import { notify } from '../toast';
import { EmptyState } from '../components/EmptyState';

export function CampaignsView() {
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
