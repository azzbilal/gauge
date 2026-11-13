import { describe, expect, it } from 'vitest';
import {
  CRITERIA,
  GOLD_MIN_REVIEWS,
  IAA_MIN_PAIRS,
  agreementReport,
  agreementStat,
  buildQueue,
  calibrationReport,
  CalibrationInput,
  consensus,
  goldDue,
  goldOrder,
  goldSlot,
  isAccepted,
  krippendorffAlpha,
  Scores,
} from './review-protocol';

// Expected values below come from docs/pipeline.md (§2, §2.1, §3, §4) and from working the
// textbook formulas by hand, not from running the code.

/** A score sheet with every criterion at `base`, then the given overrides. */
function scores(base: number, overrides: Scores = {}): Scores {
  const s: Scores = {};
  for (const c of CRITERIA) s[c] = base;
  return { ...s, ...overrides };
}

/** n copies of a pair. */
function repeat(pair: [number, number], n: number): Array<[number, number]> {
  return Array.from({ length: n }, () => [pair[0], pair[1]] as [number, number]);
}

describe('isAccepted (pipeline.md §2 acceptance bar)', () => {
  it('accepts when every criterion is >= 3 and verifiable is >= 4', () => {
    expect(isAccepted(scores(3, { verifiable: 4 }))).toBe(true);
    expect(isAccepted(scores(5))).toBe(true);
  });

  it('rejects when verifiable is 3, even though 3 clears the general bar', () => {
    expect(isAccepted(scores(3))).toBe(false);
    expect(isAccepted(scores(5, { verifiable: 3 }))).toBe(false);
  });

  it('rejects when any single criterion is below 3', () => {
    for (const c of CRITERIA) {
      expect(isAccepted(scores(5, { [c]: 2 }))).toBe(false);
    }
  });

  it('treats a missing criterion as a failing score', () => {
    const s = scores(5);
    delete s['difficulty'];
    expect(isAccepted(s)).toBe(false);
    expect(isAccepted({})).toBe(false);
  });
});

describe('consensus (pipeline.md §2.1: two reviews, split goes to adjudication)', () => {
  it('is pending with fewer than two verdicts', () => {
    expect(consensus([])).toBe('pending');
    expect(consensus([true])).toBe('pending');
    expect(consensus([false])).toBe('pending');
  });

  it('decides when both reviewers agree', () => {
    expect(consensus([true, true])).toBe('accepted');
    expect(consensus([false, false])).toBe('rejected');
  });

  it('is split (adjudication) when the verdicts differ, in either order', () => {
    expect(consensus([true, false])).toBe('split');
    expect(consensus([false, true])).toBe('split');
  });
});

describe('krippendorffAlpha (interval metric, two ratings per unit)', () => {
  it('is null with no pairs', () => {
    expect(krippendorffAlpha([])).toBeNull();
  });

  it('is null when every value is identical (no variance)', () => {
    expect(krippendorffAlpha([[3, 3]])).toBeNull();
    expect(krippendorffAlpha(repeat([4, 4], 12))).toBeNull();
  });

  it('is 1 for perfect agreement with variance between units', () => {
    expect(krippendorffAlpha([[1, 1], [3, 3], [5, 5]])).toBeCloseTo(1, 10);
  });

  it('matches the textbook interval value on a small example', () => {
    // Units (1,2) and (3,4). Pooled values 1,2,3,4 (n = 4).
    //   Do = (1/n) * sum of within-unit ordered-pair squared differences = (1+1+1+1)/4 = 1
    //   De = 1/(n(n-1)) * sum over all ordered pairs of values of squared differences
    //      = 2 * (1+4+9+1+4+1) / 12 = 40/12
    //   alpha = 1 - Do/De = 1 - 12/40 = 0.7
    expect(krippendorffAlpha([[1, 2], [3, 4]])).toBeCloseTo(0.7, 10);
  });

  it('goes negative for systematic disagreement', () => {
    // Pooled values 1,2,2,1 (n = 4): Do = 4/4 = 1.
    // De: 2*2*2 = 8 ordered pairs of unequal values, each squared difference 1 -> 8/12 = 2/3.
    // alpha = 1 - 1/(2/3) = -0.5
    expect(krippendorffAlpha([[1, 2], [2, 1]])).toBeCloseTo(-0.5, 10);
  });

  it('equals the nominal alpha on a 0/1 variable', () => {
    // Units (1,1), (0,0), (1,0). Pooled: three 1s, three 0s (n = 6).
    //   Do (nominal) = mismatching within-unit ordered pairs / n = 2/6 = 1/3
    //   De (nominal) = n1*n0*2 / (n(n-1)) = 18/30 = 0.6
    //   alpha = 1 - (1/3)/0.6 = 4/9
    expect(krippendorffAlpha([[1, 1], [0, 0], [1, 0]])).toBeCloseTo(4 / 9, 10);
  });
});

