import { describe, expect, it, vi } from 'vitest';
import { CRITERIA } from '../campaign/review-protocol';
import {
  buildPacket,
  ExtractedRubricItem,
  Extraction,
  PacketRequirement,
  RequirementExtractor,
  rubricItemIdOf,
} from './packet-builder';
import { VerifyContractError, VerifyUnreachableError } from './verify.errors';

const R1: PacketRequirement = {
  id: 'req-1',
  text: 'plate is 80 x 60 x 10 mm',
  kind: 'box',
  value: '80x60x10',
  tolerance: '0.1',
};
const R2: PacketRequirement = {
  id: 'req-2',
  text: '4 holes of 6 mm',
  kind: 'hole',
  value: '6',
  tolerance: null,
};

/** One rubric item per criterion, in order; all manual unless overridden. */
function rubric(overrides: Partial<Record<string, Partial<ExtractedRubricItem>>> = {}) {
  return CRITERIA.map(
    (criterion, i): ExtractedRubricItem => ({
      id: `ri-${i + 1}`,
      criterion,
      text: `${criterion}: check`,
      checkMethod: 'manual',
      requirementIds: [],
      weight: 1,
      ...overrides[criterion],
    }),
  );
}

function extractor(extraction: Extraction) {
  const extract = vi.fn(async () => extraction);
  return { extract } satisfies RequirementExtractor;
}

describe('rubricItemIdOf', () => {
  it('strips the requirement suffix of an expanded packet item', () => {
    expect(rubricItemIdOf('ri-1:req-2')).toBe('ri-1');
  });

  it('leaves an unexpanded id alone', () => {
    expect(rubricItemIdOf('ri-3')).toBe('ri-3');
  });
});

describe('buildPacket requirement mapping', () => {
  const extraction: Extraction = {
    version: 'extract-7',
    requirements: [R1, R2],
    rubricItems: rubric({
      verifiable: { checkMethod: 'machine', requirementIds: ['req-1', 'req-2'], weight: 2 },
      correct_reference: { checkMethod: 'machine', requirementIds: ['req-2'], weight: 1.5 },
    }),
  };

  it('asks the extractor with the prompt and spec, and carries the version', async () => {
    const ex = extractor(extraction);
    const built = await buildPacket({ prompt: 'Make a plate', spec: 'spec text' }, ex);
    expect(ex.extract).toHaveBeenCalledWith({ prompt: 'Make a plate', spec: 'spec text' });
    expect(built.extractionVersion).toBe('extract-7');
    expect(built.requirements).toEqual([R1, R2]);
  });

  it('sends spec null to the extractor and empty strings in the packet when absent', async () => {
    const ex = extractor(extraction);
    const built = await buildPacket({ prompt: 'p', spec: null, reference: null }, ex);
    expect(ex.extract).toHaveBeenCalledWith({ prompt: 'p', spec: null });
    expect(built.packet.spec).toBe('');
    expect(built.packet.reference).toBe('');

    const built2 = await buildPacket({ prompt: 'p' }, extractor(extraction));
    expect(built2.packet.spec).toBe('');
    expect(built2.packet.reference).toBe('');
  });

  it('copies prompt, spec, reference and requirements into the packet', async () => {
    const built = await buildPacket(
      { prompt: 'p', spec: 's', reference: 'result = 1' },
      extractor(extraction),
    );
    expect(built.packet).toMatchObject({
      prompt: 'p',
      spec: 's',
      reference: 'result = 1',
      requirements: [R1, R2],
    });
  });

  it('stores one row per criterion, linking a single requirement and nulling several', async () => {
    const built = await buildPacket({ prompt: 'p' }, extractor(extraction));
    expect(built.rubricItems).toEqual([
      { id: 'ri-1', text: 'verifiable: check', requirementId: null, checkMethod: 'machine', weight: 2 },
      { id: 'ri-2', text: 'unambiguous: check', requirementId: null, checkMethod: 'manual', weight: 1 },
      {
        id: 'ri-3',
        text: 'correct_reference: check',
        requirementId: 'req-2',
        checkMethod: 'machine',
        weight: 1.5,
      },
      {
        id: 'ri-4',
        text: 'complete_constraints: check',
        requirementId: null,
        checkMethod: 'manual',
        weight: 1,
      },
      { id: 'ri-5', text: 'difficulty: check', requirementId: null, checkMethod: 'manual', weight: 1 },
    ]);
  });

  it('expands a machine item once per requirement, splitting its weight', async () => {
    const built = await buildPacket({ prompt: 'p' }, extractor(extraction));
    const items = built.packet.rubricItems;
    expect(items.map((i) => i.id)).toEqual([
      'ri-1:req-1',
      'ri-1:req-2',
      'ri-2',
      'ri-3:req-2',
      'ri-4',
      'ri-5',
    ]);

    const [v1, v2] = items;
    expect(v1).toMatchObject({
      text: 'verifiable: check (plate is 80 x 60 x 10 mm)',
      requirementId: 'req-1',
      checkMethod: 'machine',
    });
    expect(v2).toMatchObject({
      text: 'verifiable: check (4 holes of 6 mm)',
      requirementId: 'req-2',
      checkMethod: 'machine',
    });
    expect(v1.weight).toBeCloseTo(1, 10);
    expect(v2.weight).toBeCloseTo(1, 10);

    // A single-requirement machine item is still suffixed, with its weight whole.
    expect(items[3]).toMatchObject({
      text: 'correct_reference: check (4 holes of 6 mm)',
      requirementId: 'req-2',
      weight: 1.5,
    });

    // Every expanded id maps back to a stored row.
    const stored = new Set(built.rubricItems.map((i) => i.id));
    for (const item of items) expect(stored.has(rubricItemIdOf(item.id))).toBe(true);
  });

  it('passes manual items through unchanged', async () => {
    const built = await buildPacket({ prompt: 'p' }, extractor(extraction));
    const manualRows = built.rubricItems.filter((i) => i.checkMethod === 'manual');
    const manualPacket = built.packet.rubricItems.filter((i) => i.checkMethod === 'manual');
    expect(manualPacket).toEqual(manualRows);
  });

  it('keeps the total weight of each machine item across its expansion', async () => {
    const weights = new Map<string, number>();
    const built = await buildPacket({ prompt: 'p' }, extractor(extraction));
    for (const item of built.packet.rubricItems) {
      const id = rubricItemIdOf(item.id);
      weights.set(id, (weights.get(id) ?? 0) + item.weight);
    }
    for (const row of built.rubricItems) expect(weights.get(row.id)).toBeCloseTo(row.weight, 10);
  });

  it('accepts a task with no requirements when every item is manual', async () => {
    const built = await buildPacket(
      { prompt: 'p' },
      extractor({ version: 'v', requirements: [], rubricItems: rubric() }),
    );
    expect(built.requirements).toEqual([]);
    expect(built.packet.rubricItems).toEqual(built.rubricItems);
    expect(built.rubricItems.every((i) => i.requirementId === null)).toBe(true);
  });
});

