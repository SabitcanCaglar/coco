import { describe, expect, it, vi } from 'vitest'

import {
  AnthropicProvider,
  LLMRegistry,
  NullProvider,
  OllamaProvider,
  llmPackage,
} from './index.js'

describe('@coco/llm', () => {
  it('exposes runtime metadata', () => {
    expect(llmPackage.name).toBe('@coco/llm')
    expect(llmPackage.status).toBe('ready')
  })

  it('creates named providers and resolves explicit null', async () => {
    expect(new OllamaProvider().name).toBe('ollama')
    expect(new AnthropicProvider().name).toBe('anthropic')
    expect(new NullProvider().name).toBe('null')
    const registry = new LLMRegistry()
    expect(registry.list()).toEqual(['null', 'ollama'])
    await expect(registry.resolve({ provider: 'null' })).resolves.toMatchObject({
      provider: 'null',
    })
  })

  it('prefers a healthy local ollama instance when available', async () => {
    const provider = new OllamaProvider()
    vi.spyOn(provider, 'isHealthy').mockResolvedValue(true)
    const registry = new LLMRegistry([new NullProvider(), provider])

    await expect(registry.resolve()).resolves.toMatchObject({
      provider: 'ollama',
    })
  })

  it('null provider declines generation without throwing', async () => {
    const response = await new NullProvider().generate({
      messages: [{ role: 'user', content: 'hello' }],
      responseFormat: 'json',
    })

    expect(response.finishReason).toBe('error')
    expect(response.content).toContain('llm-unavailable')
  })
})
