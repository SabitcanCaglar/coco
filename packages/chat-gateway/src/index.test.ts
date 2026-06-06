import { describe, expect, it, vi } from 'vitest'

import { createChatGateway, chatGatewayPackage } from './index.js'

describe('@coco/chat-gateway', () => {
  it('exposes package metadata', () => {
    expect(chatGatewayPackage.name).toBe('@coco/chat-gateway')
    expect(chatGatewayPackage.status).toBe('ready')
  })

  it('returns chat-only replies without creating missions', async () => {
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repo-profiles')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/missions') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/threads/thread-1/messages')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { role: string; text: string }
        return new Response(
          JSON.stringify({
            id: `${body.role}-1`,
            threadId: 'thread-1',
            role: body.role,
            text: body.text,
            createdAt: new Date().toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url ${url}`)
    })
    const gateway = createChatGateway({
      controlPlaneUrl: 'http://control-plane:4100',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const result = await gateway.postMessage('thread-1', {
      text: 'sen kimsin',
      surface: 'telegram',
    })

    expect(result.reply).toContain('Aktif mission yok')
    expect(result.mission).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(5)
  })

  it('creates a mission for operational prompts', async () => {
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repo-profiles')) {
        return new Response(
          JSON.stringify([
            {
              repoId: 'repo-1',
              rootPath: '/workspace/subs-api',
              stackFamily: 'ts',
              runnerType: 'ts-worker',
              buildCommands: ['pnpm build'],
              testCommands: ['pnpm test'],
              lintCommands: ['pnpm lint'],
              artifactPaths: [],
              sandboxClass: 'default',
              timeoutProfile: {},
              allowedTools: ['shell'],
              workerCapabilities: {
                canEditCode: true,
                canRunTests: true,
                canBuild: true,
                canUseBrowser: false,
                canSearchWeb: true,
                canRunShell: true,
                canOpenIde: false,
                artifactPaths: [],
                timeoutLimits: {},
                sandboxClass: 'default',
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/missions') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/threads/thread-1/messages')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { role: string; text: string }
        return new Response(
          JSON.stringify({
            id: `${body.role}-1`,
            threadId: 'thread-1',
            role: body.role,
            text: body.text,
            createdAt: new Date().toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/missions')) {
        return new Response(
          JSON.stringify({
            missionId: 'mission-1',
            userId: 'thread-1',
            threadId: 'thread-1',
            status: 'pending',
            goal: 'subs-api repo yapisini analiz et',
            activeRepos: [],
            priority: 0,
            createdBySurface: 'web',
            approvalMode: 'mixed',
            autonomyPolicy: {
              mode: 'mixed-auto',
              retryIntervalSeconds: 120,
              maxAutoRetriesPerStep: 3,
              enableWebResearch: true,
              pauseOnRepeatedFailure: true,
            },
            assignedWorkerSet: [],
            currentPhase: 'intake',
            lastHumanInputAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url ${url}`)
    })

    const gateway = createChatGateway({
      controlPlaneUrl: 'http://control-plane:4100',
      fetchImpl: fetchImpl as typeof fetch,
    })
    const result = await gateway.postMessage('thread-1', {
      text: 'subs-api repo yapisini analiz et',
      surface: 'web',
    })

    expect(result.reply).toContain('Mission mission-1 acildi')
    expect(result.reply).toContain('Ilk tur plani:')
    expect(result.mission?.missionId).toBe('mission-1')
    expect(fetchImpl).toHaveBeenCalledTimes(7)
    const missionCall = fetchImpl.mock.calls.find(
      (call) => String(call[0]).endsWith('/missions') && call[1]?.method === 'POST',
    ) as
      | [string, RequestInit]
      | undefined
    const [url, init] = missionCall ?? []
    expect(String(url)).toContain('/missions')
    expect(init?.method).toBe('POST')
    const missionBody = JSON.parse(String(init?.body ?? '{}')) as { active_repos?: string[] }
    expect(missionBody.active_repos).toEqual(['repo-1'])
  })

  it('creates a durable autopilot mission for long Turkish autopilot prompts', async () => {
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repo-profiles')) {
        return new Response(
          JSON.stringify([
            {
              repoId: 'subs-api',
              rootPath: '/workspace/subs-api',
              stackFamily: 'ts',
              runnerType: 'ts-worker',
              buildCommands: ['pnpm build'],
              testCommands: ['pnpm test'],
              lintCommands: ['pnpm lint'],
              artifactPaths: [],
              sandboxClass: 'default',
              timeoutProfile: {},
              allowedTools: ['shell'],
              workerCapabilities: {
                canEditCode: true,
                canRunTests: true,
                canBuild: true,
                canUseBrowser: false,
                canSearchWeb: true,
                canRunShell: true,
                canOpenIde: false,
                artifactPaths: [],
                timeoutLimits: {},
                sandboxClass: 'default',
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/missions') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/threads/thread-autopilot/messages')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { role: string; text: string }
        return new Response(
          JSON.stringify({
            id: `${body.role}-1`,
            threadId: 'thread-autopilot',
            role: body.role,
            text: body.text,
            createdAt: new Date().toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/missions')) {
        return new Response(
          JSON.stringify({
            missionId: 'mission-autopilot',
            userId: 'thread-autopilot',
            threadId: 'thread-autopilot',
            status: 'pending',
            goal: 'autopilot mission',
            activeRepos: ['subs-api'],
            priority: 0,
            createdBySurface: 'telegram',
            approvalMode: 'mixed',
            autonomyPolicy: {
              mode: 'mixed-auto',
              retryIntervalSeconds: 120,
              maxAutoRetriesPerStep: 3,
              enableWebResearch: true,
              pauseOnRepeatedFailure: true,
            },
            assignedWorkerSet: ['ts-worker'],
            currentPhase: 'intake',
            lastHumanInputAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url ${url}`)
    })

    const gateway = createChatGateway({
      controlPlaneUrl: 'http://control-plane:4100',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const result = await gateway.postMessage('thread-autopilot', {
      text: 'auto pilot modlari icin dosyalar olusturucaz convert boost, vsc mobile ui mobile app projesi, llm-friendly ve hepsinin backendi subs api olacak sekilde paralel tek chat sessiondan yonetecegiz',
      surface: 'telegram',
    })

    expect(result.envelope.missionAction).toBe('create')
    expect(result.envelope.executionMode).toBe('durable_autopilot')
    expect(result.envelope.targetRepos).toEqual(['subs-api'])
    expect(result.reply).toContain('Mission mission-autopilot acildi')
    expect(result.reply).toContain('Ilk olusturmayi bekledigim dosya gruplari:')
    expect(result.reply).toContain('subs-api/docs/architecture.md')
    const missionCall = fetchImpl.mock.calls.find(
      (call) => String(call[0]).endsWith('/missions') && call[1]?.method === 'POST',
    ) as
      | [string, RequestInit]
      | undefined
    const missionBody = JSON.parse(String(missionCall?.[1]?.body ?? '{}')) as {
      execution_mode?: string
      active_repos?: string[]
    }
    expect(missionBody.execution_mode).toBe('durable_autopilot')
    expect(missionBody.active_repos).toEqual(['subs-api'])
  })

  it('answers follow-up planning questions without opening a second mission', async () => {
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repo-profiles')) {
        return new Response(
          JSON.stringify([
            {
              repoId: 'subs-api',
              rootPath: '/workspace/subs-api',
              stackFamily: 'ts',
              runnerType: 'ts-worker',
            },
          ]),
          {
          status: 200,
          headers: { 'content-type': 'application/json' },
          },
        )
      }
      if (url.endsWith('/missions') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([
            {
              missionId: 'mission-existing',
              userId: 'thread-1',
              threadId: 'thread-1',
              status: 'pending',
              goal: 'auto pilot modlari icin dosyalar olusturucaz convert boost, vsc mobile ui mobile app projesi, llm-friendly ve hepsinin backendi subs api olacak sekilde paralel tek chat sessiondan yonetecegiz',
              activeRepos: ['subs-api'],
              priority: 0,
              createdBySurface: 'telegram',
              approvalMode: 'mixed',
              autonomyPolicy: {
                mode: 'mixed-auto',
                retryIntervalSeconds: 120,
                maxAutoRetriesPerStep: 3,
                enableWebResearch: true,
                pauseOnRepeatedFailure: true,
              },
              assignedWorkerSet: ['ts-worker'],
              currentPhase: 'intake',
              lastHumanInputAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              version: 2,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/threads/thread-1/messages')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { role: string; text: string }
        return new Response(
          JSON.stringify({
            id: `${body.role}-followup`,
            threadId: 'thread-1',
            role: body.role,
            text: body.text,
            createdAt: new Date().toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url ${url}`)
    })

    const gateway = createChatGateway({
      controlPlaneUrl: 'http://control-plane:4100',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const result = await gateway.postMessage('thread-1', {
      text: 'bana da haber vericen mi hangi dosyalari olusturucan icerikleri ne olacak',
      surface: 'telegram',
    })

    expect(result.envelope.missionAction).toBe('status')
    expect(result.reply).toContain('Bu mission icin simdiki plan ozeti')
    expect(result.reply).toContain('subs-api/docs/architecture.md')
    expect(fetchImpl.mock.calls.filter((call) => String(call[0]).endsWith('/missions/mission-existing/commands'))).toHaveLength(0)
    expect(fetchImpl.mock.calls.filter((call) => String(call[0]).endsWith('/missions') && call[1]?.method === 'POST')).toHaveLength(0)
  })

  it('reads persistent thread history from the control plane', async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/threads/thread-1')) {
        return new Response(
          JSON.stringify({
            threadId: 'thread-1',
            messages: [
              {
                id: 'm1',
                role: 'user',
                text: 'hello',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url ${url}`)
    })
    const gateway = createChatGateway({
      controlPlaneUrl: 'http://control-plane:4100',
      fetchImpl: fetchImpl as typeof fetch,
    })
    const thread = await gateway.getThread('thread-1')
    expect(thread.threadId).toBe('thread-1')
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0]?.text).toBe('hello')
  })
})
