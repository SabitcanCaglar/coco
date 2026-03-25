import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  AnthropicProvider,
  LLMRegistry,
  NullProvider,
  OllamaProvider,
  OpenRouterProvider,
  listLLMPlugins,
  llmPackage,
  loadLLMProviderPlugins,
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
    expect(listLLMPlugins()).toHaveLength(2)
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

  it('resolves explicit openclaw requests through openrouter when configured', async () => {
    const registry = new LLMRegistry([
      new NullProvider(),
      new OpenRouterProvider('test-key', 'https://openrouter.example/api/v1', 'moonshotai/kimi-k2'),
    ])

    await expect(
      registry.resolve({ provider: 'openclaw', model: 'moonshotai/kimi-k2' }),
    ).resolves.toMatchObject({
      provider: 'openclaw',
      model: 'moonshotai/kimi-k2',
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

  it('loads external provider plugins from file paths', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'coco-llm-plugin-'))
    const pluginPath = join(pluginDir, 'provider.mjs')
    await writeFile(
      pluginPath,
      `export const plugin = {
        manifest: {
          name: 'external-llm-plugin',
          version: '0.1.0',
          kind: 'llm-provider',
          capabilities: ['llm-generate']
        },
        provider: {
          name: 'external',
          models: [{ provider: 'external', name: 'ext-1', family: 'ext', supportsJson: true, supportsTools: false }],
          async generate() {
            return { model: this.models[0], content: 'ok', finishReason: 'stop' };
          }
        }
      };`,
    )

    try {
      const plugins = await loadLLMProviderPlugins([pluginPath])
      expect(plugins).toHaveLength(1)
      expect(plugins[0]?.provider.name).toBe('external')
    } finally {
      await rm(pluginDir, { recursive: true, force: true })
    }
  })
})
