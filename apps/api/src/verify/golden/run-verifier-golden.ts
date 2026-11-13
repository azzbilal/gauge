/**
 * Gate 2 harness: verifier agreement with human verdicts on the Layer 2 golden set
 * (prisma/verifier-golden-set.json, references in prisma/verifier-golden/).
 *
 *   npm run verifier-golden                       # seed what is missing, then report
 *   npm run verifier-golden -- --out ../../docs/results/gate2-verifier-agreement-<date>
 *   npm run verifier-golden -- --dry-run          # verify each reference, touch no database
 *
 * Every task goes through the real TaskService: create() extracts, lints, verifies the
 * reference and stores the VerifierRun; review() records two peer reviews whose rubric scores
 * give the expected human verdict, so the task is ACCEPTED or REJECTED by consensus. Nothing
 * here writes a verifier result itself. Re-running seeds only the tasks that are missing
 * (matched on prompt and reference within the golden campaign) and finishes their reviews.
 *
 * Needs the database and the verify service (VERIFY_SERVICE_URL, default localhost:4000).
 * Start that service with GAUGE_CAD_PYTHON pointing at an interpreter with cadquery, or the
 * verifier falls back to static reading and the dead-code and cut-part cases measure nothing
 * real; the report records which mode the verdicts came from. Set GAUGE_CAD_PYTHON for this
 * script too and the report also records that interpreter's cadquery version.
 *
 * Exit code: 0 when every golden task is decided as labelled and has a verifier run; 1
 * otherwise (or when the verify service gives no run); 2 on bad input.
 */
import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { ExpertStatus, Role, TaskStatus } from '@prisma/client';
import { AuthUser } from '../../auth/auth.decorators';
import { CRITERIA, Scores, isAccepted } from '../../campaign/review-protocol';
import { TaskService } from '../../campaign/task.service';
import { PrismaService } from '../../prisma/prisma.service';
import { buildPacket } from '../packet-builder';
import { VerifyClient, VerifierVerdict } from '../verify.client';

const API_ROOT = resolve(__dirname, '..', '..', '..');
const SET_FILE = resolve(API_ROOT, 'prisma', 'verifier-golden-set.json');
const REFERENCE_DIR = resolve(API_ROOT, 'prisma', 'verifier-golden');
// Expert rows only: the golden reviewers never log in, so no User rows and no passwords.
const GOLDEN_DOMAIN = 'CAD (verifier golden set)';
const AUTHOR_NAME = 'Golden-set author';
const REVIEWER_NAMES = ['Golden-set reviewer A', 'Golden-set reviewer B'];

interface GoldenTask {
  id: string;
  category: string;
  prompt: string;
  spec?: string | null;
  reference: string;
  expectedAccept: boolean;
  why: string;
}

interface GoldenSet {
  name: string;
  version: number;
  campaign: string;
  tasks: GoldenTask[];
}

class InputError extends Error {}

function loadSet(): GoldenSet & { tasks: Array<GoldenTask & { source: string }> } {
  const set = JSON.parse(readFileSync(SET_FILE, 'utf8')) as GoldenSet;
  if (!set.campaign || !Array.isArray(set.tasks) || set.tasks.length === 0) {
    throw new InputError(`${SET_FILE}: needs "campaign" and a non-empty "tasks" list`);
  }
  const ids = new Set<string>();
  const tasks = set.tasks.map((t) => {
    if (!t.id || ids.has(t.id)) throw new InputError(`golden task id "${t.id}" missing or repeated`);
    ids.add(t.id);
    if (typeof t.expectedAccept !== 'boolean') throw new InputError(`${t.id}: expectedAccept must be a boolean`);
    const file = resolve(REFERENCE_DIR, t.reference);
    if (!existsSync(file)) throw new InputError(`${t.id}: reference ${file} not found`);
    return { ...t, source: readFileSync(file, 'utf8') };
  });
  return { ...set, tasks };
}

/**
 * Two reviewers' rubric scores for the expected verdict. A reject scores correct_reference
 * below the bar, which is where every wrong reference in the set fails; isAccepted decides,
 * and the result is checked against the label.
 */
