import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ExpertStatus, Prisma, Verdict } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DecideReviewDto } from './dto/decide-review.dto';

// ReviewDecision is polymorphic; this module only handles intake runs.
const INTAKE_RUN_SUBJECT = 'intake_run';

// Stored when a human decides without identifying themselves (reviewerId is non-null).
const ANONYMOUS_REVIEWER = 'anonymous-reviewer';

export interface QueueItem {
  decisionId: string;
  runId: string;
  expertId: string;
  expertName: string;
  postingId: string;
  postingTitle: string;
  confidence: number;
  scores: unknown;
  reason: string | null;
  createdAt: Date;
}

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Low-confidence intake runs awaiting a human verdict, newest first. */
  async listQueue(): Promise<QueueItem[]> {
    const decisions = await this.prisma.reviewDecision.findMany({
      where: { subjectType: INTAKE_RUN_SUBJECT, verdict: Verdict.NEEDS_REVIEW },
      orderBy: { createdAt: 'desc' },
    });
    if (decisions.length === 0) return [];

    // One query for all runs instead of one per decision.
    const runs = await this.prisma.intakeRun.findMany({
      where: { id: { in: decisions.map((d) => d.subjectId) } },
      include: { expert: true, posting: true },
    });
    const runsById = new Map(runs.map((r) => [r.id, r]));

    const items: QueueItem[] = [];
    for (const d of decisions) {
      const run = runsById.get(d.subjectId);
      if (!run) {
        // subjectId has no FK; skip orphans rather than failing the whole queue.
        this.logger.warn(`Review decision ${d.id} points at missing intake run ${d.subjectId}`);
        continue;
      }
      items.push({
        decisionId: d.id,
        runId: run.id,
        expertId: run.expertId,
        expertName: run.expert.name,
        postingId: run.postingId,
        postingTitle: run.posting.title,
        confidence: run.confidence,
        scores: run.scores,
        reason: d.reason,
        createdAt: d.createdAt,
      });
    }
    return items;
  }

  /** Resolve a queued intake review: update the decision, the expert's status, and the audit log. */
  async decide(decisionId: string, dto: DecideReviewDto) {
    const decision = await this.prisma.reviewDecision.findUnique({ where: { id: decisionId } });
    if (!decision || decision.subjectType !== INTAKE_RUN_SUBJECT) {
      throw new NotFoundException(`Review decision "${decisionId}" not found`);
    }
    if (decision.verdict !== Verdict.NEEDS_REVIEW) {
      throw new ConflictException(
        `Review decision "${decisionId}" is already resolved (${decision.verdict})`,
      );
    }

    const run = await this.prisma.intakeRun.findUnique({ where: { id: decision.subjectId } });
    if (!run) {
      throw new NotFoundException(`Intake run "${decision.subjectId}" for this decision not found`);
    }

    const verdict = dto.verdict === 'approve' ? Verdict.APPROVE : Verdict.REJECT;
    const expertStatus =
      verdict === Verdict.APPROVE ? ExpertStatus.ACCEPTED : ExpertStatus.REJECTED;
    const reviewerId = dto.reviewerId ?? ANONYMOUS_REVIEWER;

    // Event.actorId is an FK to Expert. Use the reviewer only if they are an Expert row;
    // otherwise attribute to the screened expert and keep reviewerId in the payload.
    const reviewerIsExpert = dto.reviewerId
      ? (await this.prisma.expert.count({ where: { id: dto.reviewerId } })) > 0
      : false;
    const actorId = reviewerIsExpert ? dto.reviewerId! : run.expertId;

    return this.prisma.$transaction(async (tx) => {
      // Guarded update: if a concurrent request resolved it first, count is 0.
      const { count } = await tx.reviewDecision.updateMany({
        where: { id: decisionId, verdict: Verdict.NEEDS_REVIEW },
        data: { verdict, reason: dto.reason ?? decision.reason, reviewerId },
      });
      if (count === 0) {
        throw new ConflictException(`Review decision "${decisionId}" is already resolved`);
      }

      await tx.expert.update({ where: { id: run.expertId }, data: { status: expertStatus } });

      await tx.event.create({
        data: {
          actorId,
          type: 'review.decided',
          payload: {
            decisionId,
            runId: run.id,
            verdict,
            reviewerId,
          } as Prisma.InputJsonValue,
        },
      });

      return tx.reviewDecision.findUniqueOrThrow({ where: { id: decisionId } });
    });
  }

  /** All intake-run review decisions (pending and resolved) as CSV, newest first. */
  async exportCsv(): Promise<string> {
    const decisions = await this.prisma.reviewDecision.findMany({
      where: { subjectType: INTAKE_RUN_SUBJECT },
      orderBy: { createdAt: 'desc' },
    });
    const runs = await this.prisma.intakeRun.findMany({
      where: { id: { in: decisions.map((d) => d.subjectId) } },
      include: { expert: true, posting: true },
    });
    const runsById = new Map(runs.map((r) => [r.id, r]));

    const header = [
      'decision_id',
      'run_id',
      'expert_id',
      'expert_name',
      'expert_status',
      'posting_title',
      'confidence',
      'verdict',
      'reviewer_id',
      'reason',
      'prompt_version',
      'created_at',
    ];
    const rows = decisions.map((d) => {
      const run = runsById.get(d.subjectId);
      return [
        d.id,
        d.subjectId,
        run?.expertId ?? '',
        run?.expert.name ?? '',
        run?.expert.status ?? '',
        run?.posting.title ?? '',
        run ? run.confidence.toFixed(3) : '',
        d.verdict,
        d.reviewerId,
        d.reason ?? '',
        run?.promptVersion ?? '',
        d.createdAt.toISOString(),
      ];
    });

    return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
  }
}

/** RFC 4180 quoting; also neutralises spreadsheet formula injection. */
function csvField(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}
