import type { LLMProvider, LLMCapabilities, LLMOptions, HealthCheckResult } from '../provider.js'
import type { ZodSchema } from 'zod'

const DEFAULT_MODEL = 'claude-sonnet-4-6'

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic'
  readonly name = 'Claude (Anthropic)'
  readonly capabilities: LLMCapabilities = {
    embedding: false,       // Anthropic embedding yok — Ollama'ya fallback
    codeUnderstanding: true,
    longContext: true,      // 200K context
    streaming: true,
    structured: true,
  }

  constructor(private readonly apiKey: string) {}

  async generateText(prompt: string, options?: LLMOptions): Promise<string> {
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: options?.maxTokens ?? 4096,
        system: options?.systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic error: ${res.status}`)
    const data = (await res.json()) as { content: Array<{ text: string }> }
    return data.content[0].text
  }

  async generateJSON<T>(prompt: string, schema: ZodSchema<T>): Promise<T> {
    const text = await this.generateText(`${prompt}\n\nRespond with valid JSON only.`, {
      temperature: 0,
    })
    const jsonStr = text.replace(/```json\n?|\n?```/g, '').trim()
    return schema.parse(JSON.parse(jsonStr))
  }

  async generateEmbedding(_text: string): Promise<number[]> {
    throw new Error('Anthropic does not support embeddings. Use Ollama for embeddings.')
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now()
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      })
      return { ok: res.ok, latencyMs: Date.now() - start, model: DEFAULT_MODEL }
    } catch {
      return { ok: false, latencyMs: Date.now() - start, model: DEFAULT_MODEL }
    }
  }
}
