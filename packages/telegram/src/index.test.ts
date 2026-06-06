import { mkdtemp, rm } from 'node:fs/promises'
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

  it('creates a bot with polling config and direct OpenClaw help', async () => {
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
      expect(bot.renderHelp()).toContain('OpenClaw remote mode')
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

    try {
      const bot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://127.0.0.1:3000',
        stateDir,
        allowedChatIds: [123],
        planner: async () => ({
          reply:
            'Desktop altindaki projeleri listeliyorum.\nSubs-api projesini buldum.\n{"queue":"desktop","reply":"internal"}',
          queue: 'none',
        }),
      })

      const reply = await bot.handleText(123, "Desktop'taki projeleri listele")
      expect(reply).toContain('projeleri')
      expect(reply).toContain('listeliyor')
      expect(reply).toContain('Subs-api')
      expect(reply).not.toContain('"queue"')
      expect(reply).not.toContain('"reply"')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('supports direct planner replies through the OpenClaw agent flow', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'coco-telegram-single-'))
    try {
      const bot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://127.0.0.1:3000',
        stateDir,
        allowedChatIds: [123],
        planner: async () => ({
          reply: 'ilk plani cikartiyorum ve repo ustunde calismaya basliyorum',
          queue: 'none',
        }),
      })

      const reply = await bot.handleText(123, 'live-repo uzerinde bitene kadar ilerle')
      expect(reply).toContain('calismaya basliyorum')
      expect(reply).toContain('ilk plani')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('persists the last Telegram update offset across restarts', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'coco-telegram-offset-'))
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('api.telegram.org') && url.includes('/getUpdates')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { offset?: number }
        if (payload.offset === 0) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 42,
                  message: {
                    message_id: 7,
                    chat: { id: 123, type: 'private' },
                    text: 'yardim',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (payload.offset === 43) {
          return new Response(JSON.stringify({ ok: true, result: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
      }
      if (url.includes('api.telegram.org') && url.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const fetchImpl = fetchMock as typeof fetch

    globalThis.fetch = fetchImpl
    try {
      const bot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://127.0.0.1:3000',
        stateDir,
        allowedChatIds: [123],
        fetchImpl,
      })

      await bot.pollOnce()

      const restartedBot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://127.0.0.1:3000',
        stateDir,
        allowedChatIds: [123],
        fetchImpl,
      })

      await restartedBot.pollOnce()

      const getUpdatesCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/getUpdates'),
      )
      expect(getUpdatesCalls).toHaveLength(2)

      const firstPayload = JSON.parse(String(getUpdatesCalls[0]?.[1]?.body ?? '{}')) as {
        offset?: number
      }
      const secondPayload = JSON.parse(String(getUpdatesCalls[1]?.[1]?.body ?? '{}')) as {
        offset?: number
      }
      expect(firstPayload.offset).toBe(0)
      expect(secondPayload.offset).toBe(43)
    } finally {
      globalThis.fetch = originalFetch
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('replies only once for duplicate message ids', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'coco-telegram-dup-'))
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/getUpdates')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { offset?: number }
        if (payload.offset === 0) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 42,
                  message: {
                    message_id: 9,
                    chat: { id: 123, type: 'private' },
                    text: 'yardim',
                  },
                },
                {
                  update_id: 43,
                  message: {
                    message_id: 9,
                    chat: { id: 123, type: 'private' },
                    text: 'yardim',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const fetchImpl = fetchMock as typeof fetch

    globalThis.fetch = fetchImpl
    try {
      const bot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://127.0.0.1:3000',
        stateDir,
        allowedChatIds: [123],
        fetchImpl,
      })

      await bot.pollOnce()

      const sendMessageCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/sendMessage'),
      )
      expect(sendMessageCalls).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('does not reply again after restart when the same message id reappears', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'coco-telegram-replay-'))
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/getUpdates')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { offset?: number }
        if (payload.offset === 0) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 50,
                  message: {
                    message_id: 11,
                    chat: { id: 123, type: 'private' },
                    text: 'yardim',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (payload.offset === 51) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 99,
                  message: {
                    message_id: 11,
                    chat: { id: 123, type: 'private' },
                    text: 'yardim',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const fetchImpl = fetchMock as typeof fetch

    globalThis.fetch = fetchImpl
    try {
      const firstBot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://127.0.0.1:3000',
        stateDir,
        allowedChatIds: [123],
        fetchImpl,
      })
      await firstBot.pollOnce()

      const restartedBot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://127.0.0.1:3000',
        stateDir,
        allowedChatIds: [123],
        fetchImpl,
      })
      await restartedBot.pollOnce()

      const sendMessageCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/sendMessage'),
      )
      expect(sendMessageCalls).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('does not retry the same message after sendMessage failure', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'coco-telegram-send-fail-'))
    const originalFetch = globalThis.fetch
    let sendAttempts = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/getUpdates')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { offset?: number }
        if (payload.offset === 0) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 70,
                  message: {
                    message_id: 15,
                    chat: { id: 123, type: 'private' },
                    text: 'yardim',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (payload.offset === 71) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 71,
                  message: {
                    message_id: 15,
                    chat: { id: 123, type: 'private' },
                    text: 'yardim',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/sendMessage')) {
        sendAttempts += 1
        throw new Error('send failed')
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const fetchImpl = fetchMock as typeof fetch

    globalThis.fetch = fetchImpl
    try {
      const bot = createTelegramBot({
        token: 'telegram-test-token',
        daemonUrl: 'http://127.0.0.1:3000',
        stateDir,
        allowedChatIds: [123],
        fetchImpl,
      })

      await bot.pollOnce()
      await bot.pollOnce()

      expect(sendAttempts).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      await rm(stateDir, { recursive: true, force: true })
    }
  })

})