function reviewFor(task: GoldenTask, reviewer: 0 | 1): { scores: Scores; evidence: Record<string, string> } {
  const scores: Scores = task.expectedAccept
    ? { verifiable: 5 - reviewer, unambiguous: 4, correct_reference: 5 - reviewer, complete_constraints: 4, difficulty: 3 }
    : { verifiable: 5 - reviewer, unambiguous: 4, correct_reference: 1 + reviewer, complete_constraints: 4, difficulty: 3 };
  if (isAccepted(scores) !== task.expectedAccept) {
    throw new InputError(`${task.id}: the seeded scores do not give the expected verdict`);
  }
  const evidence: Record<string, string> = {
    verifiable: 'Every size and the hole count are stated as numbers a checker can measure.',
    unambiguous: 'One reading of the part; the hole layout is left to the author.',
    correct_reference: task.why,
    complete_constraints: 'Overall size, hole size and hole count are all given.',
    difficulty: 'A single-feature part; easy for a CAD author.',
  };
  return { scores, evidence: Object.fromEntries(CRITERIA.map((c) => [c, evidence[c]])) };
}

function actor(expertId: string, name: string, role: Role): AuthUser {
  return { id: `golden-${expertId}`, name, email: '', role, isLead: false, expertId };
}

async function expertNamed(prisma: PrismaService, name: string): Promise<string> {
  const found = await prisma.expert.findFirst({ where: { name, domain: GOLDEN_DOMAIN } });
  if (found) return found.id;
  const created = await prisma.expert.create({
    data: { name, domain: GOLDEN_DOMAIN, status: ExpertStatus.ACTIVE },
  });
  return created.id;
}

/** Which interpreter and cadquery this script was told the verify service uses. */
function cadqueryVersion(): string | null {
  const python = process.env.GAUGE_CAD_PYTHON?.trim();
  if (!python) return null;
  try {
    // Versions only, never the path: the path names the machine and its user.
    const code = 'import sys, cadquery; print(f"{cadquery.__version__} on Python {sys.version.split()[0]}")';
    return execFileSync(python, ['-c', code], {
      encoding: 'utf8',
      timeout: 60_000,
    }).trim();
  } catch {
    return 'not importable';
  }
}

