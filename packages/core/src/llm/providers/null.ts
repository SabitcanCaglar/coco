import type { LLMProvider, LLMCapabilities, HealthCheckResult } from '../provider.js'
import type { ZodSchema } from 'zod'

/**
 * NullProvider — system continues to work without an LLM.
 * All deterministic analysis (AST, graph, static analysis) works.
 * Only explanation generation and ADR writing are disabled.
 */
export class NullProvider implements LLMProvider {
  readonly id = 'null'
  readonly name = 'No LLM (Deterministic Only)'
  readonly capabilities: LLMCapabilities = {
    embedding: false,
    codeUnderstanding: false,
    longContext: false,
    streaming: false,
    structured: false,
  }

  async generateText(): Promise<string> {
    return '[LLM not available — run `ollama serve` or set ANTHROPIC_API_KEY]'
  }

  async generateJSON<T>(_prompt: string, _schema: ZodSchema<T>): Promise<T> {
    throw new Error(
      'LLM required for JSON generation. Run `ollama serve` or set ANTHROPIC_API_KEY.'
    )
  }

  async generateEmbedding(): Promise<number[]> {
    throw new Error(
      'Embedding model required. Run `ollama pull nomic-embed-text`.'
    )
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: true, latencyMs: 0, model: 'none' }
  }
}
