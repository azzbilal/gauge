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
 * Where in this reviewer's queue a gold review is due (pipeline.md §3), or null when none is.
 *
 * The reviewer's reviews are counted in blocks of 1 / GOLD_QUEUE_SHARE (five), and each block
 * owes one gold review. The point inside the block where it falls is derived from the reviewer
 * and the block number, so it differs between reviewers and from block to block. The answer
 * is how many queue rows should come before the gold one: the reviews left until that point,
 * or 0 when the point has passed or the reviewer is behind (no gold was available earlier, or
 * an earlier gold was not reviewed in its block).
 *
 * The gold clone is written with an id whose hash lands at that place (see placeInQueue), so a
 * reviewer who works the queue from the head meets it at the due point whatever the backlog,
 * and the realised gold share is one in five.
 */
export function goldPlace(
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

/** Is a gold review owed in this reviewer's current block? See goldPlace. */
export function goldDue(reviewerId: string, totalReviews: number, goldReviews: number): boolean {
  return goldPlace(reviewerId, totalReviews, goldReviews) !== null;
}

/**
 * A reviewer's work queue: every task they may act on in one shared order, a hash of the
 * task id, that ignores age.
 *
 * Task ids are cuids that carry their creation time, and the plain list is newest first, so
 * an age-ordered queue would let a row that does not fit its place stand out. Ordered by id
 * hash, no row's place says anything about how old it is, and a task added later (a newly
 * written one, or a gold clone, which is the same thing to the reader) slots in at its own
 * hash without moving any other row against its neighbours. A gold clone's id is drawn so its
 * hash lands where the gold review is due (goldPlace, placeInQueue).
 *
 * The order is the same for every reviewer and does not move between reviews:
 *  - Redrawing it after each review leaves any row that keeps its place standing out.
 *  - A different order per reviewer sends the two reviewers of a task to different tasks,
 *    so second reviews, and with them decisions, come far later.
 * The cost is that old work is not drained first, and a task whose hash sorts late waits
 * behind every task that sorts earlier for as long as new work keeps arriving.
 */
export function buildQueue<T extends { id: string }>(tasks: T[]): T[] {
  const key = (t: T) => stableHash(t.id);
  return [...tasks].sort((a, b) => key(a) - key(b) || (a.id < b.id ? -1 : 1));
}

/** Ids drawn per placement before settling for an earlier place (see placeInQueue). */
export const PLACE_TRIES = 200_000;

/**
 * An id for a new row that buildQueue puts at `place` in `queue` (a list already in buildQueue
 * order): `mint` draws candidate ids, and the first whose hash falls between the rows at
 * place - 1 and place is taken. Nothing else moves; the new row just has that hash, like any
 * newly written task whose id happened to land there.
 *
 * The chance of a hit per draw is about 1 / queue length, so a large backlog needs many draws.
 * After `tries` misses it settles for the first draw that landed earlier than `place`, and
 * failing that the last draw: earlier is still inside the reviewer's block.
 */
export function placeInQueue(
  queue: Array<{ id: string }>,
  place: number,
  mint: () => string,
  tries = PLACE_TRIES,
): string {
  const at = Math.max(0, Math.min(place, queue.length));
  const before = at > 0 ? queue[at - 1].id : null;
  const after = at < queue.length ? queue[at].id : null;
  const lo = before === null ? -1 : stableHash(before);
  const hi = after === null ? 2 ** 32 : stableHash(after);
  let earlier: string | null = null;
  let id = mint();
  for (let i = 0; i < tries; i++, id = mint()) {
    const h = stableHash(id);
    if (h > lo && h < hi) return id;
    if (earlier === null && h < hi) earlier = id;
  }
  return earlier ?? id;
}

/** A user as the adjudication rule reads them. `role` is the Prisma `Role` value. */
export interface Adjudicator {
  expertId: string;
  role: string;
  isLead: boolean;
}

/** The task as the adjudication rule reads it: who wrote it, who reviewed it. */
export interface AdjudicationSubject {
  authorId: string;
  reviewerExpertIds: Array<string | null>;
}

export type AdjudicationConflict = 'author' | 'reviewer';

export type AdjudicationRight =
  | { allowed: true; conflict: AdjudicationConflict | null }
  | { allowed: false; why: 'not_eligible' | 'conflicted' | 'independent_available' };

/** May this user adjudicate splits at all: the adjudicator or admin role, or the lead. */
export function mayAdjudicate(user: Pick<Adjudicator, 'role' | 'isLead'>): boolean {
  return user.role === 'ADJUDICATOR' || user.role === 'ADMIN' || user.isLead;
}

/** Is this expert the task's author or one of its reviewers? */
export function adjudicationConflict(
  expertId: string,
  task: AdjudicationSubject,
): AdjudicationConflict | null {
  if (task.authorId === expertId) return 'author';
  if (task.reviewerExpertIds.some((id) => id !== null && id === expertId)) return 'reviewer';
  return null;
}

/**
 * Who may resolve a split (docs/pipeline.md §2.1). Normally a third expert, neither the
 * author nor either reviewer. A small team may have nobody like that, which would leave the
 * task IN_REVIEW for ever, so the designated lead or an admin may adjudicate a task they wrote
 * or reviewed, but only while nobody in `pool` (everyone who may adjudicate) is independent
 * of it. A conflicted adjudication is allowed for the escape alone, never as a shortcut.
 */
export function adjudicationRight(
  user: Adjudicator,
  task: AdjudicationSubject,
  pool: Adjudicator[],
): AdjudicationRight {
  if (!mayAdjudicate(user)) return { allowed: false, why: 'not_eligible' };
  const conflict = adjudicationConflict(user.expertId, task);
  if (conflict === null) return { allowed: true, conflict: null };
  if (user.role !== 'ADMIN' && !user.isLead) return { allowed: false, why: 'conflicted' };
  const independent = pool.some(
    (p) => mayAdjudicate(p) && adjudicationConflict(p.expertId, task) === null,
  );
  return independent ? { allowed: false, why: 'independent_available' } : { allowed: true, conflict };
}

/**
 * The gold task to clone for this reviewer now, or null when none is due or none is left.
 * `gold` is the gold tasks this reviewer may still review. Where the clone goes is goldPlace.
 */
export function dueGold<T extends { id: string }>(
  reviewerId: string,
  gold: T[],
  totalReviews: number,
  goldReviews: number,
): T | null {
  if (gold.length === 0 || !goldDue(reviewerId, totalReviews, goldReviews)) return null;
  return goldOrder(reviewerId, gold)[0];
}

/** Order gold candidates differently for each reviewer, but stably. */
export function goldOrder<T extends { id: string }>(reviewerId: string, gold: T[]): T[] {
  return [...gold].sort(
    (a, b) => stableHash(`${reviewerId}:${a.id}`) - stableHash(`${reviewerId}:${b.id}`),
  );
}

/**
 * FNV-1a, then the murmur3 finaliser: a small, stable, non-cryptographic string hash. FNV-1a
 * alone mixes the last characters weakly, so ids that differ only at the end (`t1`, `t2`)
 * would sort in runs; the finaliser spreads them.
 */
function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
