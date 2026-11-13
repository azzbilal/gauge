import { useState } from 'react';
import { api, AuthUser, Session, setToken } from '../api';
import { PrimaryButton } from '../components/PrimaryButton';

/** "401: {"message":"Wrong email or password",...}" -> "Wrong email or password". */
function readable(err: unknown): string {
  const text = (err as Error).message ?? String(err);
  const body = text.replace(/^\d+:\s*/, '');
  try {
    const { message } = JSON.parse(body) as { message?: string | string[] };
    if (message) return Array.isArray(message) ? message.join('; ') : message;
  } catch {
    // not JSON: show it as it came
  }
  return text;
}

/**
 * Sign in, or register as an author. Other roles are given by an admin
 * (POST /auth/register with an admin's token).
 */
export function LoginView({ onSignedIn }: { onSignedIn: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const registering = mode === 'register';
  const canSubmit = !busy && email.trim() && password && (!registering || name.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    // A stale token would be refused before the password is even checked.
    setToken(null);
    try {
      const session = registering
        ? await api.post<Session>('/api/auth/register', { name: name.trim(), email: email.trim(), password })
        : await api.post<Session>('/api/auth/login', { email: email.trim(), password });
      setToken(session.accessToken);
      onSignedIn(session.user);
    } catch (err) {
      setError(readable(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="login">
      <h2>{registering ? 'Create an author account' : 'Sign in'}</h2>
      <form className="login-form" onSubmit={submit} aria-label={registering ? 'Register' : 'Sign in'}>
        {registering && (
          <div className="field">
            <label htmlFor="login-name">Name</label>
            <input id="login-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete={registering ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {registering && <span className="hint">At least 8 characters.</span>}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <PrimaryButton type="submit" label={busy ? 'Working…' : registering ? 'Register' : 'Sign in'} disabled={!canSubmit} />
      </form>
      <button
        type="button"
        className="login-switch"
        onClick={() => {
          setMode(registering ? 'login' : 'register');
          setError('');
        }}
      >
        {registering ? 'Have an account? Sign in' : 'New author? Create an account'}
      </button>
    </section>
  );
}
