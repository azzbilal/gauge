import { useEffect, useState } from 'react';

export type ToastMsg = { id: number; text: string; kind: 'ok' | 'error' };
let listeners: Array<(t: ToastMsg) => void> = [];

export function notify(text: string, kind: 'ok' | 'error' = 'ok') {
  listeners.forEach((l) => l({ id: Date.now() + Math.random(), text, kind }));
}

export function Toasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  useEffect(() => {
    listeners.push((t) => {
      setToasts((p) => [...p, t]);
      setTimeout(() => setToasts((p) => p.filter((x) => x.id !== t.id)), 3000);
    });
    return () => {
      listeners = [];
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
