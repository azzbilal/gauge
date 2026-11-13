/**
 * The task-review protocol as pure functions (docs/pipeline.md §2.1, §3, §4).
 * No database, no framework: everything here is decided from plain values, so the
 * rules live in one place and can be checked without a running API.
 */

// Must match docs/pipeline.md §2.
export const CRITERIA = [
  'verifiable',
  'unambiguous',
  'correct_reference',
  'complete_constraints',
  'difficulty',
] as const;
export type Criterion = (typeof CRITERIA)[number];
export type Scores = Record<string, number>;

// Acceptance bar (docs/pipeline.md §2): every criterion >= 3, and verifiable >= 4.
export const ACCEPTANCE_MIN = 3;
export const VERIFIABLE_MIN = 4;

/** Two reviewers per task (docs/pipeline.md §2). */
export const REVIEWS_REQUIRED = 2;

/** Agreement below this on a criterion is "low IAA" (docs/pipeline.md §6). */
export const IAA_THRESHOLD = 0.7;
/** Below this many doubly-reviewed tasks the statistic is too noisy to flag on. */
export const IAA_MIN_PAIRS = 10;

/** Gold tasks are mixed into the review queue at ~20% (docs/pipeline.md §3). */
export const GOLD_QUEUE_SHARE = 0.2;
/** Reviews per gold review: the block size behind the one-in-five rate. */
const GOLD_BLOCK = Math.round(1 / GOLD_QUEUE_SHARE);
/** A reviewer under this gold accuracy is flagged for recalibration. */
export const GOLD_ACCURACY_MIN = 0.8;
/** Gold reviews needed before a reviewer can be flagged at all. */
export const GOLD_MIN_REVIEWS = 5;

/** The rubric decides acceptance, not the client. */
export function isAccepted(scores: Scores): boolean {
  return (
    CRITERIA.every((c) => (scores[c] ?? 0) >= ACCEPTANCE_MIN) &&
    (scores['verifiable'] ?? 0) >= VERIFIABLE_MIN
  );
}

// ---------------------------------------------------------------- consensus

export type Consensus = 'pending' | 'accepted' | 'rejected' | 'split';

/**
 * What the peer reviews so far decide.
 *   fewer than two -> pending;  both accept -> accepted;
 *   both reject    -> rejected; one each    -> split (goes to adjudication).
 */
export function consensus(verdicts: boolean[]): Consensus {
  if (verdicts.length < REVIEWS_REQUIRED) return 'pending';
  const [a, b] = verdicts;
  if (a !== b) return 'split';
  return a ? 'accepted' : 'rejected';
}

// ---------------------------------------------------------------- agreement

export type Flag = 'ok' | 'low' | 'insufficient_data';

export interface AgreementStat {
  /** Tasks with two reviews that this statistic was computed over. */
  pairs: number;
  /** Krippendorff's alpha, interval metric. Null when it is undefined (no variance). */
  alpha: number | null;
  /** Share of tasks where both reviewers gave the identical value. */
  exactAgreement: number | null;
  /** Share of tasks where the two values differ by at most 1. */
  within1Agreement: number | null;
  meanAbsDiff: number | null;
  flag: Flag;
}

/**
 * Krippendorff's alpha with the interval distance metric, for two ratings per unit.
 *
 *   alpha = 1 - Do / De
 *   Do = mean squared difference inside a pair   (observed disagreement)
 *   De = mean squared difference between any two of the pooled values (expected by chance)
 *
 * Chosen over Cohen's kappa because the two reviewers differ from task to task, and
 * over raw percent agreement because it corrects for chance. On a 0/1 variable the
 * interval metric is the nominal metric, so the same function scores the verdict.
 * Returns null when every value is identical: there is no variance to explain.
 */
export function krippendorffAlpha(pairs: Array<[number, number]>): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const total = 2 * n;
  let sum = 0;
  let sumSq = 0;
  let observed = 0;
  for (const [a, b] of pairs) {
    sum += a + b;
    sumSq += a * a + b * b;
    observed += (a - b) ** 2;
  }
  const Do = observed / n;
  // Sum over ordered pairs i != j of (vi - vj)^2 = 2N * sum(v^2) - 2 * sum(v)^2.
  const De = (2 * total * sumSq - 2 * sum * sum) / (total * (total - 1));
  if (De === 0) return null;
  return 1 - Do / De;
}

