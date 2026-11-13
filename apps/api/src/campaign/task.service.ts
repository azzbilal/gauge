import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CheckMethod,
  Prisma,
  ReviewDecision,
  Role,
  Task,
  TaskStatus,
  Verdict,
  VerifySubjectType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.decorators';
import { BuiltPacket, buildPacket, rubricItemIdOf } from '../verify/packet-builder';
import { LintFindingResult, VerifyClient } from '../verify/verify.client';
import { VerifyUnreachableError } from '../verify/verify.errors';
import { CreateTaskDto, PreviewTaskDto } from './dto/task.dto';
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
// The verify service does not report a version yet; this names the M8 static CAD pack.
const VERIFIER_VERSION = 'm8-static-cad';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const TASK_INCLUDE = {
  campaign: { select: { id: true, name: true } },
  author: { select: { id: true, name: true } },
  taskReviews: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.TaskInclude;

// Stored in place of findings when the linter could not be asked: no findings is not a clean lint.
const LINT_NOT_RUN_RULE = 'lint_not_run';
const CRITICAL = 'critical';

/** The lint a create ran before its insert: the findings, or why there are none. */
type LintOutcome =
  | { status: 'ok'; findings: LintFindingResult[] }
  | { status: 'not_run'; note: string };

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;
type Tx = Prisma.TransactionClient;

export type ReviewState = 'awaiting_reviews' | 'awaiting_adjudication' | 'decided';

/** One verifier verdict as the author reads it: names instead of packet ids. */
export interface PreviewVerdict {
  /** The rubric criterion that was checked, e.g. `correct_reference`. */
  criterion: string;
  /** The requirement it was checked against, e.g. `width of 60 mm`. */
  requirement: string | null;
  check: string;
  status: string; // pass | fail | not_run
  detail: string;
}

/** Each half ran (`ok`) or did not (`not_run`, with a note saying why). */
export interface TaskPreview {
  lint: { status: 'ok' | 'not_run'; findings: LintFindingResult[]; note?: string };
  verify: { status: 'ok' | 'not_run'; verdicts: PreviewVerdict[]; note?: string };
}

/**
 * The packet ids are random and exist only for this one preview, so the text shown to the
 * author names the rubric criterion and quotes the requirement instead.
 */
function packetLabels(built: BuiltPacket) {
  const requirement = new Map(built.requirements.map((r) => [r.id, r.text]));
  // Rubric item text opens with its criterion key ("correct_reference: ...").
  const criterion = new Map(built.rubricItems.map((i) => [i.id, i.text.split(':')[0]]));
  const names: Array<[string, string]> = [
    ...built.packet.rubricItems.map((i): [string, string] => [
      i.id,
      criterion.get(rubricItemIdOf(i.id)) ?? i.id,
    ]),
    ...built.requirements.map((r): [string, string] => [r.id, `"${r.text}"`]),
  ];
  // Longest first: a machine item's packet id is `<rubricItemId>:<requirementId>`.
  names.sort((a, b) => b[0].length - a[0].length);
  return {
    requirement: (id: string | null) => (id ? requirement.get(id) ?? null : null),
    criterion: (packetItemId: string) => criterion.get(rubricItemIdOf(packetItemId)) ?? packetItemId,
    readable: (text: string) => names.reduce((out, [id, name]) => out.split(id).join(name), text),
  };
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly verifyClient: VerifyClient,
  ) {}

  /**
   * All tasks, newest first. With `queueOf` it becomes that user's work queue: only tasks
   * their role lets them act on, oldest first, with gold tasks mixed in at ~20%.
   */
  async list(campaignId?: string, queueOf?: AuthUser) {
    const reviewerId = queueOf?.expertId;
    const tasks = await this.prisma.task.findMany({
      where: campaignId ? { campaignId } : undefined,
      orderBy: { createdAt: reviewerId ? 'asc' : 'desc' },
      include: TASK_INCLUDE,
    });
    const adjudications = await this.adjudicationsFor(tasks.map((t) => t.id));
    const view = (t: TaskRow) => this.toView(t, adjudications.get(t.id));

    if (!queueOf || !reviewerId) return tasks.map(view);

    const actionable = tasks.filter((t) =>
      this.canAct(t, queueOf, adjudications.get(t.id)),
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

  async create(dto: CreateTaskDto, author: AuthUser) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: dto.campaignId } });
    if (!campaign) {
      throw new NotFoundException(`Campaign "${dto.campaignId}" not found`);
    }
    const authorId = author.expertId;

    // The gate (docs/pipeline.md §2 Layer 2): lint the packet before anything is stored. A
    // critical finding refuses the task, whoever the client is. The service also extracts
    // the requirements, so without it there is no packet either.
    //
    // Only an outage lets a task through unlinted, recorded as such: the service could
    // not be reached or did not answer in time, which says nothing about the task. Any
    // other failure refuses the create. A service that answered with an error status, a
    // malformed body or a rubric this API does not store is one whose lint cannot be
    // trusted, and accepting the task then would be the gate failing open.
    let built: BuiltPacket | null = null;
    let lint: LintOutcome;
    try {
      built = await buildPacket(dto, this.verifyClient);
      lint = { status: 'ok', findings: await this.verifyClient.lint(built.packet) };
    } catch (err) {
      if (!(err instanceof VerifyUnreachableError)) {
        this.logger.error(`Task refused, the lint gate could not run: ${message(err)}`);
        throw new UnprocessableEntityException(
          `Task not created, it could not be linted: ${message(err)}`,
        );
      }
      lint = { status: 'not_run', note: message(err) };
    }
    if (lint.status === 'ok' && built) {
      const critical = lint.findings.filter((f) => f.severity === CRITICAL);
      if (critical.length > 0) {
        const labels = packetLabels(built);
        const reasons = critical.map(
          (f) => `${f.rule.replace(/_/g, ' ')}: ${f.detail === null ? '' : labels.readable(f.detail)}`,
        );
        throw new UnprocessableEntityException(
          `Task not created, ${critical.length === 1 ? 'a critical lint finding' : `${critical.length} critical lint findings`}: ${reasons.join('; ')}`,
        );
      }
    }
    const linted = lint.status === 'ok';

    const isGold = dto.goldExpectedAccept !== undefined;
    const task = await this.prisma.task.create({
      data: {
        campaignId: dto.campaignId,
        authorId,
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
        actorId: authorId,
        type: 'task.created',
        payload: {
          taskId: task.id,
          campaignId: dto.campaignId,
          isGold,
          linted,
          // Which extraction read the requirements; null when the service gave none.
          extractionVersion: built?.extractionVersion ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    await this.runVerification(task, built, lint);

    return { ...task, linted };
  }

  /**
   * Layer 2 on a draft: the same packet, lint and verify a create would run, with nothing
   * stored. Never throws for a verify service that is down or slow: each half reports
   * `not_run` with the reason, because a check that did not run is not a clean result.
   */
  async preview(dto: PreviewTaskDto): Promise<TaskPreview> {
    let built: BuiltPacket;
    try {
      built = await buildPacket(dto, this.verifyClient);
    } catch (err) {
      // No requirements, so no packet: neither half had anything to run on.
      const note = message(err);
      return {
        lint: { status: 'not_run', findings: [], note },
        verify: { status: 'not_run', verdicts: [], note },
      };
    }
    const labels = packetLabels(built);
    const [lint, verify] = await Promise.allSettled([
      this.verifyClient.lint(built.packet),
      this.verifyClient.verify(built.packet),
    ]);
    return {
      lint:
        lint.status === 'fulfilled'
          ? {
              status: 'ok',
              findings: lint.value.map((f) => ({
                ...f,
                detail: f.detail === null ? null : labels.readable(f.detail),
              })),
            }
          : { status: 'not_run', findings: [], note: message(lint.reason) },
      verify:
        verify.status === 'fulfilled'
          ? {
              status: 'ok',
              verdicts: verify.value.map((v) => ({
                criterion: labels.criterion(v.rubric_item_id),
                requirement: labels.requirement(v.requirement_id),
                check: v.check,
                // Only the three known states pass through; anything else did not run.
                status: v.status === 'pass' || v.status === 'fail' ? v.status : 'not_run',
                detail: labels.readable(v.detail),
              })),
            }
          : { status: 'not_run', verdicts: [], note: message(verify.reason) },
    };
  }

  /** The stored Layer 2 results for a task: lint findings and verifier runs. */
  async verification(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { id: true } });
    if (!task) {
      throw new NotFoundException(`Task "${taskId}" not found`);
    }
    const [lintFindings, verifierRuns] = await Promise.all([
      this.prisma.lintFinding.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.verifierRun.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }),
    ]);
    return { taskId, lintFindings, verifierRuns };
  }

  /**
   * Layer 2 on a new task: verify its reference and store that with the lint its create
   * already ran, on the same packet, so the stored rows carry the ids the findings quote.
   * `built` is null when the requirements could not be extracted; nothing is verified then.
   * Never throws: the task already exists, and neither a verify service that is down nor a
   * failed write here may fail the create.
   */
  private async runVerification(
    task: Task,
    built: BuiltPacket | null,
    lint: LintOutcome,
  ): Promise<void> {
    try {
      const [verify] = await Promise.allSettled([
        built
          ? this.verifyClient.verify(built.packet)
          : Promise.reject(new Error('no packet, the requirements were not extracted')),
      ]);
      if (lint.status === 'not_run') {
        this.logger.warn(`Task ${task.id} created without lint: ${lint.note}`);
      }
      if (verify.status === 'rejected') {
        this.logger.warn(`Task ${task.id} created without verification: ${message(verify.reason)}`);
      }

      const writes: Prisma.PrismaPromise<unknown>[] = [];
      if (built && (lint.status === 'ok' || verify.status === 'fulfilled')) {
        // The stored findings and verdicts quote these ids, so the rows keep them.
        writes.push(
          this.prisma.requirement.createMany({
            data: built.requirements.map((r) => ({
              id: r.id,
              taskId: task.id,
              text: r.text,
              kind: r.kind,
              value: r.value,
              tolerance: r.tolerance,
            })),
          }),
          this.prisma.rubricItem.createMany({
            data: built.rubricItems.map((item) => ({
              id: item.id,
              taskId: task.id,
              requirementId: item.requirementId,
              text: item.text,
              checkMethod: item.checkMethod === 'machine' ? CheckMethod.MACHINE : CheckMethod.MANUAL,
              weight: item.weight,
            })),
          }),
        );
      }
      // Everything the linter said is stored as it said it. When it said nothing because it
      // was not asked, one row says so: an empty list would read as a clean lint.
      writes.push(
        this.prisma.lintFinding.createMany({
          data:
            lint.status === 'ok'
              ? lint.findings.map((f) => ({ ...f, taskId: task.id }))
              : [
                  {
                    taskId: task.id,
                    rule: LINT_NOT_RUN_RULE,
                    severity: 'warning',
                    detail: `Not linted: ${lint.note}`,
                  },
                ],
        }),
      );
      if (verify.status === 'fulfilled') {
        const verdicts = verify.value.map((v) => ({
          ...v,
          rubric_item_id: rubricItemIdOf(v.rubric_item_id),
        }));
        writes.push(
          this.prisma.verifierRun.create({
            data: {
              taskId: task.id,
              subjectType: VerifySubjectType.REFERENCE_SOLUTION,
              // The reference lives on the task row; there is no separate entity.
              subjectId: task.id,
              verifierVersion: VERIFIER_VERSION,
              results: verdicts as unknown as Prisma.InputJsonValue,
              // A check that did not run is not a pass, and neither is no check at all.
              passed: verdicts.length > 0 && verdicts.every((v) => v.pass),
            },
          }),
        );
      }
      await this.prisma.$transaction(writes);
    } catch (err) {
      this.logger.warn(`Verification of task ${task.id} was not stored: ${message(err)}`);
    }
  }

  /**
   * Record one peer review and move the task along (docs/pipeline.md §2.1):
   *   first review  -> IN_REVIEW
   *   second review -> ACCEPTED / REJECTED if the two verdicts agree,
   *                    otherwise stays IN_REVIEW and an adjudication is opened.
   * Gold tasks are calibration only: any number of reviewers, never a status change.
   */
  async review(taskId: string, dto: CreateTaskReviewDto, reviewer: AuthUser) {
    const reviewerId = reviewer.expertId;

    // The rubric decides acceptance (docs/pipeline.md §2), not the client.
    const accepted = isAccepted(dto.scores);

    return this.prisma.$transaction(async (tx) => {
      // Serialise reviews of the same task, so two concurrent requests cannot both
      // see "one review so far" and write a third.
      const task = await this.lockTask(tx, taskId);
      const peerReviews = task.taskReviews.filter((r) => r.reviewerExpertId !== null);

      if (task.authorId === reviewerId) {
        throw new ForbiddenException('Authors cannot review their own task');
      }
      if (peerReviews.some((r) => r.reviewerExpertId === reviewerId)) {
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
          reviewerId: reviewerId,
          reviewerExpertId: reviewerId,
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
          actorId: reviewerId,
          type: 'task.reviewed',
          payload: {
            taskId,
            reviewId: review.id,
            reviewerId: reviewerId,
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
  async adjudicate(taskId: string, dto: AdjudicateTaskDto, adjudicator: AuthUser) {
    const adjudicatorId = adjudicator.expertId;

    return this.prisma.$transaction(async (tx) => {
      const task = await this.lockTask(tx, taskId);
      const pending = await tx.reviewDecision.findFirst({
        where: { subjectType: TASK_SUBJECT, subjectId: taskId, verdict: Verdict.NEEDS_REVIEW },
      });
      if (!pending) {
        throw new ConflictException('Task is not awaiting adjudication');
      }
      if (task.authorId === adjudicatorId) {
        throw new ForbiddenException('Authors cannot adjudicate their own task');
      }
      if (task.taskReviews.some((r) => r.reviewerExpertId === adjudicatorId)) {
        throw new ForbiddenException('A reviewer of this task cannot also adjudicate it');
      }

      const accept = dto.verdict === 'accept';
      const decision = await tx.reviewDecision.update({
        where: { id: pending.id },
        data: {
          verdict: accept ? Verdict.APPROVE : Verdict.REJECT,
          reason: dto.reason,
          reviewerId: adjudicatorId,
        },
      });
      const status = accept ? TaskStatus.ACCEPTED : TaskStatus.REJECTED;
      await tx.task.update({ where: { id: taskId }, data: { status } });

      await tx.event.create({
        data: {
          actorId: adjudicatorId,
          type: 'task.adjudicated',
          payload: {
            taskId,
            decisionId: decision.id,
            adjudicatorId: adjudicatorId,
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

  /**
   * May this user act on this task right now? Reviewers see tasks open for a peer review
   * (gold included), adjudicators see split tasks, an admin sees both, an author neither.
   */
  private canAct(task: TaskRow, user: AuthUser, adjudication?: ReviewDecision): boolean {
    const expertId = user.expertId;
    const reviews = user.role === Role.REVIEWER || user.role === Role.ADMIN;
    const adjudicates = user.role === Role.ADJUDICATOR || user.role === Role.ADMIN;
    if (task.authorId === expertId) return false;
    if (task.taskReviews.some((r) => r.reviewerExpertId === expertId)) return false;
    if (task.isGold) return reviews;
    if (adjudication?.verdict === Verdict.NEEDS_REVIEW) return adjudicates;
    if (!reviews) return false;
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
