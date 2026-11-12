import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ReviewDecision, TaskStatus, Verdict } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/task.dto';
import { AdjudicateTaskDto, CreateTaskReviewDto } from './dto/task-review.dto';
import {
  REVIEWS_REQUIRED,
  ScorePair,
  Scores,
  agreementReport,
  calibrationReport,
  consensus,
  goldDue,
  goldOrder,
  isAccepted,
} from './review-protocol';

// ReviewDecision is polymorphic; for a task it is the adjudication record.
const TASK_SUBJECT = 'task';
// Who "wrote" an adjudication that is still open (reviewerId is non-null).
const SYSTEM_REVIEWER = 'system';

const TASK_INCLUDE = {
  campaign: { select: { id: true, name: true } },
  author: { select: { id: true, name: true } },
  taskReviews: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;
type Tx = Prisma.TransactionClient;

export type ReviewState = 'awaiting_reviews' | 'awaiting_adjudication' | 'decided';

@Injectable()
export class TaskService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * All tasks, newest first. With `reviewerId` it becomes that reviewer's work queue:
   * only tasks they may act on, oldest first, with gold tasks mixed in at ~20%.
   */
  async list(campaignId?: string, reviewerId?: string) {
    if (reviewerId) {
      await this.requireExpert(reviewerId, 'Reviewer');
    }
    const tasks = await this.prisma.task.findMany({
      where: campaignId ? { campaignId } : undefined,
      orderBy: { createdAt: reviewerId ? 'asc' : 'desc' },
      include: TASK_INCLUDE,
    });
    const adjudications = await this.adjudicationsFor(tasks.map((t) => t.id));
    const view = (t: TaskRow) => this.toView(t, adjudications.get(t.id));

    if (!reviewerId) return tasks.map(view);

    const actionable = tasks.filter((t) =>
      this.canAct(t, reviewerId, adjudications.get(t.id)),
    );
    const regular = actionable.filter((t) => !t.isGold);
    const gold = goldOrder(
      reviewerId,
      actionable.filter((t) => t.isGold),
    );

    // Gold is served one at a time, at the head of the queue, when this reviewer's
    // own history says a calibration review is due (~20% of their reviews).
    const mine = tasks.filter((t) => t.taskReviews.some((r) => r.reviewerExpertId === reviewerId));
    const goldDone = mine.filter((t) => t.isGold).length;
    const queue =
      gold.length > 0 && goldDue(reviewerId, mine.length, goldDone)
        ? [gold[0], ...regular]
        : regular;
    return queue.map(view);
  }

  async get(id: string) {
    const task = await this.prisma.task.findUnique({ where: { id }, include: TASK_INCLUDE });
    if (!task) {
      throw new NotFoundException(`Task "${id}" not found`);
    }
    return this.toView(task, (await this.adjudicationsFor([id])).get(id));
  }

  async create(dto: CreateTaskDto) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: dto.campaignId } });
    if (!campaign) {
      throw new NotFoundException(`Campaign "${dto.campaignId}" not found`);
    }
    await this.requireExpert(dto.authorId, 'Author');

    const isGold = dto.goldExpectedAccept !== undefined;
    const task = await this.prisma.task.create({
      data: {
        campaignId: dto.campaignId,
        authorId: dto.authorId,
        prompt: dto.prompt,
        spec: dto.spec ?? null,
        reference: dto.reference ?? null,
        status: TaskStatus.SUBMITTED,
        isGold,
        goldExpectedAccept: dto.goldExpectedAccept ?? null,
      },
    });

    await this.prisma.event.create({
      data: {
        actorId: dto.authorId,
        type: 'task.created',
        payload: { taskId: task.id, campaignId: dto.campaignId, isGold } as Prisma.InputJsonValue,
      },
    });

    return task;
  }

  /**
   * Record one peer review and move the task along (docs/pipeline.md §2.1):
   *   first review  -> IN_REVIEW
   *   second review -> ACCEPTED / REJECTED if the two verdicts agree,
   *                    otherwise stays IN_REVIEW and an adjudication is opened.
   * Gold tasks are calibration only: any number of reviewers, never a status change.
   */
  async review(taskId: string, dto: CreateTaskReviewDto) {
    await this.requireExpert(dto.reviewerId, 'Reviewer');

    // The rubric decides acceptance (docs/pipeline.md §2), not the client.
    const accepted = isAccepted(dto.scores);

    return this.prisma.$transaction(async (tx) => {
      // Serialise reviews of the same task, so two concurrent requests cannot both
      // see "one review so far" and write a third.
      const task = await this.lockTask(tx, taskId);
      const peerReviews = task.taskReviews.filter((r) => r.reviewerExpertId !== null);

      if (task.authorId === dto.reviewerId) {
        throw new ForbiddenException('Authors cannot review their own task');
      }
      if (peerReviews.some((r) => r.reviewerExpertId === dto.reviewerId)) {
        throw new ConflictException('This reviewer has already reviewed this task');
      }
      if (!task.isGold) {
        if (task.status !== TaskStatus.SUBMITTED && task.status !== TaskStatus.IN_REVIEW) {
          throw new ConflictException(`Task is ${task.status} and is not open for review`);
        }
        if (peerReviews.length >= REVIEWS_REQUIRED) {
          throw new ConflictException(
            `Task already has ${REVIEWS_REQUIRED} reviews and is awaiting adjudication`,
          );
        }
      }

      const review = await tx.taskReview.create({
        data: {
          taskId,
          reviewerId: dto.reviewerId,
          reviewerExpertId: dto.reviewerId,
          scores: dto.scores as Prisma.InputJsonValue,
          accepted,
        },
      });

      let status: TaskStatus = task.status;
      let outcome: string = 'calibration';
      if (!task.isGold) {
        outcome = consensus([...peerReviews.map((r) => r.accepted), accepted]);
        if (outcome === 'accepted') status = TaskStatus.ACCEPTED;
        else if (outcome === 'rejected') status = TaskStatus.REJECTED;
        else status = TaskStatus.IN_REVIEW;
        await tx.task.update({ where: { id: taskId }, data: { status } });

        if (outcome === 'split') {
          const decision = await tx.reviewDecision.create({
            data: {
              subjectType: TASK_SUBJECT,
              subjectId: taskId,
              reviewerId: SYSTEM_REVIEWER,
              verdict: Verdict.NEEDS_REVIEW,
              reason: 'Peer reviewers disagree on the verdict',
            },
          });
          await tx.event.create({
            data: {
              actorId: null,
              type: 'task.adjudication_opened',
              payload: { taskId, decisionId: decision.id } as Prisma.InputJsonValue,
            },
          });
        }
      }

      await tx.event.create({
        data: {
          actorId: dto.reviewerId,
          type: 'task.reviewed',
          payload: {
            taskId,
            reviewId: review.id,
            reviewerId: dto.reviewerId,
            accepted,
            outcome,
          } as Prisma.InputJsonValue,
        },
      });

      // A gold task must look like any other task to the reviewer.
      return { ...review, taskStatus: task.isGold ? TaskStatus.IN_REVIEW : status };
    });
  }

  /**
   * Resolve a split: a third expert, who is neither the author nor one of the two
   * reviewers, gives the final verdict with a written reason.
   */
  async adjudicate(taskId: string, dto: AdjudicateTaskDto) {
    await this.requireExpert(dto.adjudicatorId, 'Adjudicator');

    return this.prisma.$transaction(async (tx) => {
      const task = await this.lockTask(tx, taskId);
      const pending = await tx.reviewDecision.findFirst({
        where: { subjectType: TASK_SUBJECT, subjectId: taskId, verdict: Verdict.NEEDS_REVIEW },
      });
      if (!pending) {
        throw new ConflictException('Task is not awaiting adjudication');
      }
      if (task.authorId === dto.adjudicatorId) {
        throw new ForbiddenException('Authors cannot adjudicate their own task');
      }
      if (task.taskReviews.some((r) => r.reviewerExpertId === dto.adjudicatorId)) {
        throw new ForbiddenException('A reviewer of this task cannot also adjudicate it');
      }

      const accept = dto.verdict === 'accept';
      const decision = await tx.reviewDecision.update({
        where: { id: pending.id },
        data: {
          verdict: accept ? Verdict.APPROVE : Verdict.REJECT,
          reason: dto.reason,
          reviewerId: dto.adjudicatorId,
        },
      });
      const status = accept ? TaskStatus.ACCEPTED : TaskStatus.REJECTED;
      await tx.task.update({ where: { id: taskId }, data: { status } });

      await tx.event.create({
        data: {
          actorId: dto.adjudicatorId,
          type: 'task.adjudicated',
          payload: {
            taskId,
            decisionId: decision.id,
            adjudicatorId: dto.adjudicatorId,
            verdict: decision.verdict,
          } as Prisma.InputJsonValue,
        },
      });

      return { ...decision, taskStatus: status };
    });
  }

  /** Inter-annotator agreement per criterion over doubly-reviewed, non-gold tasks. */
  async agreement(campaignId?: string) {
    const tasks = await this.prisma.task.findMany({
      where: { isGold: false, ...(campaignId ? { campaignId } : {}) },
      select: {
        id: true,
        taskReviews: {
          where: { reviewerExpertId: { not: null } },
          orderBy: { createdAt: 'asc' },
          select: { scores: true, accepted: true },
        },
      },
    });
    const paired = tasks.filter((t) => t.taskReviews.length >= REVIEWS_REQUIRED);
    const pairs = paired.map(
      (t) => [t.taskReviews[0].scores as Scores, t.taskReviews[1].scores as Scores] as ScorePair,
    );
    const splits = paired.filter((t) => t.taskReviews[0].accepted !== t.taskReviews[1].accepted);
    const pending = await this.prisma.reviewDecision.count({
      where: {
        subjectType: TASK_SUBJECT,
        verdict: Verdict.NEEDS_REVIEW,
        subjectId: { in: splits.map((t) => t.id) },
      },
    });
    return {
      campaignId: campaignId ?? null,
      tasksWithTwoReviews: paired.length,
      splitVerdicts: splits.length,
      awaitingAdjudication: pending,
      ...agreementReport(pairs),
    };
  }

  /** Reviewer accuracy against the gold answers. A flag is a prompt to recalibrate. */
  async calibration(campaignId?: string) {
    const reviews = await this.prisma.taskReview.findMany({
      where: {
        reviewerExpertId: { not: null },
        ...(campaignId ? { task: { campaignId } } : {}),
      },
      select: {
        reviewerExpertId: true,
        accepted: true,
        reviewer: { select: { name: true } },
        task: { select: { isGold: true, goldExpectedAccept: true } },
      },
    });
    const names = new Map(reviews.map((r) => [r.reviewerExpertId as string, r.reviewer?.name]));
    return calibrationReport(
      reviews.map((r) => ({
        reviewerId: r.reviewerExpertId as string,
        accepted: r.accepted,
        goldExpectedAccept: r.task.isGold ? r.task.goldExpectedAccept : null,
      })),
    ).map((row) => ({ ...row, reviewerName: names.get(row.reviewerId) ?? null }));
  }

  // ------------------------------------------------------------------ helpers

  private async requireExpert(id: string, role: string) {
    const expert = await this.prisma.expert.findUnique({ where: { id } });
    if (!expert) {
      throw new NotFoundException(`${role} (expert) "${id}" not found`);
    }
    return expert;
  }

  /** Lock the task row for the rest of the transaction and load it with its reviews. */
  private async lockTask(tx: Tx, taskId: string): Promise<TaskRow> {
    const locked = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT "id" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE`;
    if (locked.length === 0) {
      throw new NotFoundException(`Task "${taskId}" not found`);
    }
    return tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE });
  }

  /** Latest adjudication record per task id. */
  private async adjudicationsFor(taskIds: string[]): Promise<Map<string, ReviewDecision>> {
    if (taskIds.length === 0) return new Map();
    const decisions = await this.prisma.reviewDecision.findMany({
      where: { subjectType: TASK_SUBJECT, subjectId: { in: taskIds } },
      orderBy: { createdAt: 'asc' },
    });
    return new Map(decisions.map((d) => [d.subjectId, d]));
  }

  /** May this expert review or adjudicate this task right now? */
  private canAct(task: TaskRow, expertId: string, adjudication?: ReviewDecision): boolean {
    if (task.authorId === expertId) return false;
    if (task.taskReviews.some((r) => r.reviewerExpertId === expertId)) return false;
    if (task.isGold) return true;
    if (adjudication?.verdict === Verdict.NEEDS_REVIEW) return true;
    const open = task.status === TaskStatus.SUBMITTED || task.status === TaskStatus.IN_REVIEW;
    const peerReviews = task.taskReviews.filter((r) => r.reviewerExpertId !== null);
    return open && peerReviews.length < REVIEWS_REQUIRED;
  }

  /**
   * The shape the API returns. Two things are deliberately withheld:
   *  - gold markers and the gold answer, or calibration would measure nothing;
   *  - other reviewers' scores while a second review is still open, so that
   *    review (and the agreement statistic built on it) stays independent. Scores
   *    release once the two reviewers are done — at adjudication and after the
   *    decision — so the adjudicator can see the dispute.
   * A gold task is presented as an ordinary task nobody has reviewed yet.
   */
  private toView(task: TaskRow, adjudication?: ReviewDecision) {
    const { isGold, goldExpectedAccept, taskReviews, ...rest } = task;
    void goldExpectedAccept;

    if (isGold) {
      return {
        ...rest,
        status: TaskStatus.SUBMITTED,
        reviewState: 'awaiting_reviews' as ReviewState,
        taskReviews: [],
        adjudication: null,
      };
    }

    const decided = task.status === TaskStatus.ACCEPTED || task.status === TaskStatus.REJECTED;
    const awaitingAdjudication = adjudication?.verdict === Verdict.NEEDS_REVIEW;
    const reviewState: ReviewState = decided
      ? 'decided'
      : awaitingAdjudication
        ? 'awaiting_adjudication'
        : 'awaiting_reviews';

    return {
      ...rest,
      reviewState,
      taskReviews: taskReviews.map((r) =>
        decided || awaitingAdjudication
          ? r
          : { id: r.id, taskId: r.taskId, reviewerId: r.reviewerId, createdAt: r.createdAt },
      ),
      adjudication: adjudication
        ? {
            id: adjudication.id,
            verdict: adjudication.verdict,
            // While open, the row holds the system placeholder, not a person.
            adjudicatorId: awaitingAdjudication ? null : adjudication.reviewerId,
            reason: adjudication.reason,
          }
        : null,
    };
  }
}
