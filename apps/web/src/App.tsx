import { useEffect, useState } from 'react';
import { api, Expert } from './api';
import { Toasts } from './toast';
import { navigate, useHashRoute } from './useHashRoute';
import { CampaignsView } from './views/Campaigns';
import { CampaignView } from './views/Campaign';
import { AuthorView } from './views/Author';
import { ReviewView } from './views/Review';

const TABS = [
  { path: '/campaigns', label: 'Campaigns' },
  { path: '/author', label: 'Author Task' },
  { path: '/review', label: 'Review' },
] as const;

export default function App() {
  const { path, param } = useHashRoute();
  const [experts, setExperts] = useState<Expert[]>([]);
  const [identityId, setIdentityId] = useState<string>(() => localStorage.getItem('gauge.identity') ?? '');

  useEffect(() => {
    api.get<Expert[]>('/api/experts').then(setExperts).catch(() => undefined);
  }, []);

  function setIdentity(id: string) {
    setIdentityId(id);
    localStorage.setItem('gauge.identity', id);
  }

  const activePath = path.startsWith('/author') ? '/author' : path.startsWith('/review') ? '/review' : '/campaigns';

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Gauge</span>
        <nav>
          {TABS.map((t) => (
            <button key={t.path} className={`tab${activePath === t.path ? ' active' : ''}`} onClick={() => navigate(t.path)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="identity">
          <select value={identityId} onChange={(e) => setIdentity(e.target.value)} aria-label="You are">
            <option value="">You are…</option>
            {experts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
      </header>
      <main className="content">
        {activePath === '/campaigns' && (path === '/campaigns' && param ? <CampaignView key={param} id={param} /> : <CampaignsView />)}
        {activePath === '/author' && <AuthorView identityId={identityId} />}
        {activePath === '/review' && <ReviewView identityId={identityId} taskId={param} />}
      </main>
      <Toasts />
    </div>
  );
}
