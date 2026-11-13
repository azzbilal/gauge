import { Prisma, Role } from '@prisma/client';
import { AuthUser } from '../auth/auth.decorators';

/**
 * Who may see which task (docs/pipeline.md §3). One rule, the same for every endpoint that
 * names a task, and decided from the row alone, never from a reviewer's history:
 *  - a normal task: everyone;
 *  - a gold task (the source a clone copies): admins only;
 *  - a gold clone: the one reviewer it was written for, and nobody else, admins included.
 * Anything not visible answers exactly like an id that does not exist.
 */

/** The task columns the rule reads. */
export interface GoldFields {
  isGold: boolean;
  goldSourceId: string | null;
  goldForExpertId: string | null;
}

/** A copy of a gold task, written for one reviewer. */
export function isGoldClone(task: GoldFields): boolean {
  return task.goldSourceId !== null;
}

/**
 * A gold task as an admin wrote it: holds the answer. Gold reviews sit on the reviewers'
 * clones of it (and, from before clones, on the source itself).
 */
export function isGoldSource(task: GoldFields): boolean {
  return task.isGold && task.goldSourceId === null;
}

export function visibleTo(task: GoldFields, viewer: AuthUser): boolean {
  if (isGoldClone(task)) return task.goldForExpertId === viewer.expertId;
  if (task.isGold) return viewer.role === Role.ADMIN;
  return true;
}

/** The same rule as a Prisma filter, for counts. Must agree with `visibleTo`. */
export function visibleWhere(viewer: AuthUser): Prisma.TaskWhereInput {
  return {
    OR: [
      { isGold: false },
      { goldForExpertId: viewer.expertId },
      ...(viewer.role === Role.ADMIN ? [{ isGold: true, goldSourceId: null }] : []),
    ],
  };
}
