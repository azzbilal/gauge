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
  ProbeRun,
  ProbeStatus,
  ReviewDecision,
  Role,
  Task,
  TaskStatus,
  Verdict,
  VerifySubjectType,
} from '@prisma/client';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.decorators';
import { BuiltPacket, buildPacket, rubricItemIdOf } from '../verify/packet-builder';
import { LintFindingResult, VerifyClient } from '../verify/verify.client';
import {
  ProbeModelUnreachableError,
  VerifyContractError,
  VerifyUnreachableError,
} from '../verify/verify.errors';
import { CreateTaskDto, PreviewTaskDto, ProbeTaskDto } from './dto/task.dto';
import { AdjudicateTaskDto, CreateTaskReviewDto } from './dto/task-review.dto';
import {
  Adjudicator,
  REVIEWS_REQUIRED,
  ScorePair,
  Scores,
  adjudicationRight,
  agreementReport,
  buildQueue,
  calibrationReport,
  consensus,
  dueGold,
  goldPlace,
  isAccepted,
  mayAdjudicate,
  placeInQueue,
} from './review-protocol';
import { isGoldClone, isGoldSource, visibleTo } from './task-visibility';
import { disagreementOf, verifierAgreementStats } from './verifier-agreement';

// ReviewDecision is polymorphic; for a task it is the adjudication record.
const TASK_SUBJECT = 'task';
// Who "wrote" an adjudication that is still open (reviewerId is non-null).
const SYSTEM_REVIEWER = 'system';
// The verify service does not report a version yet; this names the M8 static CAD pack.
const VERIFIER_VERSION = 'm8-static-cad';
// The probe model when the request names none: the same local Ollama model as intake.
const DEFAULT_PROBE_MODEL = 'qwen3.5:9b-q4_K_M';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The verdicts a stored VerifierRun holds (`results`), read defensively: it is JSON. */
function storedVerdicts(results: Prisma.JsonValue) {
  if (!Array.isArray(results)) return [];
  return results.flatMap((v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return [];
    const r = v as Record<string, unknown>;
    return [
      {
        requirement_id: typeof r.requirement_id === 'string' ? r.requirement_id : null,
        check: String(r.check ?? ''),
        status: String(r.status ?? ''),
        detail: String(r.detail ?? ''),
      },
    ];
  });
}

/** The task as the adjudication rule reads it: who wrote it, who reviewed it. */
function subjectOf(task: {
  authorId: string;
  taskReviews: Array<{ reviewerExpertId: string | null }>;
}) {
  return {
    authorId: task.authorId,
    reviewerExpertIds: task.taskReviews.map((r) => r.reviewerExpertId),
  };
}