describe('agreementStat (pipeline.md §4: low under 0.7, needs 10 pairs)', () => {
  it('reports insufficient data with no pairs', () => {
    expect(agreementStat([])).toEqual({
      pairs: 0,
      alpha: null,
      exactAgreement: null,
      within1Agreement: null,
      meanAbsDiff: null,
      flag: 'insufficient_data',
    });
  });

  it('reports insufficient data below the minimum pair count, even when alpha is low', () => {
    // Nine pairs of total disagreement: alpha is negative, but nine is under the minimum.
    const pairs = repeat([1, 5], 4).concat(repeat([5, 1], 5));
    const stat = agreementStat(pairs);
    expect(stat.alpha).not.toBeNull();
    expect(stat.alpha!).toBeLessThan(0);
    expect(stat.pairs).toBe(IAA_MIN_PAIRS - 1);
    expect(stat.flag).toBe('insufficient_data');
  });

  it('flags low agreement once there are enough pairs', () => {
    // Five (1,2) and five (3,4): Do = 1. Pooled values: five each of 1,2,3,4 (n = 20).
    // Sum of squared differences over unordered pairs of distinct values, weighted by
    // 5*5 per value pair: 25 * (1+4+9+1+4+1) = 500; ordered = 1000; De = 1000/380.
    // alpha = 1 - 380/1000 = 0.62 -> low.
    const pairs = repeat([1, 2], 5).concat(repeat([3, 4], 5));
    const stat = agreementStat(pairs);
    expect(stat.pairs).toBe(10);
    expect(stat.alpha).toBe(0.62);
    expect(stat.flag).toBe('low');
    expect(stat.exactAgreement).toBe(0);
    expect(stat.within1Agreement).toBe(1);
    expect(stat.meanAbsDiff).toBe(1);
  });

  it('is ok above the threshold', () => {
    // Perfect agreement with variance: alpha = 1.
    const pairs = repeat([2, 2], 5).concat(repeat([5, 5], 5));
    const stat = agreementStat(pairs);
    expect(stat.alpha).toBe(1);
    expect(stat.flag).toBe('ok');
    expect(stat.exactAgreement).toBe(1);
    expect(stat.meanAbsDiff).toBe(0);
  });

  it('treats identical values everywhere (alpha undefined) as ok, not low', () => {
    const stat = agreementStat(repeat([4, 4], IAA_MIN_PAIRS));
    expect(stat.alpha).toBeNull();
    expect(stat.flag).toBe('ok');
    expect(stat.exactAgreement).toBe(1);
  });

  it('rounds the shares to three decimals', () => {
    // Diffs 0, 1, 2: exact 1/3, within-1 2/3, mean 1.
    const stat = agreementStat([[3, 3], [3, 4], [3, 5]]);
    expect(stat.exactAgreement).toBe(0.333);
    expect(stat.within1Agreement).toBe(0.667);
    expect(stat.meanAbsDiff).toBe(1);
  });
});

