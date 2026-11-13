import { Provider } from '@nestjs/common';
import { AnthropicProvider } from './anthropic.provider';
import { OllamaProvider } from './ollama.provider';
import { LLM_PROVIDER, LlmScoringProvider } from './types';

/**
 * Chooses the scoring backend from LLM_PROVIDER (default: "ollama").
 * Only the selected provider is constructed.
 */
export function createLlmProvider(): LlmScoringProvider {
  const choice = (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase();
  switch (choice) {
    case 'ollama':
      return new OllamaProvider();
    case 'anthropic':
      return new AnthropicProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER "${choice}" (expected "ollama" or "anthropic")`);
  }
}

/** The Nest provider; the golden-set harness calls createLlmProvider() directly. */
export const llmProvider: Provider = {
  provide: LLM_PROVIDER,
  useFactory: createLlmProvider,
};
