import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

export interface RubricCriterion {
  id: string;
  label: string;
  description: string;
  weight?: number;
}

export interface CriterionScore {
  criterionId: string;
  label: string;
  score: number;
  evidence: string;
  confidence: number;
}

export interface IntakeAssessment {
  scores: CriterionScore[];
  overallConfidence: number;
  usage: { inputTokens: number; outputTokens: number };
}

// Bump this whenever the prompt changes; it is stored on every run.
export const INTAKE_PROMPT_VERSION = 'intake-v1';

interface StructuredScores {
  scores: { criterionId: string; score: number; evidence: string; confidence: number }[];
  overallConfidence: number;
}

@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);
  private readonly client: Anthropic | null;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.client) {
      this.logger.warn('ANTHROPIC_API_KEY is not set — intake scoring is disabled until it is provided');
    }
  }

  get promptVersion(): string {
    return INTAKE_PROMPT_VERSION;
  }

  async scoreCv(cv: string, posting: string, criteria: RubricCriterion[]): Promise<IntakeAssessment> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'ANTHROPIC_API_KEY is not set. Add it to apps/api/.env and restart the API.',
      );
    }

    const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514';

    const system =
      'You score a candidate CV against a job posting using a fixed rubric. ' +
      'For each criterion return an integer score from 0 to 5, a direct evidence quote from the CV ' +
      '(or "no evidence" if absent), and a confidence from 0 to 1. Be strict and honest; never invent evidence.';

    const user = [
      `Posting:\n${posting}`,
      `Rubric criteria:\n${JSON.stringify(criteria)}`,
      `CV:\n${cv}`,
    ].join('\n\n');

    const res = await this.client.messages.create({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [
        {
          name: 'submit_scores',
          description: 'Submit the rubric scores for this CV',
          input_schema: {
            type: 'object',
            properties: {
              scores: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    criterionId: { type: 'string' },
                    score: { type: 'number' },
                    evidence: { type: 'string' },
                    confidence: { type: 'number' },
                  },
                  required: ['criterionId', 'score', 'evidence', 'confidence'],
                },
              },
              overallConfidence: { type: 'number' },
            },
            required: ['scores', 'overallConfidence'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_scores' },
    });

    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      throw new Error('Model did not return structured scores');
    }

    const input = block.input as StructuredScores;
    const byId = new Map(criteria.map((c) => [c.id, c]));

    const scores: CriterionScore[] = input.scores.map((s) => ({
      criterionId: s.criterionId,
      label: byId.get(s.criterionId)?.label ?? s.criterionId,
      score: s.score,
      evidence: s.evidence,
      confidence: s.confidence,
    }));

    return {
      scores,
      overallConfidence: input.overallConfidence,
      usage: {
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
      },
    };
  }
}
