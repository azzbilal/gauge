import { useEffect, useState } from 'react';
import { api, Campaign, Task } from '../api';
import { notify } from '../toast';

export function AuthorView({ identityId }: { identityId: string }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [spec, setSpec] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Campaign[]>('/api/campaigns').then(setCampaigns).catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const task = await api.post<Task>('/api/tasks', {
        campaignId,
        authorId: identityId,
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
        <button disabled={busy || !campaignId || !identityId || !prompt.trim()}>Submit task</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