/** A split normal task whose adjudication is still open. Gold rows never split. */
function awaitsAdjudication(task: { isGold: boolean }, adjudication?: ReviewDecision): boolean {
  return !task.isGold && adjudication?.verdict === Verdict.NEEDS_REVIEW;
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

// ------------------------------------------------- gold clone ids and times

/** A Prisma cuid: c, 8 timestamp, 4 counter, 4 fingerprint, 8 random (all base 36). */
const CUID = /^c[0-9a-z]{24}$/;

function base36(n: number, width: number): string {
  return n.toString(36).padStart(width, '0').slice(-width);
}

function randomBase36(width: number): string {
  // 48 random bits cover 36^8; the slight modulo bias does not matter for an id.
  return base36(randomBytes(6).readUIntBE(0, 6) % 36 ** width, width);
}

/**
 * Mints cuid-shaped ids for a gold clone and its Layer 2 rows, at a time of our choosing, so
 * the id carries the same (backdated) time as the row's createdAt. The fingerprint and counter
 * are borrowed from a real id written near that time, so the clone's id looks like it came from
 * the same server process as its neighbours. The counter advances once per row.
 */
function cuidMinter(neighbour: string | null) {
  const real = neighbour !== null && CUID.test(neighbour) ? neighbour : null;
  const fingerprint = real ? real.slice(13, 17) : randomBase36(4);
  let counter = (real ? parseInt(real.slice(9, 13), 36) : randomInt(36 ** 3)) + 1 + randomInt(3);
  return {
    /** Advance to the next row's counter. */
    next: () => counter++,
    /** A candidate id at `time` with this row's counter; only the random block varies. */
    at: (time: Date, n: number) =>
      `c${base36(time.getTime(), 8)}${base36(n, 4)}${fingerprint}${randomBase36(8)}`,
  };
}

/**
 * A creation time for a gold clone that says nothing about when it was written: a random
 * instant between two consecutive real (non-gold) tasks of the gold's campaign, so the clone
 * sits among real arrivals. It never keys off the request time or the reviewer's history.
 * With fewer than two real tasks there is no gap to hide in; it then falls within a minute
 * after the one real task, or after the gold source, never later than now.
 */
function plausibleCreatedAt(source: TaskRow, all: TaskRow[], now: number): Date {
  const times = all
    .filter((t) => !t.isGold && t.campaignId === source.campaignId)
    .map((t) => t.createdAt.getTime())
    .sort((a, b) => a - b);
  if (times.length >= 2) {
    const i = randomInt(times.length - 1);
    return new Date(Math.floor(times[i] + Math.random() * (times[i + 1] - times[i])));
  }
  const base = times[0] ?? source.createdAt.getTime();
  return new Date(Math.min(now, base + randomInt(1, 60_000)));
}

/**
 * A review while the second review is still open: who and when, never scores, evidence or
 * verdict.
 */
function redactedReview(r: TaskRow['taskReviews'][number]) {
  return { id: r.id, taskId: r.taskId, reviewerId: r.reviewerId, createdAt: r.createdAt };
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly verifyClient: VerifyClient,
  ) {}

  /**
   * All tasks the viewer may see, newest first. With `queue` it becomes the viewer's work
   * queue: only tasks their role lets them act on. A reviewer's queue is in one shared order
   * that ignores age (see buildQueue); anyone else's is oldest first.
   *
   * Gold reaches a reviewer only as a clone written for them alone when a gold review falls
   * due (see materialiseGold): a row with its own id, dated among the campaign's real tasks,
   * whose id hash puts it where the gold review is due in the queue. Once reviewed it stays in
   * their list like any task they reviewed. The gold rows themselves are shown to admins
   * only, so nothing about them follows one reviewer's history.
   */
  async list(viewer: AuthUser, campaignId?: string, queue = false) {
    const pool = await this.adjudicatorPool();
    let all = await this.loadAll();
    if (this.reviews(viewer) && (await this.materialiseGold(viewer, all, pool))) {
      all = await this.loadAll();
    }
    const tasks = all.filter(
      (t) => (!campaignId || t.campaignId === campaignId) && visibleTo(t, viewer),
    );
    const adjudications = await this.adjudicationsFor(tasks.map((t) => t.id));
    const view = (t: TaskRow) => this.toView(t, viewer, adjudications.get(t.id), pool);

    if (!queue) return [...tasks].reverse().map(view);

    const actionable = tasks.filter((t) =>
      this.canAct(t, viewer, adjudications.get(t.id), pool),
    );
    if (!this.reviews(viewer)) return actionable.map(view);
    return buildQueue(actionable).map(view);
  }

  async get(id: string, viewer: AuthUser) {
    const task = await this.prisma.task.findUnique({ where: { id }, include: TASK_INCLUDE });
    if (!task || !visibleTo(task, viewer)) {
      throw new NotFoundException(`Task "${id}" not found`);
    }
    const adjudication = (await this.adjudicationsFor([id])).get(id);
    return this.toView(task, viewer, adjudication, await this.adjudicatorPool());
  }

  async create(dto: CreateTaskDto, author: AuthUser) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: dto.campaignId } });
    if (!campaign) {
      throw new NotFoundException(`Campaign "${dto.campaignId}" not found`);
    }
    const authorId = author.expertId;

    // Gold tasks calibrate reviewers, so only an admin may plant one; a public author
    // must not be able to skew the calibration set.
    if (dto.goldExpectedAccept !== undefined && author.role !== Role.ADMIN) {
      throw new ForbiddenException('Only an admin can create a gold task');
    }

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

    // The gold marker and answer never leave the API, not even in the create response.
    const {
      isGold: _isGold,
      goldExpectedAccept: _goldExpectedAccept,
      goldSourceId: _goldSourceId,
      goldForExpertId: _goldForExpertId,
      goldOpenFor: _goldOpenFor,
      ...created
    } = task;
    void [_isGold, _goldExpectedAccept, _goldSourceId, _goldForExpertId, _goldOpenFor];
    return { ...created, linted };
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

  /**
   * The stored Layer 2 results for a task: lint findings and verifier runs, with the
   * requirements and rubric items they quote by id, so a reader can name them. A task the
   * viewer may not see answers like a missing one; a gold clone has its own copy
   * (materialiseGold).
   */
  async verification(taskId: string, viewer: AuthUser) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, isGold: true, goldSourceId: true, goldForExpertId: true },
    });
    if (!task || !visibleTo(task, viewer)) {
      throw new NotFoundException(`Task "${taskId}" not found`);
    }
    const orderBy = { createdAt: 'asc' } as const;
    const [lintFindings, verifierRuns, requirements, rubricItems] = await Promise.all([
      this.prisma.lintFinding.findMany({ where: { taskId }, orderBy }),
      this.prisma.verifierRun.findMany({ where: { taskId }, orderBy }),
      this.prisma.requirement.findMany({
        where: { taskId },
        orderBy,
        select: { id: true, text: true },
      }),
      this.prisma.rubricItem.findMany({
        where: { taskId },
        orderBy,
        select: { id: true, text: true, requirementId: true },
      }),
    ]);
    // The probe tier is a difficulty answer and reviewers score difficulty, so only the
    // admin, who runs the probe, sees it. Everyone gets the field, so a gold clone (which
    // has no probe of its own) looks like any other task.
    const probeRun =
      viewer.role === Role.ADMIN
        ? await this.prisma.probeRun.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } })
        : null;
    return { taskId, lintFindings, verifierRuns, requirements, rubricItems, probeRun };
  }

  /**
   * M9 Probe Gate on a task (admin only): ask the local Ollama model to solve it
   * `dto.rollouts` times, score each attempt with the verifier against the task's
   * requirements, and store the solve rate and difficulty tier as a ProbeRun.
   *
   * Never throws for a probe that could not run: one row is stored either way and returned.
   *   OK       tier and solveRate hold the answer
   *   NOT_RUN  the verify service or Ollama could not be reached; says nothing about the task
   *   FAILED   the service answered with something unusable (an error status, a bad shape)
   * tier and solveRate stay null unless OK, so an outage is never read as a difficulty.
   * The model sees the prompt and spec only, never the reference.
   */
  async probe(taskId: string, dto: ProbeTaskDto, viewer: AuthUser): Promise<ProbeRun> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        prompt: true,
        spec: true,
        reference: true,
        isGold: true,
        goldSourceId: true,
        goldForExpertId: true,
      },
    });
    if (!task || !visibleTo(task, viewer)) {
      throw new NotFoundException(`Task "${taskId}" not found`);
    }
    const model = dto.model ?? (process.env.OLLAMA_MODEL?.trim() || DEFAULT_PROBE_MODEL);
    const row = { taskId, model, rollouts: dto.rollouts, verifierVersion: VERIFIER_VERSION };

    let data: Prisma.ProbeRunUncheckedCreateInput;
    try {
      const built = await buildPacket(task, this.verifyClient);
      const result = await this.verifyClient.probe(built.packet, model, dto.rollouts);
      data = {
        ...row,
        status: ProbeStatus.OK,
        tier: result.tier,
        solveRate: result.solve_rate,
      };
    } catch (err) {
      const unreachable =
        err instanceof VerifyUnreachableError || err instanceof ProbeModelUnreachableError;
      if (unreachable) {
        this.logger.warn(`Probe of task ${taskId} did not run: ${message(err)}`);
      } else if (err instanceof VerifyContractError) {
        this.logger.warn(`Probe of task ${taskId} failed: ${message(err)}`);
      } else {
        this.logger.error(`Probe of task ${taskId} failed unexpectedly: ${message(err)}`);
      }
      data = {
        ...row,
        status: unreachable ? ProbeStatus.NOT_RUN : ProbeStatus.FAILED,
        note: message(err).slice(0, 1000),
      };
    }
    return this.prisma.probeRun.create({ data });
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
   * A gold clone is calibration only: the review is stored on the clone, which calibration
   * scores against the answer on the gold it copies, and the clone stays in the reviewer's
   * list as a task they reviewed. A gold source is never reviewed directly.
   */
  async review(taskId: string, dto: CreateTaskReviewDto, reviewer: AuthUser) {
    const reviewerId = reviewer.expertId;

    // The rubric decides acceptance (docs/pipeline.md §2), not the client.
    const accepted = isAccepted(dto.scores);

    return this.prisma.$transaction(async (tx) => {
      // Serialise reviews of the same task, so two concurrent requests cannot both
      // see "one review so far" and write a third.
      const task = await this.lockTask(tx, taskId);
      // Before any other check: a hidden task must answer exactly like a missing id.
      if (!visibleTo(task, reviewer)) {
        throw new NotFoundException(`Task "${taskId}" not found`);
      }
      if (task.authorId === reviewerId) {
        throw new ForbiddenException('Authors cannot review their own task');
      }
      if (isGoldClone(task)) {
        return this.reviewGoldClone(tx, task, dto, accepted, reviewerId);
      }
      if (isGoldSource(task)) {
        // Only an admin gets here; gold is reviewed through a clone or not at all.
        throw new ConflictException('Task is not open for review');
      }

      const peerReviews = task.taskReviews.filter((r) => r.reviewerExpertId !== null);
      if (peerReviews.some((r) => r.reviewerExpertId === reviewerId)) {
        throw new ConflictException('This reviewer has already reviewed this task');
      }
      if (task.status !== TaskStatus.SUBMITTED && task.status !== TaskStatus.IN_REVIEW) {
        throw new ConflictException(`Task is ${task.status} and is not open for review`);
      }
      if (peerReviews.length >= REVIEWS_REQUIRED) {
        throw new ConflictException(
          `Task already has ${REVIEWS_REQUIRED} reviews and is awaiting adjudication`,
        );
      }

      const review = await tx.taskReview.create({
        data: {
          taskId,
          reviewerId: reviewerId,
          reviewerExpertId: reviewerId,
          scores: dto.scores as Prisma.InputJsonValue,
          evidence: dto.evidence as Prisma.InputJsonValue,
          accepted,
        },
      });

      const outcome = consensus([...peerReviews.map((r) => r.accepted), accepted]);
      let status: TaskStatus = TaskStatus.IN_REVIEW;
      if (outcome === 'accepted') status = TaskStatus.ACCEPTED;
      else if (outcome === 'rejected') status = TaskStatus.REJECTED;
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

      return { ...review, taskStatus: status };
    });
  }

  /**
   * The review of a gold clone, inside review()'s transaction with the clone locked. The
   * review row goes on the clone, which then reads as a task with one review: IN_REVIEW, in
   * the reviewer's list, out of their queue. Calibration finds the answer through the clone's
   * gold source. Clearing goldOpenFor lets the next clone be written when one falls due.
   */
  private async reviewGoldClone(
    tx: Tx,
    clone: TaskRow,
    dto: CreateTaskReviewDto,
    accepted: boolean,
    reviewerId: string,
  ) {
    if (clone.taskReviews.some((r) => r.reviewerExpertId === reviewerId)) {
      throw new ConflictException('This reviewer has already reviewed this task');
    }
    const review = await tx.taskReview.create({
      data: {
        taskId: clone.id,
        reviewerId: reviewerId,
        reviewerExpertId: reviewerId,
        scores: dto.scores as Prisma.InputJsonValue,
        evidence: dto.evidence as Prisma.InputJsonValue,
        accepted,
      },
    });
    // What a normal task's row says after its first review.
    const taskStatus = TaskStatus.IN_REVIEW;
    await tx.task.update({ where: { id: clone.id }, data: { status: taskStatus, goldOpenFor: null } });
    await tx.event.create({
      data: {
        actorId: reviewerId,
        type: 'task.reviewed',
        payload: {
          taskId: clone.id,
          goldSourceId: clone.goldSourceId,
          reviewId: review.id,
          reviewerId: reviewerId,
          accepted,
          outcome: 'calibration',
        } as Prisma.InputJsonValue,
      },
    });
    return { ...review, taskStatus };
  }

  /**
   * Resolve a split: a third expert, who is neither the author nor one of the two
   * reviewers, gives the final verdict with a written reason. When nobody like that exists
   * (a small team), the designated lead or an admin may adjudicate a task they wrote or
   * reviewed; the event records which conflict the escape covered (see adjudicationRight).
   */
  async adjudicate(taskId: string, dto: AdjudicateTaskDto, adjudicator: AuthUser) {
    const adjudicatorId = adjudicator.expertId;

    return this.prisma.$transaction(async (tx) => {
      const task = await this.lockTask(tx, taskId);
      // Before any other check: a hidden task must answer exactly like a missing id.
      if (!visibleTo(task, adjudicator)) {
        throw new NotFoundException(`Task "${taskId}" not found`);
      }
      if (!mayAdjudicate(adjudicator)) {
        throw new ForbiddenException(
          'This needs the adjudicator or admin role, or the lead designation',
        );
      }
      const pending = await tx.reviewDecision.findFirst({
        where: { subjectType: TASK_SUBJECT, subjectId: taskId, verdict: Verdict.NEEDS_REVIEW },
      });
      if (!pending) {
        throw new ConflictException('Task is not awaiting adjudication');
      }
      const pool = await this.adjudicatorPool(tx);
      const right = adjudicationRight(adjudicator, subjectOf(task), pool);
      if (!right.allowed) {
        const asAuthor = task.authorId === adjudicatorId;
        const who = asAuthor
          ? 'Authors cannot adjudicate their own task'
          : 'A reviewer of this task cannot also adjudicate it';
        throw new ForbiddenException(
          right.why === 'independent_available'
            ? `${who} while an independent adjudicator is available`
            : who,
        );
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
            // Null for an independent adjudicator; 'author' or 'reviewer' when the lead or an
            // admin used the small-team escape, so those decisions stay distinguishable.
            conflict: right.conflict,
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

  /**
   * Reviewer accuracy against the gold answers. A flag is a prompt to recalibrate. A gold
   * review sits on the reviewer's clone, which holds no answer: the answer is its source's.
   * (A review on a gold source itself predates clones and is scored against it directly.)
   */
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
        task: {
          select: {
            isGold: true,
            goldExpectedAccept: true,
            goldSource: { select: { goldExpectedAccept: true } },
          },
        },
      },
    });
    const names = new Map(reviews.map((r) => [r.reviewerExpertId as string, r.reviewer?.name]));
    return calibrationReport(
      reviews.map((r) => ({
        reviewerId: r.reviewerExpertId as string,
        accepted: r.accepted,
        goldExpectedAccept: r.task.isGold
          ? (r.task.goldSource?.goldExpectedAccept ?? r.task.goldExpectedAccept)
          : null,
      })),
    ).map((row) => ({ ...row, reviewerName: names.get(row.reviewerId) ?? null }));
  }

  /**
   * Verifier agreement with human verdicts (Gate 2). Over decided normal tasks, the human
   * decision (the task's ACCEPTED / REJECTED status, from consensus or adjudication) against
   * the verifier's overall result on the reference: the latest stored REFERENCE_SOLUTION run.
   * Gold rows are never decided, so they never enter. A decided task without a run is listed
   * as unverified and left out of the rate (see verifier-agreement.ts).
   *
   * Each disagreement carries what a reader needs to judge it: the prompt, the reviews'
   * verdicts, any adjudication, and every verdict of the run with its requirement named.
   */
  async verifierAgreement(campaignId?: string) {
    const tasks = await this.prisma.task.findMany({
      where: {
        isGold: false,
        status: { in: [TaskStatus.ACCEPTED, TaskStatus.REJECTED] },
        ...(campaignId ? { campaignId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        campaignId: true,
        prompt: true,
        status: true,
        taskReviews: {
          where: { reviewerExpertId: { not: null } },
          orderBy: { createdAt: 'asc' },
          select: { reviewerExpertId: true, accepted: true },
        },
        verifierRuns: {
          where: { subjectType: VerifySubjectType.REFERENCE_SOLUTION },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, verifierVersion: true, passed: true, results: true, createdAt: true },
        },
        requirements: { select: { id: true, text: true } },
      },
    });
    const adjudications = await this.adjudicationsFor(tasks.map((t) => t.id));

    const rows = tasks.map((t) => ({
      taskId: t.id,
      humanAccepted: t.status === TaskStatus.ACCEPTED,
      verifierPassed: t.verifierRuns[0]?.passed ?? null,
    }));

    const disagreements = tasks.flatMap((t, i) => {
      const kind = disagreementOf(rows[i]);
      if (kind === null) return [];
      const run = t.verifierRuns[0];
      const requirement = new Map(t.requirements.map((r) => [r.id, r.text]));
      const adjudication = adjudications.get(t.id);
      return [
        {
          taskId: t.id,
          campaignId: t.campaignId,
          prompt: t.prompt,
          kind,
          humanDecision: t.status === TaskStatus.ACCEPTED ? 'accepted' : 'rejected',
          decidedBy: adjudication && adjudication.verdict !== Verdict.NEEDS_REVIEW ? 'adjudication' : 'consensus',
          reviews: t.taskReviews.map((r) => ({ reviewerId: r.reviewerExpertId, accepted: r.accepted })),
          adjudication: adjudication
            ? { verdict: adjudication.verdict, reason: adjudication.reason }
            : null,
          verifierPassed: run.passed,
          verifierRunId: run.id,
          verifierVersion: run.verifierVersion,
          verdicts: storedVerdicts(run.results).map((v) => ({
            requirement: v.requirement_id ? (requirement.get(v.requirement_id) ?? v.requirement_id) : null,
            check: v.check,
            status: v.status,
            detail: v.detail,
          })),
        },
      ];
    });

    return {
      campaignId: campaignId ?? null,
      ...verifierAgreementStats(rows),
      disagreements,
      unverifiedTaskIds: rows.filter((r) => r.verifierPassed === null).map((r) => r.taskId),
    };
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

  /** Everyone who may adjudicate splits at all: the adjudicator and admin roles, and the lead. */
  private adjudicatorPool(tx: Tx = this.prisma): Promise<Adjudicator[]> {
    return tx.user.findMany({
      where: { OR: [{ role: { in: [Role.ADJUDICATOR, Role.ADMIN] } }, { isLead: true }] },
      select: { expertId: true, role: true, isLead: true },
    });
  }

  /** Does this user's role review tasks (and so get gold mixed into their queue)? */
  private reviews(user: AuthUser): boolean {
    return user.role === Role.REVIEWER || user.role === Role.ADMIN;
  }

  /** Every task in every campaign, oldest first. */
  private loadAll(): Promise<TaskRow[]> {
    return this.prisma.task.findMany({ orderBy: { createdAt: 'asc' }, include: TASK_INCLUDE });
  }

  /**
   * Write a gold clone for this reviewer if a gold review is due to them (goldPlace) and they
   * hold no unreviewed clone. Decided from their history over every campaign, so a campaign
   * filter does not change it. Returns whether the task set changed.
   *
   * The clone goes where the gold review is due in the reviewer's whole queue (every campaign;
   * a campaign-filtered queue only drops rows, so it never puts the clone later). At most one
   * unreviewed clone per reviewer: the unique goldOpenFor index makes a concurrent second
   * write fail, and that request then reads the clone the first one wrote.
   */
  private async materialiseGold(
    viewer: AuthUser,
    all: TaskRow[],
    pool: Adjudicator[],
  ): Promise<boolean> {
    const me = viewer.expertId;
    const reviewedByMe = (t: TaskRow) => t.taskReviews.some((r) => r.reviewerExpertId === me);
    const myClones = all.filter((t) => isGoldClone(t) && t.goldForExpertId === me);
    if (myClones.some((t) => t.goldOpenFor === me)) return false;
    const mine = all.filter(reviewedByMe);
    const done = mine.filter((t) => t.isGold).length;
    const place = goldPlace(me, mine.length, done);
    if (place === null) return false;
    const given = new Set(myClones.map((t) => t.goldSourceId));
    const candidates = all.filter(
      (t) => isGoldSource(t) && t.authorId !== me && !given.has(t.id) && !reviewedByMe(t),
    );
    const source = dueGold(me, candidates, mine.length, done);
    if (!source) return false;

    const visible = all.filter((t) => visibleTo(t, viewer));
    const adjudications = await this.adjudicationsFor(visible.map((t) => t.id));
    const queue = buildQueue(
      visible.filter((t) => this.canAct(t, viewer, adjudications.get(t.id), pool)),
    );
    try {
      await this.writeGoldClone(source, me, all, queue, place);
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
        throw err;
      }
    }
    return true;
  }

  /**
   * A task row for one reviewer, copied from a gold source, that reads as an ordinary task:
   *  - createdAt is drawn from the campaign's real task times (plausibleCreatedAt), never the
   *    request time, and the id is a cuid minted at that same time;
   *  - the id's hash puts it at `place` in the reviewer's queue (placeInQueue), so a reviewer
   *    working from the head meets it where the gold review is due;
   *  - status SUBMITTED, and its own copy of the Layer 2 rows, so GET /verification answers
   *    for it as for any task. Those rows keep the source's offsets from its createdAt, their
   *    ids are minted at their own backdated times, and the requirement and rubric item ids
   *    are drawn afresh with every lint finding and verifier verdict that quotes them
   *    rewritten, so nothing in the copy points back at the source.
   */
  private async writeGoldClone(
    source: TaskRow,
    reviewerId: string,
    all: TaskRow[],
    queue: TaskRow[],
    place: number,
  ): Promise<void> {
    const createdAt = plausibleCreatedAt(source, all, Date.now());
    // The real task written last before that time lends its fingerprint and counter.
    const neighbour = all
      .filter((t) => !t.isGold && t.createdAt.getTime() <= createdAt.getTime())
      .at(-1);
    const mint = cuidMinter(neighbour?.id ?? null);
    const cloneCounter = mint.next();
    const id = placeInQueue(queue, place, () => mint.at(createdAt, cloneCounter));
    const shifted = (t: Date) =>
      new Date(createdAt.getTime() + Math.max(0, t.getTime() - source.createdAt.getTime()));

    await this.prisma.$transaction(async (tx) => {
      const clone = await tx.task.create({
        data: {
          id,
          createdAt,
          campaignId: source.campaignId,
          authorId: source.authorId,
          prompt: source.prompt,
          spec: source.spec,
          reference: source.reference,
          status: TaskStatus.SUBMITTED,
          isGold: true,
          goldExpectedAccept: null,
          goldSourceId: source.id,
          goldForExpertId: reviewerId,
          goldOpenFor: reviewerId,
        },
      });
      const where = { taskId: source.id };
      const orderBy = { createdAt: 'asc' } as const;
      const [requirements, rubricItems, lintFindings, verifierRuns] = await Promise.all([
        tx.requirement.findMany({ where, orderBy }),
        tx.rubricItem.findMany({ where, orderBy }),
        tx.lintFinding.findMany({ where, orderBy }),
        tx.verifierRun.findMany({ where, orderBy }),
      ]);
      const ids = new Map<string, string>(
        [...requirements, ...rubricItems].map((r) => [r.id, randomUUID()]),
      );
      const rekey = (text: string) =>
        [...ids].reduce((out, [from, to]) => out.split(from).join(to), text);

      if (requirements.length > 0) {
        await tx.requirement.createMany({
          data: requirements.map((r) => ({
            id: ids.get(r.id) as string,
            taskId: clone.id,
            text: r.text,
            kind: r.kind,
            value: r.value,
            tolerance: r.tolerance,
            createdAt: shifted(r.createdAt),
          })),
        });
      }
      if (rubricItems.length > 0) {
        await tx.rubricItem.createMany({
          data: rubricItems.map((i) => ({
            id: ids.get(i.id) as string,
            taskId: clone.id,
            requirementId: i.requirementId === null ? null : (ids.get(i.requirementId) ?? null),
            text: i.text,
            checkMethod: i.checkMethod,
            weight: i.weight,
            createdAt: shifted(i.createdAt),
          })),
        });
      }
      if (lintFindings.length > 0) {
        await tx.lintFinding.createMany({
          data: lintFindings.map((f) => {
            const at = shifted(f.createdAt);
            return {
              id: mint.at(at, mint.next()),
              taskId: clone.id,
              rule: f.rule,
              severity: f.severity,
              detail: f.detail === null ? null : rekey(f.detail),
              resolved: f.resolved,
              createdAt: at,
            };
          }),
        });
      }
      for (const run of verifierRuns) {
        const at = shifted(run.createdAt);
        await tx.verifierRun.create({
          data: {
            id: mint.at(at, mint.next()),
            taskId: clone.id,
            subjectType: run.subjectType,
            // The reference lives on the task row, so its subject is the task itself.
            subjectId: run.subjectId === source.id ? clone.id : run.subjectId,
            verifierVersion: run.verifierVersion,
            results: JSON.parse(rekey(JSON.stringify(run.results))) as Prisma.InputJsonValue,
            passed: run.passed,
            createdAt: at,
          },
        });
      }
      // Admin-side audit trail: the event keeps the real time it was written.
      await tx.event.create({
        data: {
          actorId: null,
          type: 'task.gold_cloned',
          payload: {
            taskId: clone.id,
            goldSourceId: source.id,
            reviewerId,
            queuePlace: place,
          } as Prisma.InputJsonValue,
        },
      });
    });
  }

  /**
   * May this user act on this task right now? Reviewers see tasks open for a peer review
   * (their own gold clone included), adjudicators see split tasks, an admin sees both, an
   * author neither. A split the user wrote or reviewed shows up only for the lead or an admin,
   * and only while nobody independent can adjudicate it (adjudicationRight).
   */
  private canAct(
    task: TaskRow,
    user: AuthUser,
    adjudication: ReviewDecision | undefined,
    pool: Adjudicator[],
  ): boolean {
    const expertId = user.expertId;
    const reviews = user.role === Role.REVIEWER || user.role === Role.ADMIN;
    if (awaitsAdjudication(task, adjudication)) {
      return adjudicationRight(user, subjectOf(task), pool).allowed;
    }
    if (task.authorId === expertId) return false;
    if (task.taskReviews.some((r) => r.reviewerExpertId === expertId)) return false;
    if (isGoldClone(task)) return reviews && task.goldForExpertId === expertId;
    // A gold source is reviewed only through a clone.
    if (task.isGold) return false;
    if (!reviews) return false;
    const open = task.status === TaskStatus.SUBMITTED || task.status === TaskStatus.IN_REVIEW;
    const peerReviews = task.taskReviews.filter((r) => r.reviewerExpertId !== null);
    return open && peerReviews.length < REVIEWS_REQUIRED;
  }

  /**
   * The shape the API returns. Three things are deliberately withheld:
   *  - gold markers and the gold answer, or calibration would measure nothing;
   *  - updatedAt, which would show which rows a review never wrote (gold ones);
   *  - reviews' scores, evidence and verdict while a second review is still open, so
   *    that review (and the agreement statistic built on it) stays independent. Full
   *    reviews release once the two reviewers are done — at adjudication and after the
   *    decision — to anyone who can see the task, so the adjudicator can see the dispute.
   * A gold row (a clone to its one reviewer, a source to an admin) is presented as an
   * ordinary task in the state the viewer's own actions would have left it: nobody has
   * reviewed it yet, or it has their one review and waits for a second (a clone they
   * reviewed, or a source an admin reviewed before clones existed). Other reviewers' gold
   * reviews are never shown.
   *
   * Review is blind: reviewers and adjudicators get `authorId` and `author` as null. Only an
   * admin writes gold, so an admin author would otherwise mark every gold task. Admins and a
   * task's own author still see who wrote it.
   */
  private toView(
    task: TaskRow,
    viewer: AuthUser,
    adjudication: ReviewDecision | undefined,
    pool: Adjudicator[],
  ) {
    // updatedAt is withheld for every task: a clone's is the real time it was written, which
    // would undo its backdated createdAt, and update times would tell gold rows apart.
    const {
      isGold,
      goldExpectedAccept,
      goldSourceId,
      goldForExpertId,
      goldOpenFor,
      updatedAt,
      taskReviews,
      ...row
    } = task;
    void [goldExpectedAccept, goldSourceId, goldForExpertId, goldOpenFor, updatedAt];
    // A lead adjudicates whatever their role, so a non-admin lead is blind like an adjudicator.
    const blind =
      (viewer.role === Role.REVIEWER ||
        viewer.role === Role.ADJUDICATOR ||
        (viewer.isLead && viewer.role !== Role.ADMIN)) &&
      task.authorId !== viewer.expertId;
    const rest = blind ? { ...row, authorId: null, author: null } : row;

    if (isGold) {
      const own = taskReviews.find((r) => r.reviewerExpertId === viewer.expertId);
      if (!own) {
        return {
          ...rest,
          status: TaskStatus.SUBMITTED,
          reviewState: 'awaiting_reviews' as ReviewState,
          taskReviews: [],
          adjudication: null,
          canAdjudicate: false,
        };
      }
      return {
        ...rest,
        status: TaskStatus.IN_REVIEW,
        reviewState: 'awaiting_reviews' as ReviewState,
        taskReviews: [redactedReview(own)],
        adjudication: null,
        canAdjudicate: false,
      };
    }

    const decided = task.status === TaskStatus.ACCEPTED || task.status === TaskStatus.REJECTED;
    const awaitingAdjudication = awaitsAdjudication(task, adjudication);
    const reviewState: ReviewState = decided
      ? 'decided'
      : awaitingAdjudication
        ? 'awaiting_adjudication'
        : 'awaiting_reviews';

    return {
      ...rest,
      reviewState,
      taskReviews: taskReviews.map((r) =>
        decided || awaitingAdjudication ? r : redactedReview(r),
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
      // May this viewer resolve the split now? Server-side, because the client cannot know
      // whether an independent adjudicator exists (adjudicationRight).
      canAdjudicate:
        awaitingAdjudication && adjudicationRight(viewer, subjectOf(task), pool).allowed,
    };
  }
}