export function agreementStat(pairs: Array<[number, number]>): AgreementStat {
  const n = pairs.length;
  if (n === 0) {
    return {
      pairs: 0,
      alpha: null,
      exactAgreement: null,
      within1Agreement: null,
      meanAbsDiff: null,
      flag: 'insufficient_data',
    };
  }
  const diffs = pairs.map(([a, b]) => Math.abs(a - b));
  const alpha = krippendorffAlpha(pairs);
  let flag: Flag = 'ok';
  if (n < IAA_MIN_PAIRS) flag = 'insufficient_data';
  // alpha is null only when all values are identical, i.e. perfect agreement.
  else if (alpha !== null && alpha < IAA_THRESHOLD) flag = 'low';
  return {
    pairs: n,
    alpha: alpha === null ? null : round(alpha),
    exactAgreement: round(diffs.filter((d) => d === 0).length / n),
    within1Agreement: round(diffs.filter((d) => d <= 1).length / n),
    meanAbsDiff: round(diffs.reduce((s, d) => s + d, 0) / n),
    flag,
  };
}

/** One doubly-reviewed task: the two reviewers' rubric scores. */
export type ScorePair = [Scores, Scores];

export interface AgreementReport {
  statistic: 'krippendorff_alpha_interval';
  threshold: number;
  minPairs: number;
  /** Agreement on the accept / reject verdict the rubric derives from the scores. */
  verdict: AgreementStat;
  criteria: Array<{ criterion: Criterion } & AgreementStat>;
}

/** Inter-annotator agreement per criterion (docs/pipeline.md §4.4). */
export function agreementReport(pairs: ScorePair[]): AgreementReport {
  return {
    statistic: 'krippendorff_alpha_interval',
    threshold: IAA_THRESHOLD,
    minPairs: IAA_MIN_PAIRS,
    verdict: agreementStat(
      pairs.map(([a, b]) => [isAccepted(a) ? 1 : 0, isAccepted(b) ? 1 : 0] as [number, number]),
    ),
    criteria: CRITERIA.map((criterion) => ({
      criterion,
      ...agreementStat(
        pairs
          .filter(([a, b]) => typeof a[criterion] === 'number' && typeof b[criterion] === 'number')
          .map(([a, b]) => [a[criterion], b[criterion]] as [number, number]),
      ),
    })),
  };
}

// -------------------------------------------------------------- calibration

export interface ReviewerCalibration {
  reviewerId: string;
  totalReviews: number;
  goldReviews: number;
  /** Share of this reviewer's reviews that were gold; the target is GOLD_QUEUE_SHARE. */
  goldShare: number | null;
  correct: number;
  /** Accepted a deliberately broken gold task. */
  falseAccepts: number;
  /** Rejected a known-good gold task. */
  falseRejects: number;
  accuracy: number | null;
  /** 'low' means recalibrate, never auto-block: "flagged, not fired" (pipeline.md §3). */
  flag: Flag;
}

export interface CalibrationInput {
  reviewerId: string;
  accepted: boolean;
  /** The gold answer, or null when the reviewed task is not gold. */
  goldExpectedAccept: boolean | null;
}

/** Reviewer accuracy against the gold answers (docs/pipeline.md §3). */
export function calibrationReport(reviews: CalibrationInput[]): ReviewerCalibration[] {
  const byReviewer = new Map<string, ReviewerCalibration>();
  for (const r of reviews) {
    let row = byReviewer.get(r.reviewerId);
    if (!row) {
      row = {
        reviewerId: r.reviewerId,
        totalReviews: 0,
        goldReviews: 0,
        goldShare: null,
        correct: 0,
        falseAccepts: 0,
        falseRejects: 0,
        accuracy: null,
        flag: 'insufficient_data',
      };
      byReviewer.set(r.reviewerId, row);
    }
    row.totalReviews += 1;
    if (r.goldExpectedAccept === null) continue;
    row.goldReviews += 1;
    if (r.accepted === r.goldExpectedAccept) row.correct += 1;
    else if (r.accepted) row.falseAccepts += 1;
    else row.falseRejects += 1;
  }
  for (const row of byReviewer.values()) {
    row.goldShare = round(row.goldReviews / row.totalReviews);
    if (row.goldReviews > 0) row.accuracy = round(row.correct / row.goldReviews);
    if (row.goldReviews >= GOLD_MIN_REVIEWS) {
      row.flag = (row.accuracy ?? 0) < GOLD_ACCURACY_MIN ? 'low' : 'ok';
    }
  }
  return [...byReviewer.values()];
}

