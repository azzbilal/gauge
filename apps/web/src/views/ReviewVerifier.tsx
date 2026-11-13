import { useEffect, useState } from 'react';
import { api, StoredVerdict, TaskVerification } from '../api';
import { CheckRows, isBuiltInNoise, isCritical, Row, severityRank, words } from '../components/CheckRows';

// Stored in place of findings when the linter could not be asked (task.service.ts).
const LINT_NOT_RUN_RULE = 'lint_not_run';
const REFERENCE_SOLUTION = 'REFERENCE_SOLUTION';

// Ids a stored detail may still quote once the known ones are named: a Prisma cuid, or the
// uuid a gold clone's rows are re-keyed to. Neither is shown: an id says nothing to a
// reviewer, and a clone's would set it apart from a normal task.
const STRAY_ID = /\bc[0-9a-z]{24}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

/** Names for the ids the stored rows quote: a criterion for a rubric item, text for a requirement. */
function labelsOf(v: TaskVerification) {
  const requirements = v.requirements ?? [];
  const rubricItems = v.rubricItems ?? [];
  const requirement = new Map(requirements.map((r) => [r.id, r.text]));
  // Rubric item text opens with its criterion key ("correct_reference: ...").
  const criterion = new Map(rubricItems.map((i) => [i.id, i.text.split(':')[0].trim()]));
  const names: Array<[string, string]> = [
    // A machine item's packet id is `<rubricItemId>:<requirementId>`, one per requirement it
    // checks; the details quote that. The stored row names a requirement only when it checks
    // just one, so every pairing is named.
    ...rubricItems.flatMap((i) =>
      requirements.map((r): [string, string] => [`${i.id}:${r.id}`, words(criterion.get(i.id) ?? '')]),
    ),
    ...rubricItems.map((i): [string, string] => [i.id, words(criterion.get(i.id) ?? '')]),
    ...requirements.map((r): [string, string] => [r.id, `"${r.text}"`]),
  ];
  // Longest first, so a composite id is named whole, not as two halves.
  names.sort((a, b) => b[0].length - a[0].length);
  return {
    requirement: (id: string | null | undefined) => (id ? requirement.get(id) ?? null : null),
    criterion: (id: string | undefined) => (id ? criterion.get(id) ?? null : null),
    readable: (text: string) =>
      names.reduce((out, [id, name]) => out.split(id).join(name), text).replace(STRAY_ID, '…'),
  };
}

type Labels = ReturnType<typeof labelsOf>;

function lintRows(v: TaskVerification, labels: Labels): Row[] {
  // Decided on the stored rows before any is hidden: no rows is no lint, not a clean one.
  if (v.lintFindings.length === 0) {
    return [{ state: 'idle', name: 'Packet lint', word: 'not run', detail: 'No lint is stored for this task.' }];
  }
  const notRun = v.lintFindings.find((f) => f.rule === LINT_NOT_RUN_RULE);
  if (notRun) {
    return [{ state: 'idle', name: 'Packet lint', word: 'not run', detail: notRun.detail }];
  }
  const findings = v.lintFindings.filter((f) => !isBuiltInNoise(f));
  if (findings.length === 0) return [{ state: 'pass', name: 'No findings', word: 'pass' }];
  return [...findings]
    .sort((a, b) => severityRank(a) - severityRank(b))
    .map((f) => ({
      state: isCritical(f) ? 'fail' : 'idle',
      name: words(f.rule),
      word: f.severity,
      detail: f.detail === null ? null : labels.readable(f.detail),
    }));
}

/** The verdicts a stored run holds, read defensively: `results` is JSON. */
function storedVerdicts(results: unknown): StoredVerdict[] {
  if (!Array.isArray(results)) return [];
  return results.flatMap((v): StoredVerdict[] => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return [];
    const r = v as Record<string, unknown>;
    return [
      {
        rubric_item_id: typeof r.rubric_item_id === 'string' ? r.rubric_item_id : undefined,
        requirement_id: typeof r.requirement_id === 'string' ? r.requirement_id : null,
        check: String(r.check ?? ''),
        status: String(r.status ?? ''),
        detail: String(r.detail ?? ''),
      },
    ];
  });
}

