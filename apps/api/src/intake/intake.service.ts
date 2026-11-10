import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Verdict } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnthropicService, RubricCriterion } from './anthropic.service';
import { RunIntakeDto } from './dto/run-intake.dto';

// Below this, the run is routed to a human for review.
const LOW_CONFIDENCE_THRESHOLD = 0.7;

// Approximate USD per million tokens (input, output). Configurable per model.
const PRICE_USD_PER_MTok: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
};

@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicService,
  ) {}

  async runIntake(dto: RunIntakeDto) {
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
    const assessment = await this.anthropic.scoreCv(dto.cv, postingText, criteria);
    const latencyMs = Date.now() - startedAt;

    const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514';
    const price = PRICE_USD_PER_MTok[model] ?? { input: 3, output: 15 };
    const cost =
      (assessment.usage.inputTokens * price.input +
        assessment.usage.outputTokens * price.output) /
      1_000_000;

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
        promptVersion: this.anthropic.promptVersion,
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

    // Append-only audit log.
    await this.prisma.event.create({
      data: {
        actorId: expertId,
        type: 'intake.run',
        payload: {
          runId: run.id,
          postingId: posting.id,
          needsReview,
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
      promptVersion: this.anthropic.promptVersion,
    };
  }
}
