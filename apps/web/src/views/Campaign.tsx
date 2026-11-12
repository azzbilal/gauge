import { useEffect, useState } from 'react';
import { api, Campaign, Task } from '../api';
import { EmptyState } from '../components/EmptyState';

const statusWord = (t: Task) =>
  t.reviewState === 'awaiting_adjudication' ? 'split' : t.status.toLowerCase().replace(/_/g, ' ');

export function CampaignView({ id }: { id: string }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [campaignLoaded, setCampaignLoaded] = useState(false);
  // null until /api/tasks answers; stays null if it fails, so the header falls back to the campaign's own count
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    // There is no single-campaign endpoint; the list is small, so find it there.
    api
      .get<Campaign[]>('/api/campaigns')
      .then((rows) => {
        if (live) setCampaign(rows.find((c) => c.id === id) ?? null);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setCampaignLoaded(true);
      });
    api
      .get<Task[]>(`/api/tasks?campaignId=${encodeURIComponent(id)}`)
      .then((rows) => {
        if (live) setTasks(rows);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setTasksLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [id]);

  const back = (
    <a className="cd-back" href="#/campaigns">
      <span aria-hidden="true">←</span> Campaigns
    </a>
  );

  if (!campaign) {
    return (
      <section className="cd">
        {back}
        {error && <p className="error">{error}</p>}
        {campaignLoaded && !error && (
          <EmptyState title="Campaign not found" body="It may have been removed, or the link is wrong." />
        )}
      </section>
    );
  }

  const done = tasks ? tasks.length : (campaign._count?.tasks ?? 0);
  const progress = campaign.targetCount > 0 ? Math.min(1, done / campaign.targetCount) : 0;

  return (
    <section className="cd">
      {back}

      <header className="cd-head">
        <h2>{campaign.name}</h2>
        <span className="cp-spec">
          spec <span className="num">{campaign.specVersion}</span>
        </span>

        <div className="cp-progress">
          <div className="cp-line">
            <span>Tasks</span>
            <span className="num">
              {done}/{campaign.targetCount}
            </span>
          </div>
          <div
            className="cp-bar"
            role="progressbar"
            aria-label={`${campaign.name} tasks toward target`}
            aria-valuemin={0}
            aria-valuemax={campaign.targetCount}
            aria-valuenow={Math.min(done, campaign.targetCount)}
          >
            <i style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      {tasks && tasks.length > 0 && (
        <ul className="cd-rows">
          {tasks.map((t) => {
            const word = statusWord(t);
            return (
              <li key={t.id}>
                <a className="cd-row" href={`#/review/${t.id}`}>
                  <span className="cd-row-prompt">{t.prompt}</span>
                  <span className="cd-row-meta">
                    <span className="cd-row-who">{t.author.name}</span>
                    <span className={`rv-status${word === 'split' ? ' split' : ''}`}>{word}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {tasksLoaded && tasks && tasks.length === 0 && (
        <EmptyState title="No tasks yet" body="Tasks authored for this campaign will show up here." />
      )}
    </section>
  );
}
