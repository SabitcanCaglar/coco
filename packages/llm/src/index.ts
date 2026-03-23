import { pathToFileURL } from 'node:url'
import type {
  CocoPluginModule,
  LLMProviderContract,
  LLMProviderPlugin,
  LLMRequest,
  LLMResponse,
  ModelReference,
  ProviderResolution,
} from '@coco/core'
import { resolvePluginEntrypoints, validatePluginModule } from '@coco/core'

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
const DEFAULT_OLLAMA_MODEL = 'qwen3-coder:30b'

export interface ProviderSelection {
  provider?: string
  model?: string
}

export interface LLMRegistryConfig {
  pluginPaths?: string[]
}

const NULL_MODEL: ModelReference = {
  provider: 'null',
  name: 'deterministic-fallback',
  family: 'null',
  supportsJson: true,
  supportsTools: false,
}

export class NullProvider implements LLMProviderContract {
  readonly name: string = 'null'
  readonly models = [NULL_MODEL]

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const reason =
      request.responseFormat === 'json' ? '{"reason":"llm-unavailable"}' : 'LLM unavailable'
    return {
      model: NULL_MODEL,
      content: reason,
      finishReason: 'error',
      usage: {
        input: 0,
        output: 0,
        total: 0,
      },
    }
  }
}

export class OllamaProvider implements LLMProviderContract {
  readonly name = 'ollama'
  readonly models: ModelReference[]

  constructor(
    private readonly baseUrl = DEFAULT_OLLAMA_URL,
    defaultModel = DEFAULT_OLLAMA_MODEL,
  ) {
    this.models = [
      {
        provider: 'ollama',
        name: defaultModel,
        family: defaultModel.split(':')[0] ?? defaultModel,
        supportsJson: true,
        supportsTools: false,
      },
    ]
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(1_500),
      })
      return response.ok
    } catch {
      return false
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const model = this.models[0] ?? NULL_MODEL
    const prompt = renderPrompt(request)
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model.name,
        prompt,
        stream: false,
        format: request.responseFormat === 'json' ? 'json' : undefined,
        options: {
          temperature: request.temperature ?? 0.2,
          num_predict: request.maxOutputTokens,
        },
      }),
    })

    if (!response.ok) {
      return {
        model,
        content: `Ollama request failed with status ${response.status}`,
        finishReason: 'error',
      }
    }

    const payload = (await response.json()) as {
      response?: string
      eval_count?: number
      prompt_eval_count?: number
    }
    return {
      model,
      content: payload.response ?? '',
      finishReason: 'stop',
      usage: {
        input: payload.prompt_eval_count ?? 0,
        output: payload.eval_count ?? 0,
        total: (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0),
      },
    }
  }
}

export class AnthropicProvider extends NullProvider {
  override readonly name = 'anthropic'
}

function builtInProviderPlugins(): LLMProviderPlugin[] {
  return [
    {
      manifest: {
        name: '@coco/provider-null',
        version: '0.1.0',
        kind: 'llm-provider',
        source: 'builtin',
        capabilities: ['llm-generate', 'fallback'],
        description: 'Deterministic null provider.',
      },
      provider: new NullProvider(),
    },
    {
      manifest: {
        name: '@coco/provider-ollama',
        version: '0.1.0',
        kind: 'llm-provider',
        source: 'builtin',
        capabilities: ['llm-generate', 'local-ollama'],
        description: 'Local Ollama provider.',
      },
      provider: new OllamaProvider(),
    },
  ]
}

export async function loadLLMProviderPlugins(pluginPaths: string[]): Promise<LLMProviderPlugin[]> {
  const loaded: LLMProviderPlugin[] = []
  for (const pluginPath of await resolvePluginEntrypoints(pluginPaths)) {
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      default?: CocoPluginModule
      plugin?: CocoPluginModule
    }
    const plugin = module.plugin ?? module.default
    if (!plugin || plugin.manifest.kind !== 'llm-provider') {
      continue
    }
    const validation = validatePluginModule(plugin)
    if (!validation.valid) {
      throw new Error(
        `Invalid LLM provider plugin at ${pluginPath}: ${validation.errors.join(' ')}`,
      )
    }
    loaded.push(plugin as LLMProviderPlugin)
  }
  return loaded
}

export function listLLMPlugins(): LLMProviderPlugin[] {
  return builtInProviderPlugins()
}

export class LLMRegistry {
  private readonly providers = new Map<string, LLMProviderContract>()
  private readonly pluginPaths: string[]
  private loadedExternalPlugins = false

  constructor(
    providers: LLMProviderContract[] = builtInProviderPlugins().map((plugin) => plugin.provider),
    config: LLMRegistryConfig = {},
  ) {
    this.pluginPaths = config.pluginPaths ?? []
    for (const provider of providers) {
      this.register(provider)
    }
  }

  private async ensureExternalPluginsLoaded(): Promise<void> {
    if (this.loadedExternalPlugins) return
    const plugins = await loadLLMProviderPlugins(this.pluginPaths)
    for (const plugin of plugins) {
      this.register(plugin.provider)
    }
    this.loadedExternalPlugins = true
  }

  register(provider: LLMProviderContract): void {
    this.providers.set(provider.name, provider)
  }

  list(): string[] {
    return [...this.providers.keys()].sort()
  }

  get(name: string): LLMProviderContract | undefined {
    return this.providers.get(name)
  }

  async resolve(selection: ProviderSelection = {}): Promise<ProviderResolution> {
    await this.ensureExternalPluginsLoaded()
    if (selection.provider) {
      const explicit = this.providers.get(selection.provider)
      if (!explicit) {
        return {
          provider: 'null',
          model: NULL_MODEL.name,
          reason: `Requested provider "${selection.provider}" is unavailable; falling back to null.`,
        }
      }

      const model = selection.model ?? explicit.models[0]?.name ?? NULL_MODEL.name
      return {
        provider: explicit.name,
        model,
        reason: `Using explicitly requested provider "${explicit.name}".`,
      }
    }

    const ollama = this.providers.get('ollama')
    if (ollama instanceof OllamaProvider && (await ollama.isHealthy())) {
      return {
        provider: ollama.name,
        model: selection.model ?? ollama.models[0]?.name ?? DEFAULT_OLLAMA_MODEL,
        reason: 'Detected a healthy local Ollama instance.',
      }
    }

    return {
      provider: 'null',
      model: NULL_MODEL.name,
      reason:
        'Falling back to the null provider because no explicit or healthy local provider was available.',
    }
  }

  async generate(request: LLMRequest, selection: ProviderSelection = {}): Promise<LLMResponse> {
    await this.ensureExternalPluginsLoaded()
    const resolution = await this.resolve(selection)
    const provider = this.providers.get(resolution.provider) ?? this.providers.get('null')
    if (!provider) {
      throw new Error('No LLM providers are registered.')
    }

    return provider.generate(request)
  }
}

function renderPrompt(request: LLMRequest): string {
  const sections: string[] = []
  if (request.systemPrompt) {
    sections.push(`SYSTEM:\n${request.systemPrompt}`)
  }

  for (const message of request.messages) {
    sections.push(`${message.role.toUpperCase()}:\n${message.content}`)
  }

  return sections.join('\n\n')
}

export const llmPackage = {
  name: '@coco/llm',
  status: 'ready',
  message: 'Local-first LLM registry with null and Ollama providers.',
} as const