/** The latest verifier run on the reference solution, or null when none is stored. */
function referenceRun(v: TaskVerification) {
  const runs = v.verifierRuns.filter((r) => r.subjectType === REFERENCE_SOLUTION);
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

function verdictRows(v: TaskVerification, labels: Labels): { rows: Row[]; checked: Set<string> } {
  const checked = new Set<string>();
  const run = referenceRun(v);
  if (!run) {
    return {
      rows: [
        {
          state: 'idle',
          name: 'Reference',
          word: 'not run',
          detail: 'No verifier run is stored: the verify service was not reached, or the spec could not be read.',
        },
      ],
      checked,
    };
  }
  const verdicts = storedVerdicts(run.results);
  // No verdict is not a pass: nothing was checked.
  if (verdicts.length === 0) {
    return {
      rows: [
        {
          state: 'idle',
          name: 'Reference',
          word: 'not run',
          detail: 'The spec states no named dimension a machine can check.',
        },
      ],
      checked,
    };
  }
  const rows = verdicts.map((d): Row => {
    const criterion = labels.criterion(d.rubric_item_id);
    // Only the two known outcomes count; anything else did not run.
    const status = d.status === 'pass' || d.status === 'fail' ? d.status : 'not_run';
    if (criterion && status !== 'not_run') checked.add(criterion);
    const requirement = labels.requirement(d.requirement_id);
    const check = d.check ? words(d.check) : '';
    const detail = d.detail ? labels.readable(d.detail) : '';
    return {
      state: status === 'not_run' ? 'idle' : status,
      // An API without the rubric items cannot name the criterion; the check stands in.
      name: criterion ? words(criterion) : check || 'Reference',
      word: status === 'not_run' ? 'not run' : status,
      detail: [requirement && `"${requirement}"`, [check, detail].filter(Boolean).join(': ')]
        .filter(Boolean)
        .join(' · '),
    };
  });
  return { rows, checked };
}

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ok'; verification: TaskVerification };

/**
 * What the machine found when the task was created: the packet lint and the verifier's
 * verdicts on the reference, per criterion. Read-only, beside the scores, never part of them.
 * `criteria` is the rubric, so the criteria no machine checked can be named as such.
 */
export function ReviewVerifier({ taskId, criteria }: { taskId: string; criteria: readonly string[] }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    api
      .get<TaskVerification>(`/api/tasks/${encodeURIComponent(taskId)}/verification`)
      .then((verification) => {
        if (live) setLoad({ state: 'ok', verification });
      })
      .catch((e: Error) => {
        if (!live) return;
        const missing = /^404:/.test(e.message);
        setLoad({ state: 'error', message: missing ? 'No verification found for this task.' : e.message });
      });
    return () => {
      live = false;
    };
  }, [taskId]);

  let body;
  if (load.state === 'loading') {
    body = <p className="muted rv-verify-note">Loading verification…</p>;
  } else if (load.state === 'error') {
    body = <p className="muted rv-verify-note">Verification unavailable · {load.message}</p>;
  } else {
    const v = load.verification;
    const labels = labelsOf(v);
    const verify = verdictRows(v, labels);
    // Without the rubric items (an older API) no verdict can be tied to a criterion, so none
    // is named as unchecked either.
    const unchecked = v.rubricItems ? criteria.filter((c) => !verify.checked.has(c)) : [];
    body = (
      <>
        <CheckRows title="Lint" rows={lintRows(v, labels)} />
        <CheckRows title="Verifier" rows={verify.rows} />
        {unchecked.length > 0 && (
          <p className="rv-verify-note">
            Not machine-checked: {unchecked.map(words).join(', ')}. Judge these from the task.
          </p>
        )}
      </>
    );
  }

  return (
    <section className="rv-verify au-lint" aria-label="Machine verification" aria-busy={load.state === 'loading'}>
      {body}
    </section>
  );
}
