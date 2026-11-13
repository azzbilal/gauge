import type { LintFinding } from '../api';

// One row of a lint or verifier list. `state` drives the dot: ring (idle), filled (pass),
// bright ring (fail). The word says the same thing in text.
export type Row = { state: 'idle' | 'pass' | 'fail'; name: string; word: string; detail?: string | null };

const SEVERITY_ORDER = ['critical', 'warning', 'info'];

export const isCritical = (f: LintFinding) => f.severity === 'critical';
export const words = (s: string) => s.replace(/_/g, ' ');

/** Critical first; a severity this view does not know sorts last. */
export const severityRank = (f: LintFinding) => {
  const at = SEVERITY_ORDER.indexOf(f.severity);
  return at < 0 ? SEVERITY_ORDER.length : at;
};

// Every packet is built with rubric items that name no requirement (the manual criteria),
// so the linter says so about each one, on every task, and nobody can do anything about it.
// Only that one sentence is hidden, and never a critical finding: "requirement Y is not
// referenced by any rubric item" still shows.
export const isBuiltInNoise = (f: LintFinding) =>
  f.rule === 'traceability' &&
  !isCritical(f) &&
  /^rubric item .+ does not reference any requirement$/.test(f.detail ?? '');

export function CheckRows({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <>
      <h3>{title}</h3>
      <ul>
        {rows.map((r, i) => (
          <li key={i} data-state={r.state}>
            <i aria-hidden="true" />
            <span className="au-lint-name">{r.name}</span>
            <span className="au-lint-word">{r.word}</span>
            {r.detail && <p>{r.detail}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}
