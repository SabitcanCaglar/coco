import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createTelegramBot, telegramPackage } from './index.js'

describe('@coco/telegram', () => {
  it('exposes package metadata', () => {
    expect(telegramPackage.name).toBe('@coco/telegram')
    expect(telegramPackage.status).toBe('ready')
    expect(telegramPackage.message).toContain('OpenClaw')
  })

  it('creates a bot with polling config and shared agent help', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'coco-telegram-'))

    try {
      const bot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://127.0.0.1:3000',
        allowedChatIds: [123],
        stateDir,
        pollingTimeoutSeconds: 5,
      })

      expect(bot.config.daemonUrl).toBe('http://127.0.0.1:3000')
      expect(bot.config.allowedChatIds).toEqual([123])
      expect(bot.config.pollingTimeoutSeconds).toBe(5)
      expect(bot.renderHelp()).toContain('OpenClaw supervisor mode')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('probes the daemon through health, repos, and jobs endpoints', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'coco-telegram-probe-'))
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok', package: '@coco/orchestrator' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/repos')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const bot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://orchestrator:3000',
        stateDir,
        fetchImpl,
      })

      const probe = await bot.probeDaemon()
      expect(probe.daemonUrl).toBe('http://orchestrator:3000')
      expect(probe.health.status).toBe('ok')
      expect(Array.isArray(probe.repos)).toBe(true)
      expect(Array.isArray(probe.jobs)).toBe(true)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('keeps planner JSON internal and returns only natural-language replies', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'coco-telegram-handle-'))
    const hostHome = await mkdtemp(join(tmpdir(), 'coco-telegram-home-'))
    process.env.COCO_HOST_HOME = hostHome
    const repoPath = join(hostHome, 'Desktop', 'Subs-api')
    await mkdir(join(repoPath, '.git'), { recursive: true })
    await writeFile(join(repoPath, 'Subs-api.sln'), '')

    try {
      const bot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://127.0.0.1:3000',
        stateDir,
        allowedChatIds: [123],
      })

      const reply = await bot.handleText(123, "Desktop'taki projeleri listele")
      expect(reply).toContain('Desktop projelerini listeliyorum.')
      expect(reply).toContain('Subs-api')
      expect(reply).not.toContain('"queue"')
      expect(reply).not.toContain('"reply"')
    } finally {
      process.env.COCO_HOST_HOME = undefined
      await rm(hostHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
