import { useEffect, useState } from 'react';
import './App.css';

interface Health {
  status: string;
  service: string;
  timestamp: string;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setHealth)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <main className="app">
      <h1>Gauge</h1>
      <p className="tagline">A miniature human-data lab for CAD reasoning.</p>

      <section className="card">
        <h2>API status</h2>
        {error && <p className="error">Unreachable: {error}</p>}
        {health && (
          <p className="ok">
            {health.service} — {health.status} at {health.timestamp}
          </p>
        )}
        {!health && !error && <p>Checking…</p>}
      </section>
    </main>
  );
}
