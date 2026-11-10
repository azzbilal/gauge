import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const criteria = [
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

  const rubric = await prisma.rubric.create({
    data: { version: 1, criteria },
  });

  const posting = await prisma.posting.create({
    data: {
      title: 'CAD Task Author (parametric modeling)',
      description:
        'We are hiring CAD experts to write precise, verifiable parametric-modeling tasks. ' +
        'You should be fluent in CadQuery or similar code-first CAD, comfortable reasoning ' +
        'about constraints and dimensions, and able to document a task so another engineer can solve it.',
      rubricId: rubric.id,
    },
  });

  console.log(`Seeded rubric ${rubric.id} and posting ${posting.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
