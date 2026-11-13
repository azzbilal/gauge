import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Verdict } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LLM_PROVIDER, LlmScoringProvider, RubricCriterion } from './llm/types';
import { RunIntakeDto } from './dto/run-intake.dto';
import { SlackService } from '../slack/slack.service';
import { AuthUser } from '../auth/auth.decorators';

// Below this, the run is routed to a human for review.
const LOW_CONFIDENCE_THRESHOLD = 0.7;

@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmScoringProvider,
    private readonly slack: SlackService,
  ) {}

  /** `dto.expertId` is who is screened; `actor` (the signed-in user) is who ran it. */
  async runIntake(dto: RunIntakeDto, actor: AuthUser) {
    const posting = await this.prisma.posting.findUnique({
      where: { id: dto.postingId },
      include: { rubric: true },
    });
    if (!posting) {
      throw new NotFoundException(`Posting "${dto.postingId}" not found`);
    }

    const criteria = posting.rubric.criteria as unknown as RubricCriterion[];
    const postingText = [posting.title, posting.description].filter(Boolean).join('\n');

    // Resolve or create the expert being screened.
    let expertId = dto.expertId;
    if (!expertId) {
      const expert = await this.prisma.expert.create({
        data: { name: dto.expertName ?? 'Anonymous', domain: 'CAD' },
      });
      expertId = expert.id;
    }

    const startedAt = Date.now();
    const assessment = await this.llm.scoreCv(dto.cv, postingText, criteria);
    const latencyMs = Date.now() - startedAt;

    const cost = assessment.costUsd;

    const minConfidence = Math.min(
      assessment.overallConfidence,
      ...assessment.scores.map((s) => s.confidence),
    );
    const needsReview =
      assessment.overallConfidence < LOW_CONFIDENCE_THRESHOLD ||
      minConfidence < LOW_CONFIDENCE_THRESHOLD;

    const run = await this.prisma.intakeRun.create({
      data: {
        expertId,
        postingId: posting.id,
        scores: assessment.scores as unknown as Prisma.InputJsonValue,
        confidence: assessment.overallConfidence,
        promptVersion: this.llm.promptVersion,
        cost,
        latencyMs,
      },
    });

    // Low-confidence runs go into the human review queue.
    if (needsReview) {
      await this.prisma.reviewDecision.create({
        data: {
          subjectType: 'intake_run',
          subjectId: run.id,
          reviewerId: 'system',
          verdict: Verdict.NEEDS_REVIEW,
          reason: `low confidence: overall ${assessment.overallConfidence.toFixed(2)}, min criterion ${minConfidence.toFixed(2)}`,
        },
      });
    }

    // Alert reviewers. SlackService never throws, so this cannot fail the run.
    if (needsReview) {
      const expert = await this.prisma.expert.findUnique({
        where: { id: expertId },
        select: { name: true },
      });
      await this.slack.alertLowConfidence({
        runId: run.id,
        expertName: expert?.name ?? expertId,
        postingTitle: posting.title,
        confidence: assessment.overallConfidence,
        needsReview,
      });
    }

    // Append-only audit log. The actor is the signed-in user's Expert row (Event.actorId is
    // an FK to Expert), never the body's expertId, which only names the screened expert.
    await this.prisma.event.create({
      data: {
        actorId: actor.expertId,
        type: 'intake.run',
        payload: {
          runId: run.id,
          postingId: posting.id,
          subjectExpertId: expertId,
          needsReview,
          provider: this.llm.name,
          model: assessment.model,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      runId: run.id,
      postingId: posting.id,
      expertId,
      scores: assessment.scores,
      confidence: assessment.overallConfidence,
      needsReview,
      cost,
      latencyMs,
      promptVersion: this.llm.promptVersion,
      provider: this.llm.name,
      model: assessment.model,
      reasoning: assessment.reasoning,
      usage: assessment.usage,
    };
  }
}