describe('agreementReport', () => {
  const accept = scores(4);
  const reject = scores(4, { verifiable: 3 });

  it('reports every criterion, in rubric order, plus the verdict', () => {
    const report = agreementReport([[accept, accept]]);
    expect(report.statistic).toBe('krippendorff_alpha_interval');
    expect(report.threshold).toBe(0.7);
    expect(report.minPairs).toBe(10);
    expect(report.criteria.map((c) => c.criterion)).toEqual([...CRITERIA]);
  });

  it('scores the verdict the rubric derives, not a field of the review', () => {
    // Verdict pairs: (1,1), (0,0), (1,0) -> the 0/1 example above: alpha = 4/9 -> 0.444.
    const report = agreementReport([
      [accept, accept],
      [reject, reject],
      [accept, reject],
    ]);
    expect(report.verdict.pairs).toBe(3);
    expect(report.verdict.alpha).toBe(0.444);
    expect(report.verdict.exactAgreement).toBe(0.667);
  });

  it('feeds each criterion its own score pairs', () => {
    const report = agreementReport([
      [scores(4, { unambiguous: 1 }), scores(4, { unambiguous: 2 })],
      [scores(4, { unambiguous: 3 }), scores(4, { unambiguous: 4 })],
    ]);
    const unambiguous = report.criteria.find((c) => c.criterion === 'unambiguous')!;
    expect(unambiguous.alpha).toBe(0.7);
    expect(unambiguous.meanAbsDiff).toBe(1);
    const difficulty = report.criteria.find((c) => c.criterion === 'difficulty')!;
    expect(difficulty.alpha).toBeNull();
    expect(difficulty.exactAgreement).toBe(1);
  });

  it('leaves out a pair where either review lacks the criterion', () => {
    const partial = scores(4);
    delete partial['difficulty'];
    const report = agreementReport([
      [partial, accept],
      [accept, accept],
    ]);
    expect(report.criteria.find((c) => c.criterion === 'difficulty')!.pairs).toBe(1);
    expect(report.criteria.find((c) => c.criterion === 'verifiable')!.pairs).toBe(2);
  });
});

describe('calibrationReport (pipeline.md §3: flag below 0.8 once 5 gold reviews)', () => {
  const gold = (reviewerId: string, accepted: boolean, expected: boolean): CalibrationInput => ({
    reviewerId,
    accepted,
    goldExpectedAccept: expected,
  });
  const normal = (reviewerId: string, accepted = true): CalibrationInput => ({
    reviewerId,
    accepted,
    goldExpectedAccept: null,
  });

  it('counts correct answers, false accepts and false rejects', () => {
    const [row] = calibrationReport([
      gold('r1', true, true), // correct
      gold('r1', false, false), // correct
      gold('r1', true, false), // false accept: passed a broken gold task
      gold('r1', false, true), // false reject: failed a good gold task
      normal('r1'),
    ]);
    expect(row).toMatchObject({
      reviewerId: 'r1',
      totalReviews: 5,
      goldReviews: 4,
      correct: 2,
      falseAccepts: 1,
      falseRejects: 1,
      goldShare: 0.8,
      accuracy: 0.5,
    });
  });

  it('has no accuracy and no flag for a reviewer without gold reviews', () => {
    const [row] = calibrationReport([normal('r1'), normal('r1', false)]);
    expect(row.goldReviews).toBe(0);
    expect(row.goldShare).toBe(0);
    expect(row.accuracy).toBeNull();
    expect(row.flag).toBe('insufficient_data');
  });

  it('does not flag before the minimum number of gold reviews, however bad', () => {
    const reviews = Array.from({ length: GOLD_MIN_REVIEWS - 1 }, () => gold('r1', true, false));
    const [row] = calibrationReport(reviews);
    expect(row.accuracy).toBe(0);
    expect(row.flag).toBe('insufficient_data');
  });

  it('flags below 0.8 and passes at exactly 0.8', () => {
    // 4 of 5 correct = 0.8 -> ok; 3 of 5 = 0.6 -> low.
    const ok = [...Array(4)].map(() => gold('ok', true, true)).concat(gold('ok', true, false));
    const low = [...Array(3)]
      .map(() => gold('low', true, true))
      .concat(gold('low', true, false), gold('low', false, true));
    const rows = calibrationReport([...ok, ...low]);
    expect(rows.find((r) => r.reviewerId === 'ok')).toMatchObject({ accuracy: 0.8, flag: 'ok' });
    expect(rows.find((r) => r.reviewerId === 'low')).toMatchObject({ accuracy: 0.6, flag: 'low' });
  });

  it('keeps one row per reviewer, in order of first appearance', () => {
    const rows = calibrationReport([normal('b'), normal('a'), normal('b')]);
    expect(rows.map((r) => [r.reviewerId, r.totalReviews])).toEqual([
      ['b', 2],
      ['a', 1],
    ]);
  });

  it('rounds the gold share to three decimals', () => {
    const [row] = calibrationReport([gold('r', true, true), normal('r'), normal('r')]);
    expect(row.goldShare).toBe(0.333);
  });
});