/** How the size verdicts were reached: by executing the reference, or by reading it. */
function execMode(checks: Array<{ check: string; detail: string }>): string {
  const fallback = checks.some((v) => v.detail.includes('[static fallback'));
  const executed = checks.some((v) => v.check === 'geometry_cad');
  const statically = checks.some((v) => v.check === 'static_cad' && /width|depth|height/.test(v.detail));
  if (fallback) return 'static fallback (cadquery missing in the verify service)';
  if (executed && !statically) return 'executed (geometry_cad)';
  if (executed) return 'mixed: some sizes executed, some read statically';
  return 'static only (execution switched off?)';
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)} %`);
const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function dryRun(set: ReturnType<typeof loadSet>): Promise<number> {
  const client = new VerifyClient();
  for (const t of set.tasks) {
    const built = await buildPacket({ prompt: t.prompt, spec: t.spec ?? null, reference: t.source }, client);
    const started = Date.now();
    const verdicts: VerifierVerdict[] = await client.verify(built.packet);
    const passed = verdicts.length > 0 && verdicts.every((v) => v.pass);
    console.log(`\n${t.id}  expected ${t.expectedAccept ? 'accept' : 'reject'}  verifier ${passed ? 'PASS' : 'no pass'}  (${Date.now() - started} ms)`);
    for (const r of built.requirements) console.log(`  req ${r.id.slice(0, 8)}  ${r.text}`);
    for (const v of verdicts) console.log(`  ${v.status.padEnd(7)} ${v.check.padEnd(15)} ${short(v.detail, 140)}`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const outArg = argv.indexOf('--out');
  if (outArg >= 0 && !argv[outArg + 1]) throw new InputError('--out needs a path (without extension)');
  const out = outArg >= 0 ? resolve(process.cwd(), argv[outArg + 1]) : null;
  const set = loadSet();
  if (argv.includes('--dry-run')) return dryRun(set);

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const service = new TaskService(prisma, new VerifyClient());
    const campaign =
      (await prisma.campaign.findFirst({ where: { name: set.campaign } })) ??
      (await prisma.campaign.create({
        data: { name: set.campaign, targetCount: set.tasks.length, specVersion: `verifier-golden-v${set.version}` },
      }));
    const author = actor(await expertNamed(prisma, AUTHOR_NAME), AUTHOR_NAME, Role.AUTHOR);
    const reviewers = await Promise.all(
      REVIEWER_NAMES.map(async (n) => actor(await expertNamed(prisma, n), n, Role.REVIEWER)),
    );

    const problems: string[] = [];
    const seeded: Array<{ golden: (typeof set.tasks)[number]; taskId: string; created: boolean }> = [];
    for (const g of set.tasks) {
      const existing = await prisma.task.findFirst({
        where: { campaignId: campaign.id, prompt: g.prompt, reference: g.source, isGold: false },
        orderBy: { createdAt: 'asc' },
      });
      let taskId = existing?.id;
      if (!taskId) {
        const created = await service.create(
          { campaignId: campaign.id, prompt: g.prompt, spec: g.spec ?? undefined, reference: g.source },
          author,
        );
        taskId = created.id;
      }
      seeded.push({ golden: g, taskId, created: !existing });

      const reviewed = await prisma.taskReview.findMany({ where: { taskId }, select: { reviewerExpertId: true } });
      for (const [i, reviewer] of reviewers.entries()) {
        if (reviewed.some((r) => r.reviewerExpertId === reviewer.expertId)) continue;
        await service.review(taskId, reviewFor(g, i as 0 | 1), reviewer);
      }
    }

    // The checks that make the number trustworthy: every task decided as labelled, and every
    // one verified. create() lets a task through when the verify service is down; here that
    // is a failed run, not a task to leave out.
    const report = await service.verifierAgreement(campaign.id);
    const rows = [];
    for (const { golden, taskId, created } of seeded) {
      const task = await prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        include: {
          verifierRuns: { orderBy: { createdAt: 'desc' }, take: 1 },
          requirements: true,
          lintFindings: true,
        },
      });
      const expected = golden.expectedAccept ? TaskStatus.ACCEPTED : TaskStatus.REJECTED;
      if (task.status !== expected) problems.push(`${golden.id}: status ${task.status}, expected ${expected}`);
      const run = task.verifierRuns[0];
      if (!run) problems.push(`${golden.id}: no verifier run stored (was the verify service up?)`);
      const requirement = new Map(task.requirements.map((r) => [r.id, r.text]));
      const verdicts = (Array.isArray(run?.results) ? run.results : []) as unknown as VerifierVerdict[];
      rows.push({
        goldenId: golden.id,
        category: golden.category,
        taskId,
        createdThisRun: created,
        expectedHuman: golden.expectedAccept ? 'accept' : 'reject',
        humanDecision: task.status === TaskStatus.ACCEPTED ? 'accept' : task.status === TaskStatus.REJECTED ? 'reject' : task.status,
        verifierPassed: run?.passed ?? null,
        agrees: run ? run.passed === (task.status === TaskStatus.ACCEPTED) : null,
        lint: task.lintFindings.map((f) => `${f.severity}:${f.rule}`),
        verdicts: verdicts.map((v) => ({
          requirement: v.requirement_id ? (requirement.get(v.requirement_id) ?? v.requirement_id) : null,
          check: v.check,
          status: v.status,
          detail: v.detail,
        })),
      });
    }
    const allVerdicts = rows.flatMap((r) => r.verdicts);
    const runVersion = await prisma.verifierRun.findFirst({
      where: { taskId: { in: seeded.map((s) => s.taskId) } },
      orderBy: { createdAt: 'desc' },
      select: { verifierVersion: true },
    });
    const environment = {
      verifierVersion: runVersion?.verifierVersion ?? null,
      verifyServiceUrl: process.env.VERIFY_SERVICE_URL?.trim() || 'http://localhost:4000',
      execMode: execMode(allVerdicts),
      cadqueryVersion: cadqueryVersion(),
    };

    const result = {
      set: { name: set.name, version: set.version, file: 'apps/api/prisma/verifier-golden-set.json', tasks: set.tasks.length },
      measuredAt: new Date().toISOString(),
      campaignId: campaign.id,
      environment,
      report,
      tasks: rows,
      problems,
    };

    const text = renderText(result);
    console.log(text);
    if (out) {
      writeFileSync(`${out}.json`, `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(`${out}.txt`, text);
      console.log(`\nWrote ${out}.json and ${out}.txt (dir ${dirname(out)})`);
    }
    return problems.length === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