describe('buildPacket contract errors', () => {
  async function rejection(extraction: Extraction) {
    return buildPacket({ prompt: 'p' }, extractor(extraction)).then(
      () => {
        throw new Error('expected buildPacket to reject');
      },
      (err: unknown) => err,
    );
  }

  it('rejects rubric items out of criterion order', async () => {
    const items = rubric();
    [items[0], items[1]] = [items[1], items[0]];
    const err = await rejection({ version: 'v', requirements: [], rubricItems: items });
    expect(err).toBeInstanceOf(VerifyContractError);
    expect((err as Error).message).toMatch(/expected \[verifiable, unambiguous/);
  });

  it('rejects a missing or an extra criterion', async () => {
    const short = rubric().slice(0, CRITERIA.length - 1);
    expect(await rejection({ version: 'v', requirements: [], rubricItems: short })).toBeInstanceOf(
      VerifyContractError,
    );
    const long = [...rubric(), { ...rubric()[0], id: 'ri-6' }];
    expect(await rejection({ version: 'v', requirements: [], rubricItems: long })).toBeInstanceOf(
      VerifyContractError,
    );
  });

  it('rejects an unknown criterion name', async () => {
    const items = rubric();
    items[4] = { ...items[4], criterion: 'appropriate_difficulty' };
    expect(await rejection({ version: 'v', requirements: [], rubricItems: items })).toBeInstanceOf(
      VerifyContractError,
    );
  });

  it('rejects a machine item with no requirements', async () => {
    const err = await rejection({
      version: 'v',
      requirements: [R1],
      rubricItems: rubric({ verifiable: { checkMethod: 'machine', requirementIds: [] } }),
    });
    expect(err).toBeInstanceOf(VerifyContractError);
    expect((err as Error).message).toMatch(/"verifiable"/);
  });

  it('rejects a machine item linked to a requirement the extraction does not contain', async () => {
    const err = await rejection({
      version: 'v',
      requirements: [R1],
      rubricItems: rubric({
        verifiable: { checkMethod: 'machine', requirementIds: ['req-1', 'req-missing'] },
      }),
    });
    expect(err).toBeInstanceOf(VerifyContractError);
  });

  it('does not check requirement links on a manual item', async () => {
    const built = await buildPacket(
      { prompt: 'p' },
      extractor({
        version: 'v',
        requirements: [],
        rubricItems: rubric({ unambiguous: { requirementIds: ['req-missing'] } }),
      }),
    );
    expect(built.rubricItems[1].requirementId).toBeNull();
  });

  it('propagates an extractor failure as is, without wrapping it', async () => {
    const outage = new VerifyUnreachableError('verify service down');
    const failing: RequirementExtractor = { extract: () => Promise.reject(outage) };
    await expect(buildPacket({ prompt: 'p' }, failing)).rejects.toBe(outage);
  });
});