describe('goldDue (pipeline.md §3: ~20% of the queue is gold)', () => {
  /** Walk a reviewer through n reviews, taking gold whenever it is due. */
  function simulate(reviewerId: string, n: number): boolean[] {
    const taken: boolean[] = [];
    let gold = 0;
    for (let total = 0; total < n; total++) {
      const due = goldDue(reviewerId, total, gold);
      if (due) gold += 1;
      taken.push(due);
    }
    return taken;
  }

  it('gives exactly one gold review in every block of five', () => {
    for (const reviewer of ['alice', 'bob', 'carol', 'r-123', '']) {
      const taken = simulate(reviewer, 50);
      for (let block = 0; block < 10; block++) {
        expect(taken.slice(block * 5, block * 5 + 5).filter(Boolean)).toHaveLength(1);
      }
    }
  });

  it('is deterministic for the same reviewer', () => {
    expect(simulate('alice', 40)).toEqual(simulate('alice', 40));
  });

  it('puts the gold slot in different places for different reviewers', () => {
    const slots = (r: string) => simulate(r, 50).flatMap((t, i) => (t ? [i % 5] : []));
    const patterns = new Set(
      ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'].map((r) => slots(r).join(',')),
    );
    expect(patterns.size).toBeGreaterThan(1);
  });

  it('catches up first when the reviewer is behind on gold', () => {
    // Ten reviews done (two blocks) but no gold yet: due regardless of slot.
    expect(goldDue('alice', 10, 0)).toBe(true);
    expect(goldDue('alice', 10, 1)).toBe(true);
  });

  it('is not due once this block already had its gold review', () => {
    expect(goldDue('alice', 7, 2)).toBe(false);
    expect(goldDue('alice', 0, 1)).toBe(false);
  });
});

