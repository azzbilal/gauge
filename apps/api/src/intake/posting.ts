import { RubricCriterion } from './llm/types';

/**
 * The one posting Gauge recruits for, and its intake rubric. `prisma/seed.ts` writes these
 * to the database; the golden-set harness (`intake/golden/`) scores against the same
 * definitions without a database, so the two can never drift apart.
 */
export const CAD_TASK_AUTHOR_CRITERIA: RubricCriterion[] = [
  {
    id: 'cad',
    label: 'CAD domain depth',
    description: 'Depth of experience with parametric CAD (FreeCAD, CadQuery, SolidWorks, etc.).',
    weight: 0.4,
  },
  {
    id: 'geo',
    label: 'Geometric reasoning',
    description: 'Ability to reason about geometry, constraints and dimensions.',
    weight: 0.3,
  },
  {
    id: 'code',
    label: 'Scripting ability',
    description: 'Ability to express CAD intent in code (Python, CadQuery, OpenSCAD).',
    weight: 0.2,
  },
  {
    id: 'comm',
    label: 'Clarity of communication',
    description: 'Clarity and precision when describing geometry and tasks.',
    weight: 0.1,
  },
];

export const CAD_TASK_AUTHOR_POSTING = {
  title: 'CAD Task Author (parametric modeling)',
  description:
    'We are hiring CAD experts to write precise, verifiable parametric-modeling tasks. ' +
    'You should be fluent in CadQuery or similar code-first CAD, comfortable reasoning ' +
    'about constraints and dimensions, and able to document a task so another engineer can solve it.',
};

/** The posting text the scorer reads, exactly as IntakeService builds it from a Posting row. */
export function postingText(posting: { title: string; description?: string | null }): string {
  return [posting.title, posting.description].filter(Boolean).join('\n');
}
