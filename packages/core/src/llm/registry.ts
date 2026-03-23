import type { LLMProvider, LLMCapabilities } from './provider.js'
import { OllamaProvider } from './providers/ollama.js'
import { AnthropicProvider } from './providers/anthropic.js'
import { NullProvider } from './providers/null.js'

const PRIORITY_ORDER = ['anthropic', 'openai', 'ollama', 'null'] as const

export class LLMRegistry {
  private readonly providers = new Map<string, LLMProvider>()
  private defaultId = 'null'

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider)
  }

  setDefault(id: string): void {
    if (!this.providers.has(id)) throw new Error(`Provider not registered: ${id}`)
    this.defaultId = id
  }

  /**
   * Auto-discover providers from environment.
   * Priority: anthropic > openai > ollama > null
   */
  async autoDiscover(): Promise<void> {
    // Always register null as fallback
    this.register(new NullProvider())

    // Ollama — check if reachable
    const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434'
    const ollama = new OllamaProvider(ollamaUrl)
    const ollamaHealth = await ollama.healthCheck().catch(() => ({ ok: false }))
    if (ollamaHealth.ok) {
      this.register(ollama)
      this.defaultId = 'ollama'
    }

    if (process.env.OPENAI_API_KEY) {
      // OpenAI provider — yüklü değilse skip (optional dependency)
      try {
        const { OpenAIProvider } = await import('./providers/openai.js')
        this.register(new OpenAIProvider(process.env.OPENAI_API_KEY))
        if (!process.env.ANTHROPIC_API_KEY) this.defaultId = 'openai'
      } catch {
        // openai package not installed — skip
      }
    }

    if (process.env.ANTHROPIC_API_KEY) {
      this.register(new AnthropicProvider(process.env.ANTHROPIC_API_KEY))
      this.defaultId = 'anthropic'
    }
  }

  get(id?: string): LLMProvider {
    const provider = this.providers.get(id ?? this.defaultId)
    if (!provider) throw new Error(`Provider not found: ${id ?? this.defaultId}`)
    return provider
  }

  /** Return best provider for a specific capability */
  getBestFor(capability: keyof LLMCapabilities): LLMProvider {
    for (const id of PRIORITY_ORDER) {
      const p = this.providers.get(id)
      if (p?.capabilities[capability]) return p
    }
    return this.get()
  }

  list(): Array<{ id: string; name: string; isDefault: boolean; capabilities: LLMCapabilities }> {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      isDefault: p.id === this.defaultId,
      capabilities: p.capabilities,
    }))
  }
}
