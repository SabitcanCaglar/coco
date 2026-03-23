import type { CocoId } from './shared.js'

export const LLM_ROLES = ['system', 'user', 'assistant', 'tool'] as const

export type LLMRole = (typeof LLM_ROLES)[number]

export interface LLMMessage {
  role: LLMRole
  content: string
  name?: string
}

export interface ToolCall {
  id: CocoId
  name: string
  input: string
}

export interface ModelReference {
  provider: string
  name: string
  family?: string
  contextWindow?: number
  supportsTools?: boolean
  supportsJson?: boolean
}

export interface TokenUsage {
  input: number
  output: number
  total: number
}

export interface LLMRequest {
  messages: LLMMessage[]
  systemPrompt?: string
  temperature?: number
  maxOutputTokens?: number
  responseFormat?: 'text' | 'json'
}

export interface LLMResponse {
  model: ModelReference
  content: string
  finishReason: 'stop' | 'length' | 'tool-call' | 'error'
  usage?: TokenUsage
  toolCalls?: ToolCall[]
}

export interface ProviderResolution {
  provider: string
  model: string
  reason: string
}

export interface LLMProviderContract {
  readonly name: string
  readonly models: ModelReference[]
  generate(request: LLMRequest): Promise<LLMResponse>
}