function renderText(r: {
  set: { name: string; version: number; tasks: number };
  measuredAt: string;
  environment: Record<string, string | null>;
  report: Awaited<ReturnType<TaskService['verifierAgreement']>>;
  tasks: Array<{
    goldenId: string;
    taskId: string;
    category: string;
    expectedHuman: string;
    humanDecision: string;
    verifierPassed: boolean | null;
    agrees: boolean | null;
    verdicts: Array<{ requirement: string | null; check: string; status: string; detail: string }>;
  }>;
  problems: string[];
}): string {
  const { report: rep, environment: env } = r;
  const c = rep.confusion;
  const lines = [
    `Gate 2: verifier agreement with human verdicts`,
    `${r.set.name} v${r.set.version} (${r.set.tasks} tasks), measured ${r.measuredAt}`,
    `verifier ${env.verifierVersion ?? '?'}; ${env.execMode}; cadquery ${env.cadqueryVersion ?? 'not recorded'}`,
    '',
    `Agreement: ${rep.agreed}/${rep.compared} = ${pct(rep.agreementRate)}   Cohen's kappa ${rep.cohenKappa === null ? 'n/a' : rep.cohenKappa.toFixed(2)}`,
    `Decided tasks ${rep.decidedTasks}, compared ${rep.compared}, without a verifier run ${rep.unverified}`,
    `False pass rate (human reject, verifier pass) ${pct(rep.falsePassRate)}; false fail rate (human accept, verifier no pass) ${pct(rep.falseFailRate)}`,
    '',
    'Confusion matrix (rows: human, columns: verifier)',
    '                 verifier pass   verifier no pass',
    `  human accept   ${String(c.acceptedPassed).padStart(13)}   ${String(c.acceptedFailed).padStart(16)}`,
    `  human reject   ${String(c.rejectedPassed).padStart(13)}   ${String(c.rejectedFailed).padStart(16)}`,
    '',
    'Per task',
    ...r.tasks.map(
      (t) =>
        `  ${t.agrees === null ? '  ?  ' : t.agrees ? 'agree' : 'DISAG'}  ${t.goldenId.padEnd(32)} ${t.category.padEnd(16)} human ${t.humanDecision.padEnd(6)} verifier ${t.verifierPassed === null ? 'none' : t.verifierPassed ? 'pass' : 'no pass'}` +
        `  [${t.verdicts.map((v) => `${v.status}`).join(' ')}]`,
    ),
    '',
    'Disagreements',
    ...(rep.disagreements.length === 0
      ? ['  none']
      : rep.disagreements.flatMap((d) => {
          const g = r.tasks.find((t) => t.taskId === d.taskId);
          return [
            `  ${d.kind}  ${g?.goldenId ?? d.taskId}  (human ${d.humanDecision} by ${d.decidedBy}, verifier ${d.verifierPassed ? 'pass' : 'no pass'})`,
            ...d.verdicts.map((v) => `    ${v.status.padEnd(7)} ${v.check.padEnd(15)} ${short(v.detail, 150)}`),
          ];
        })),
  ];
  if (r.problems.length > 0) lines.push('', 'PROBLEMS', ...r.problems.map((p) => `  ${p}`));
  return `${lines.join('\n')}\n`;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof InputError ? 2 : 1);
  });
