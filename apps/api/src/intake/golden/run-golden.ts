/**
 * Gate 1 harness: score the 20-pair golden set with the configured intake provider and
 * report pass/fail per pair and the agreement rate. See golden-eval.ts for the rules.
 *
 *   npm run golden                              # from apps/api; reads prisma/golden-set.json
 *   npm run golden -- --out golden-report.json  # also write the full report as JSON
 *   npm run golden -- path/to/set.json --tolerance 0 --min-agreement 0.8
 *
 * Reads apps/api/.env for LLM_PROVIDER and the model settings, like the API does. Needs no
 * database and no running API, only the model (Ollama by default).
 *
 * Exit code: 0 when every pair was scored (and, with --min-agreement, the rate reached it);
 * 1 when a pair could not be scored or the rate is below --min-agreement; 2 on bad input.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createLlmProvider } from '../llm/llm.provider';
import { loadFewShotExamples } from '../llm/prompt';
import { CAD_TASK_AUTHOR_CRITERIA, CAD_TASK_AUTHOR_POSTING, postingText } from '../posting';
import { DEFAULT_TOLERANCE, GoldenSetError, PairResult, parseGoldenSet, runGolden, summarise } from './golden-eval';

const API_ROOT = resolve(__dirname, '..', '..', '..');

interface Args {
  file: string;
  out?: string;
  tolerance: number;
  minAgreement?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: resolve(API_ROOT, 'prisma', 'golden-set.json'), tolerance: DEFAULT_TOLERANCE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new GoldenSetError(`${a} needs a value`);
      return v;
    };
    if (a === '--out') args.out = resolve(value());
    else if (a === '--tolerance') args.tolerance = Number(value());
    else if (a === '--min-agreement') args.minAgreement = Number(value());
    else if (a.startsWith('--')) throw new GoldenSetError(`unknown option ${a}`);
    else args.file = resolve(a);
  }
  if (!Number.isInteger(args.tolerance) || args.tolerance < 0 || args.tolerance > 5) {
    throw new GoldenSetError('--tolerance must be a whole number from 0 to 5');
  }
  if (args.minAgreement !== undefined && !(args.minAgreement >= 0 && args.minAgreement <= 1)) {
    throw new GoldenSetError('--min-agreement must be a number from 0 to 1');
  }
  return args;
}

const pct = (x: number | null) => (x === null ? '  n/a' : `${(x * 100).toFixed(0).padStart(4)}%`);

function line(r: PairResult, i: number, total: number): string {
  const n = `[${String(i + 1).padStart(2)}/${total}]`;
  const verdict = r.status.toUpperCase().padEnd(5);
  const leak = r.leak ? `  LEAK ${r.overlap.toFixed(2)} vs ${r.overlapExampleId}` : '';
  if (r.status === 'error') return `${n} ${r.id}  ${verdict} ${r.error}${leak}`;
  const scores = r.criteria
    .map((c) => `${c.criterionId} ${c.agent ?? '-'}/${c.gold}${c.agrees ? ' ' : '*'}`)
    .join('  ');
  const route = `route ${r.agentNeedsReview ? 'human' : 'auto '}/${r.goldNeedsReview ? 'human' : 'auto '}`;
  return `${n} ${r.id}  ${verdict} ${scores}  ${route}  ${(r.latencyMs / 1000).toFixed(1)}s${leak}`;
}

async function main(): Promise<number> {
  let args: Args;
  let raw: string;
  let pairs;
  try {
    args = parseArgs(process.argv.slice(2));
    raw = readFileSync(args.file, 'utf8');
    pairs = parseGoldenSet(JSON.parse(raw), CAD_TASK_AUTHOR_CRITERIA, CAD_TASK_AUTHOR_POSTING.title);
  } catch (err) {
    console.error(`golden: ${(err as Error).message}`);
    return 2;
  }

  const envFile = resolve(API_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const provider = createLlmProvider();
  const examples = loadFewShotExamples().map((e) => ({ id: e.id, cv: e.cv }));

  console.log(`Golden set  ${args.file} (${pairs.length} pairs)`);
  console.log(`Scorer      ${provider.promptVersion}`);
  console.log(`Rule        a criterion agrees when |agent - gold| <= ${args.tolerance}; a pair passes when all agree`);
  console.log(`Columns     criterion agent/gold (* = outside tolerance), route agent/gold\n`);

  const results = await runGolden(pairs, provider, {
    criteria: CAD_TASK_AUTHOR_CRITERIA,
    postingText: postingText(CAD_TASK_AUTHOR_POSTING),
    examples,
    tolerance: args.tolerance,
    onResult: (r, i, total) => console.log(line(r, i, total)),
  });
  const summary = summarise(results, args.tolerance);

  console.log('');
  console.log(`Agreement   ${summary.passed}/${summary.pairs} pairs pass = ${pct(summary.agreementRate).trim()}` +
    (summary.errors ? `  (${summary.errors} not scored, counted as failures)` : ''));
  if (summary.clean.excluded.length) {
    console.log(`Without     ${summary.clean.excluded.join(', ')} (overlap a few-shot example): ` +
      `${summary.clean.passed}/${summary.clean.pairs} = ${pct(summary.clean.agreementRate).trim()}`);
  }
  console.log(`Routing     agent and gold agree on human review for ${pct(summary.routingAgreement).trim()} of scored pairs`);
  console.log('Criterion   exact  within  MAE   bias');
  for (const c of summary.perCriterion) {
    const f = (x: number | null) => (x === null ? ' n/a ' : x.toFixed(2).padStart(5));
    console.log(`  ${c.criterionId.padEnd(9)} ${pct(c.exactRate)}  ${pct(c.withinToleranceRate)}  ${f(c.meanAbsError)} ${f(c.bias)}`);
  }

  if (args.out) {
    const report = {
      generatedAt: new Date().toISOString(),
      goldenSet: { file: args.file, sha256: createHash('sha256').update(raw).digest('hex'), pairs: pairs.length },
      scorer: { provider: provider.name, promptVersion: provider.promptVersion },
      summary,
      results,
    };
    writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nReport      ${args.out}`);
  }

  if (summary.errors > 0) return 1;
  if (args.minAgreement !== undefined && summary.agreementRate < args.minAgreement) {
    console.log(`\nBelow --min-agreement ${args.minAgreement}`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
