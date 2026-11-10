import { Logger, ServiceUnavailableException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { BASE_SYSTEM_PROMPT, buildUserPrompt, normaliseScores, scoresJsonSchema } from './prompt';
import { IntakeAssessment, LlmScoringProvider, RawScores, RubricCriterion } from './types';

// Unchanged from the original M1 prompt; bump when it changes.
export const ANTHROPIC_PROMPT_VERSION = 'intake-v1';

// Approximate USD per million tokens (input, output).
const PRICE_USD_PER_MTok: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
};
const DEFAULT_PRICE = { input: 3, output: 15 };

/** Optional Claude backend. Selected with LLM_PROVIDER=anthropic. */
export class AnthropicProvider implements LlmScoringProvider {
  readonly name = 'anthropic';
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly client: Anthropic | null;
  private readonly model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514';

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.client) {
      this.logger.warn('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set — intake scoring will fail');
    }
  }

  get promptVersion(): string {
    return `${ANTHROPIC_PROMPT_VERSION}@anthropic/${this.model}`;
  }

  async scoreCv(cv: string, posting: string, criteria: RubricCriterion[]): Promise<IntakeAssessment> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'ANTHROPIC_API_KEY is not set. Add it to apps/api/.env (or set LLM_PROVIDER=ollama) and restart the API.',
      );
    }

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: BASE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(posting, criteria, cv) }],
      tools: [
        {
          name: 'submit_scores',
          description: 'Submit the rubric scores for this CV',
          input_schema: scoresJsonSchema(criteria, false) as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_scores' },
    });

    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      throw new Error('Model did not return structured scores');
    }

    const { scores, overallConfidence } = normaliseScores(block.input as RawScores, criteria);
    const inputTokens = res.usage?.input_tokens ?? 0;
    const outputTokens = res.usage?.output_tokens ?? 0;
    const price = PRICE_USD_PER_MTok[this.model] ?? DEFAULT_PRICE;

    return {
      scores,
      overallConfidence,
      usage: { inputTokens, outputTokens },
      model: this.model,
      costUsd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000,
    };
  }
}