// -------------------------------------------------------------------- queue

/**
 * Should this reviewer's next task be a gold one?
 *
 * The queue is rebuilt after every review, so a fixed position in a list would
 * never be reached. The decision is driven by the reviewer's own history instead:
 * their reviews are counted in blocks of 1 / GOLD_QUEUE_SHARE (five), each block
 * owes one gold review, and the slot inside the block is derived from the reviewer
 * and the block number, so it differs between reviewers and from block to block.
 * A reviewer who is behind (no gold was available earlier) catches up first.
 */
export function goldDue(reviewerId: string, totalReviews: number, goldReviews: number): boolean {
  return goldSlot(reviewerId, totalReviews, goldReviews) === 0;
}

/**
 * Where in this reviewer's queue the current block's gold task sits, or null when the
 * block's gold review is already done.
 *
 * The index counts down as the reviewer works through the block: it starts at the
 * block's slot and reaches 0 exactly when `goldDue` says gold is due, so a reviewer who
 * always takes the head of the queue still reviews one gold task per five. A reviewer
 * who is behind gets it at the head. Being derived from the reviewer's history, not a
 * dice roll, the position is the same on every refetch until they review something.
 */
export function goldSlot(
  reviewerId: string,
  totalReviews: number,
  goldReviews: number,
): number | null {
  const blockIndex = Math.floor(totalReviews / GOLD_BLOCK);
  if (goldReviews > blockIndex) return null; // this block's gold is already done
  if (goldReviews < blockIndex) return 0; // behind on calibration
  const slot = stableHash(`${reviewerId}:${blockIndex}`) % GOLD_BLOCK;
  return Math.max(0, slot - (totalReviews % GOLD_BLOCK));
}

/**
 * A reviewer's work queue: regular tasks oldest first, with at most one gold task.
 *
 * Moving the gold task off the head is not enough on its own: in a strictly
 * chronological list, the one row whose `createdAt` is out of order would still be the
 * gold one. So the head of the queue — the first GOLD_BLOCK regular tasks, the only
 * stretch the gold task can land in — is put in a per-reviewer order rather than by age,
 * and out-of-order rows there are normal. Beyond the head the queue stays oldest first,
 * so old work is still drained first.
 *
 * `regular` must already be oldest first; `gold` is the candidates in serving order.
 */
export function buildQueue<T extends { id: string }>(
  reviewerId: string,
  regular: T[],
  gold: T[],
  totalReviews: number,
  goldReviews: number,
): T[] {
  // Salted with the review count: the order holds across refetches but is redrawn after
  // every review, so no old task sits in the head forever behind luckier ones, and the
  // gold row is not the only one that moves relative to its neighbours.
  const key = (t: T) => stableHash(`${reviewerId}:${totalReviews}:${t.id}`);
  const head = [...regular.slice(0, GOLD_BLOCK)].sort((a, b) => key(a) - key(b));
  const queue = [...head, ...regular.slice(GOLD_BLOCK)];
  const index = goldSlot(reviewerId, totalReviews, goldReviews);
  if (gold.length === 0 || index === null) return queue;
  queue.splice(Math.min(index, queue.length), 0, gold[0]);
  return queue;
}

/** Order gold candidates differently for each reviewer, but stably. */
export function goldOrder<T extends { id: string }>(reviewerId: string, gold: T[]): T[] {
  return [...gold].sort(
    (a, b) => stableHash(`${reviewerId}:${a.id}`) - stableHash(`${reviewerId}:${b.id}`),
  );
}

/** FNV-1a: a small, stable, non-cryptographic string hash. */
function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
