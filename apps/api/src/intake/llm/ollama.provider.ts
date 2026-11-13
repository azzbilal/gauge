import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  buildUserPrompt,
  examplesForRubric,
  fewShotMessages,
  FEWSHOT_SYSTEM_PROMPT,
  loadFewShotExamples,
  normaliseScores,
  scoresJsonSchema,
} from './prompt';
import { IntakeAssessment, LlmScoringProvider, RawScores, RubricCriterion } from './types';

export const OLLAMA_PROMPT_VERSION = 'intake-v4-fewshot';

interface OllamaChatResponse {
  model: string;
  message?: { role: string; content: string };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * Scores CVs with a local Ollama model. Claude-authored worked examples
 * (examples.json) are injected as prior turns so the small model copies
 * Claude's rubric calibration and reasoning style.
 *
 * This uses Ollama's native /api/chat rather than /v1/chat/completions because only the native
 * API lets us set num_ctx. The few-shot prompt is ~3.5k tokens plus the CV (measured 3.8k
 * with a short CV), and Ollama silently truncates anything past the loaded context window.
 * A base URL ending in /v1 is accepted and stripped.
 */
export class OllamaProvider implements LlmScoringProvider {
  readonly name = 'ollama';
  private readonly logger = new Logger(OllamaProvider.name);
  private readonly baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, '');
  private readonly model = process.env.OLLAMA_MODEL ?? 'qwen3.5:9b-q4_K_M';
  private readonly numCtx = Number(process.env.OLLAMA_NUM_CTX ?? 16384);
  private readonly timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? 300_000);
  private readonly maxAttempts = 2;

  get promptVersion(): string {
    return `${OLLAMA_PROMPT_VERSION}@ollama/${this.model}`;
  }

  constructor() {
    const n = loadFewShotExamples().length;
    this.logger.log(`Using local model ${this.model} at ${this.baseUrl} (num_ctx=${this.numCtx}, ${n} few-shot examples)`);
  }

  async scoreCv(cv: string, posting: string, criteria: RubricCriterion[]): Promise<IntakeAssessment> {
    const examples = examplesForRubric(loadFewShotExamples(), criteria);
    if (examples.length === 0) {
      this.logger.warn('No few-shot examples match this rubric; scoring zero-shot');
    }

    const messages = [
      { role: 'system', content: FEWSHOT_SYSTEM_PROMPT },
      ...fewShotMessages(examples, criteria),
      { role: 'user', content: buildUserPrompt(posting, criteria, cv) },
    ];

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await this.chat(messages, criteria);
      try {
        if (attempt > 1) this.logger.log(`Retry ${attempt} succeeded after corrective feedback`);
        const raw = JSON.parse(res.message?.content ?? '') as RawScores;
        const { scores, overallConfidence } = normaliseScores(raw, criteria);
        return {
          scores,
          overallConfidence,
          reasoning: raw.reasoning,
          usage: { inputTokens: res.prompt_eval_count ?? 0, outputTokens: res.eval_count ?? 0 },
          model: res.model ?? this.model,
          costUsd: 0,
        };
      } catch (err) {
        lastError = err;
        this.logger.warn(`Attempt ${attempt}/${this.maxAttempts}: invalid model output (${(err as Error).message})`);
        // Temperature is 0, so resending the same prompt would repeat the same answer.
        // Show the model its output and the validation error so the retry can differ.
        messages.push(
          { role: 'assistant', content: res.message?.content ?? '' },
          {
            role: 'user',
            content:
              `That response was invalid: ${(err as Error).message}. ` +
              `Return exactly one score for each criterion id [${criteria.map((c) => c.id).join(', ')}] using the same JSON format.`,
          },
        );
      }
    }
    throw new ServiceUnavailableException(`Local model returned invalid scores: ${(lastError as Error)?.message}`);
  }

  private async chat(messages: { role: string; content: string }[], criteria: RubricCriterion[]): Promise<OllamaChatResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          think: false,
          format: scoresJsonSchema(criteria, true),
          options: { temperature: 0, num_ctx: this.numCtx },
        }),
      });
    } catch (err) {
      throw new ServiceUnavailableException(
        `Cannot reach Ollama at ${this.baseUrl} (${(err as Error).message}). Is "ollama serve" running?`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as OllamaChatResponse;
    if (!res.ok || body.error) {
      throw new ServiceUnavailableException(`Ollama error ${res.status}: ${body.error ?? res.statusText}`);
    }
    if (body.prompt_eval_count && body.prompt_eval_count >= this.numCtx) {
      this.logger.warn(`Prompt (${body.prompt_eval_count} tokens) filled num_ctx=${this.numCtx}; examples may be truncated`);
    }
    return body;
  }
}