describe('goldOrder', () => {
  const gold = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((id) => ({ id }));

  it('returns a permutation and does not mutate the input', () => {
    const before = gold.map((g) => g.id);
    const ordered = goldOrder('alice', gold);
    expect(ordered.map((g) => g.id).sort()).toEqual(before);
    expect(gold.map((g) => g.id)).toEqual(before);
  });

  it('is stable for one reviewer and differs between reviewers', () => {
    const ids = (r: string) => goldOrder(r, gold).map((g) => g.id).join(',');
    expect(ids('alice')).toBe(ids('alice'));
    const orders = new Set(['alice', 'bob', 'carol', 'dave'].map(ids));
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('goldSlot / buildQueue (gold is not always at the head of the queue)', () => {
  type Row = { id: string; createdAt: number; gold?: boolean };

  /**
   * A reviewer who always takes the head of the queue, against a backlog of regular
   * tasks (oldest first) and a gold pool. Returns, per review, the gold task's index in
   * the queue they were shown (-1 when there was none) and whether they took gold.
   */
  function walk(reviewerId: string, n: number) {
    let regular: Row[] = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, createdAt: i }));
    let gold: Row[] = Array.from({ length: 50 }, (_, i) => ({
      id: `g${i}`,
      createdAt: -1000 + i, // gold is the oldest work in the system
      gold: true,
    }));
    const steps: Array<{ goldIndex: number; tookGold: boolean; queue: Row[] }> = [];
    let total = 0;
    let goldDone = 0;
    for (let step = 0; step < n; step++) {
      const queue = buildQueue(reviewerId, regular, goldOrder(reviewerId, gold), total, goldDone);
      // Same history, same queue: no jumping around on a refetch.
      expect(buildQueue(reviewerId, regular, goldOrder(reviewerId, gold), total, goldDone)).toEqual(
        queue,
      );
      const head = queue[0];
      steps.push({ goldIndex: queue.findIndex((t) => t.gold), tookGold: !!head.gold, queue });
      total += 1;
      if (head.gold) {
        goldDone += 1;
        gold = gold.filter((t) => t.id !== head.id);
      } else {
        regular = regular.filter((t) => t.id !== head.id);
      }
    }
    return steps;
  }

  it('keeps exactly one gold review in every block of five for a head-taking reviewer', () => {
    for (const reviewer of ['alice', 'bob', 'carol', 'r-123', '']) {
      const steps = walk(reviewer, 50);
      for (let block = 0; block < 10; block++) {
        const taken = steps.slice(block * 5, block * 5 + 5).filter((s) => s.tookGold);
        expect(taken).toHaveLength(1);
      }
    }
  });

  it('takes gold at the same points goldDue does', () => {
    for (const reviewer of ['alice', 'bob', 'carol']) {
      let total = 0;
      let gold = 0;
      for (const s of walk(reviewer, 40)) {
        expect(s.tookGold).toBe(goldDue(reviewer, total, gold));
        total += 1;
        if (s.tookGold) gold += 1;
      }
    }
  });

  it('does not always put the gold task at the head', () => {
    const indexes = new Set(
      ['alice', 'bob', 'carol', 'dave']
        .flatMap((r) => walk(r, 40))
        .map((s) => s.goldIndex)
        .filter((i) => i >= 0),
    );
    expect(indexes.has(0)).toBe(true);
    expect([...indexes].some((i) => i > 0)).toBe(true);
    // It only ever sits in the head of the queue, so it is reached within the block.
    expect(Math.max(...indexes)).toBeLessThan(5);
  });

  it('makes the gold task not the only row out of age order', () => {
    // When gold is shown away from the head, regular rows around it are out of order too.
    const shown = ['alice', 'bob', 'carol', 'dave']
      .flatMap((r) => walk(r, 40))
      .filter((s) => s.goldIndex > 0);
    expect(shown.length).toBeGreaterThan(0);
    const regularOutOfOrder = shown.filter((s) => {
      const regular = s.queue.filter((t) => !t.gold);
      return regular.some((t, i) => i > 0 && t.createdAt < regular[i - 1].createdAt);
    });
    expect(regularOutOfOrder.length).toBeGreaterThan(0);
  });

  it('does not leave an old task stuck in the head while newer ones pass it', () => {
    // A head-taking reviewer works 150 reviews into a 200-task backlog. A fixed per-task
    // order would keep the unluckiest tasks in the head for good; a redrawn one takes each
    // head task with odds of about one in five per review.
    for (const reviewer of ['alice', 'bob', 'carol']) {
      const since = new Map<string, number>();
      let longest = 0;
      walk(reviewer, 150).forEach((s, step) => {
        const head = s.queue.slice(0, 6).filter((t) => !t.gold);
        for (const t of head) {
          if (!since.has(t.id)) since.set(t.id, step);
          longest = Math.max(longest, step - (since.get(t.id) as number));
        }
      });
      expect(longest).toBeLessThan(60);
    }
  });

  it('keeps the queue oldest first beyond the head', () => {
    const regular: Row[] = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, createdAt: i }));
    const queue = buildQueue('alice', regular, [], 0, 0);
    expect(queue.slice(5).map((t) => t.createdAt)).toEqual([...Array(15).keys()].map((i) => i + 5));
    expect(queue.slice(0, 5).map((t) => t.createdAt).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('serves no gold once the block has had its gold, and gold first when behind', () => {
    expect(goldSlot('alice', 7, 2)).toBeNull();
    expect(goldSlot('alice', 10, 0)).toBe(0);
    const regular: Row[] = [{ id: 't0', createdAt: 0 }];
    const g: Row = { id: 'g0', createdAt: -1, gold: true };
    expect(buildQueue('alice', regular, [g], 7, 2)).toEqual(regular);
    expect(buildQueue('alice', regular, [g], 10, 0)[0]).toBe(g);
    // A short queue still gets the gold task, at its end at worst.
    expect(buildQueue('alice', [], [g], 0, 0)).toEqual([g]);
  });
});
