import type { LLMProvider, LLMCapabilities, LLMOptions, HealthCheckResult } from '../provider.js'
import type { ZodSchema } from 'zod'

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama'
  readonly name = 'Ollama (Local)'
  readonly capabilities: LLMCapabilities = {
    embedding: true,
    codeUnderstanding: true,
    longContext: false,
    streaming: true,
    structured: true,
  }

  constructor(private readonly baseUrl: string) {}

  async generateText(prompt: string, options?: LLMOptions): Promise<string> {
    const model = process.env.OLLAMA_CODE_MODEL ?? 'deepseek-coder-v2:16b'
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: options?.systemPrompt
          ? `${options.systemPrompt}\n\n${prompt}`
          : prompt,
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.1,
          num_predict: options?.maxTokens ?? 2048,
        },
      }),
    })
    if (!res.ok) throw new Error(`Ollama error: ${res.status}`)
    const data = (await res.json()) as { response: string }
    return data.response
  }

  async generateJSON<T>(prompt: string, schema: ZodSchema<T>): Promise<T> {
    const text = await this.generateText(
      `${prompt}\n\nRespond ONLY with valid JSON. No markdown, no explanation.`,
      { temperature: 0 }
    )
    const jsonStr = text.replace(/```json\n?|\n?```/g, '').trim()
    return schema.parse(JSON.parse(jsonStr))
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const model = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text'
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    })
    if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`)
    const data = (await res.json()) as { embeddings: number[][] }
    return data.embeddings[0]
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now()
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`)
      const data = (await res.json()) as { models?: Array<{ name: string }> }
      return {
        ok: res.ok,
        latencyMs: Date.now() - start,
        model: data.models?.[0]?.name ?? 'unknown',
      }
    } catch {
      return { ok: false, latencyMs: Date.now() - start, model: 'unreachable' }
    }
  }
}
