import { describe, expect, it } from 'vitest'

import {
  AnthropicProvider,
  LLMRegistry,
  NullProvider,
  OllamaProvider,
  llmPackage,
} from './index.js'

describe('@coco/llm', () => {
  it('exposes scaffold metadata', () => {
    expect(llmPackage.name).toBe('@coco/llm')
    expect(llmPackage.status).toBe('stub')
  })

  it('creates named provider stubs', () => {
    expect(new OllamaProvider().name).toBe('ollama')
    expect(new AnthropicProvider().name).toBe('anthropic')
    expect(new NullProvider().name).toBe('null')
    expect(new LLMRegistry().list()).toEqual([])
  })
})
