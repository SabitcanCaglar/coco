import type { ZodSchema } from 'zod'

export interface LLMOptions {
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
}

export interface LLMCapabilities {
  embedding: boolean
  codeUnderstanding: boolean
  longContext: boolean
  streaming: boolean
  structured: boolean
}

export interface HealthCheckResult {
  ok: boolean
  latencyMs: number
  model: string
}

export interface LLMProvider {
  readonly id: string
  readonly name: string
  readonly capabilities: LLMCapabilities

  generateText(prompt: string, options?: LLMOptions): Promise<string>
  generateJSON<T>(prompt: string, schema: ZodSchema<T>, options?: LLMOptions): Promise<T>
  generateEmbedding(text: string): Promise<number[]>
  healthCheck(): Promise<HealthCheckResult>
}
