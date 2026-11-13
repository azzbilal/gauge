import { ExpertStatus, Prisma, PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { CAD_TASK_AUTHOR_CRITERIA, CAD_TASK_AUTHOR_POSTING } from '../src/intake/posting';

const prisma = new PrismaClient();

// Development logins. Override the passwords with SEED_ADMIN_PASSWORD and
// SEED_REVIEWER_PASSWORD; the defaults are for a local database only.
const SEED_USERS = [
  {
    name: 'Admin',
    email: 'admin@gauge.local',
    role: Role.ADMIN,
    password: process.env.SEED_ADMIN_PASSWORD || 'gauge-admin-dev',
  },
  {
    name: 'Reviewer',
    email: 'reviewer@gauge.local',
    role: Role.REVIEWER,
    password: process.env.SEED_REVIEWER_PASSWORD || 'gauge-reviewer-dev',
  },
];

/** Each login is backed by an Expert row, which tasks, reviews and events point at. */
async function seedUsers() {
  for (const u of SEED_USERS) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    if (existing) {
      console.log(`User ${u.email} already exists, left as is`);
      continue;
    }
    const passwordHash = await bcrypt.hash(u.password, 12);
    await prisma.$transaction(async (tx) => {
      const expert = await tx.expert.create({
        data: { name: u.name, domain: 'CAD', status: ExpertStatus.ACTIVE },
      });
      await tx.user.create({
        data: { name: u.name, email: u.email, passwordHash, role: u.role, expertId: expert.id },
      });
    });
    console.log(`Seeded ${u.role.toLowerCase()} ${u.email}`);
  }
}

async function main() {
  await seedUsers();

  // Shared with the golden-set harness (src/intake/posting.ts), so both score the same rubric.
  const criteria = CAD_TASK_AUTHOR_CRITERIA as unknown as Prisma.InputJsonValue;

  const rubric = await prisma.rubric.create({
    data: { version: 1, criteria },
  });

  const posting = await prisma.posting.create({
    data: { ...CAD_TASK_AUTHOR_POSTING, rubricId: rubric.id },
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
