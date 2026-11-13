import { useCallback, useEffect, useState } from 'react';
import { api, AuthUser, getToken, setToken, SIGNED_OUT } from './api';
import { CommandPalette } from './components/CommandPalette';
import { Toasts } from './toast';
import { navigate, useHashRoute } from './useHashRoute';
import { CampaignsView } from './views/Campaigns';
import { CampaignView } from './views/Campaign';
import { AuthorView } from './views/Author';
import { ReviewView } from './views/Review';
import { LoginView } from './views/Login';

const TABS = [
  { path: '/campaigns', label: 'Campaigns' },
  { path: '/author', label: 'Author Task' },
  { path: '/review', label: 'Review' },
] as const;

export default function App() {
  const { path, param } = useHashRoute();
  // undefined: still asking the API who the stored token belongs to.
  const [user, setUser] = useState<AuthUser | null | undefined>(() => (getToken() ? undefined : null));
  const [paletteOpen, setPaletteOpen] = useState(false);

  // A stored token is only a claim: the API says whose it is, and whether it still holds.
  useEffect(() => {
    if (!getToken()) return;
    api
      .get<AuthUser>('/api/auth/me')
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  // Any request the API refuses for the token (expired, user removed) ends the session.
  useEffect(() => {
    const onSignedOut = () => {
      setUser(null);
      setPaletteOpen(false);
    };
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    setPaletteOpen(false);
  }, []);

  // Ctrl+K opens the palette from anywhere. While it is open it owns the keyboard
  // (it stops key events), so closing by the same chord is handled inside it.
  useEffect(() => {
    if (!user) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user]);

  const activePath = path.startsWith('/author') ? '/author' : path.startsWith('/review') ? '/review' : '/campaigns';

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Gauge</span>
        {user && (
          <>
            <nav>
              {TABS.map((t) => (
                <button key={t.path} className={`tab${activePath === t.path ? ' active' : ''}`} onClick={() => navigate(t.path)}>
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="identity">
              <span>
                {user.name} <span className="identity-role">· {user.role}</span>
              </span>
              <button type="button" onClick={signOut}>
                Sign out
              </button>
            </div>
          </>
        )}
      </header>
      <main className="content">
        {user === null && <LoginView onSignedIn={setUser} />}
        {user && (
          <>
            {activePath === '/campaigns' && (path === '/campaigns' && param ? <CampaignView key={param} id={param} /> : <CampaignsView user={user} />)}
            {activePath === '/author' && <AuthorView user={user} />}
            {activePath === '/review' && <ReviewView key={user.id} user={user} taskId={param} />}
          </>
        )}
      </main>
      {user && paletteOpen && <CommandPalette onSignOut={signOut} onClose={() => setPaletteOpen(false)} />}
      <Toasts />
    </div>
  );
}
