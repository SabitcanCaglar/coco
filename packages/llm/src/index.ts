const STUB_MESSAGE =
  '@coco/llm is scaffolded as the provider boundary. Concrete adapters will land in a later milestone.'

class BaseStubProvider {
  readonly status = 'stub' as const

  constructor(readonly name: string) {}

  async generate(): Promise<never> {
    throw new Error(STUB_MESSAGE)
  }
}

export class LLMRegistry {
  readonly status = 'stub' as const

  register(): never {
    throw new Error(STUB_MESSAGE)
  }

  list(): string[] {
    return []
  }
}

export class OllamaProvider extends BaseStubProvider {
  constructor() {
    super('ollama')
  }
}

export class AnthropicProvider extends BaseStubProvider {
  constructor() {
    super('anthropic')
  }
}

export class NullProvider extends BaseStubProvider {
  constructor() {
    super('null')
  }
}

export const llmPackage = {
  name: '@coco/llm',
  status: 'stub',
  message: STUB_MESSAGE,
} as const
