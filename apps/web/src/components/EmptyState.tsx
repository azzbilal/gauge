export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <div data-hl="task-stack" className="empty-figure" aria-label={title} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
