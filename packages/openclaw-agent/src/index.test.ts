import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createOpenClawAgent, openClawAgentPackage } from './index.js'

const originalFetch = globalThis.fetch
const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY
const originalHostHome = process.env.COCO_HOST_HOME

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey
  process.env.COCO_HOST_HOME = originalHostHome
})

describe('@coco/openclaw-agent', () => {
  it('exposes package metadata', () => {
    expect(openClawAgentPackage.name).toBe('@coco/openclaw-agent')
    expect(openClawAgentPackage.status).toBe('ready')
  })

  it('understands natural-language repo switching and doctor runs', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repos') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify([
            { id: 'repo-api', rootPath: '/host-home/Desktop/api-service' },
            { id: 'repo-web', rootPath: '/host-home/Desktop/web-app' },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/jobs/doctor') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'job-123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as typeof fetch
    const agent = createOpenClawAgent({
      daemonUrl: 'http://127.0.0.1:3000',
      planner: async (inputText) =>
        inputText.includes('doktor')
          ? { reply: 'Doktor taramasini baslatiyorum.', queue: 'doctor' }
          : { reply: 'API reposuna geciyorum.', selectRepoHint: 'api-service', queue: 'none' },
    })

    const switched = await agent.handleMessage('api reposuna gec', '42', {})
    expect(switched.reply).toContain('Active repo set to /host-home/Desktop/api-service')
    expect(switched.updatedSessions?.['42']?.activeRepoId).toBe('repo-api')

    const doctor = await agent.handleMessage(
      'aktif repoda doktor calistir',
      '42',
      switched.updatedSessions ?? {},
    )
    expect(doctor.reply).toContain('Doktor taramasini baslatiyorum.')
    expect(doctor.reply).toContain('Repo yapisini, riskleri')
    expect(doctor.reply).not.toContain('Queued doctor job')
  })

  it('understands natural-language provider and model changes', async () => {
    const agent = createOpenClawAgent({
      daemonUrl: 'http://127.0.0.1:3000',
      planner: async (inputText) =>
        inputText.includes('stepfun/')
          ? {
              reply: 'Default model set to stepfun/step-3.5-flash:free',
              model: 'stepfun/step-3.5-flash:free',
              queue: 'none',
            }
          : {
              reply: 'Default provider set to openclaw',
              provider: 'openclaw',
              queue: 'none',
            },
    })

    const providerResult = await agent.handleMessage('openclaw kullan', '7', {})
    expect(providerResult.reply).toContain('Default provider set to openclaw')
    expect(providerResult.updatedSessions?.['7']?.provider).toBe('openclaw')

    const modelResult = await agent.handleMessage(
      'model stepfun/step-3.5-flash:free olsun',
      '7',
      providerResult.updatedSessions ?? {},
    )
    expect(modelResult.reply).toContain('Default model set to stepfun/step-3.5-flash:free')
    expect(modelResult.updatedSessions?.['7']?.model).toBe('stepfun/step-3.5-flash:free')
  })

  it('surfaces a clear daemon connectivity error instead of raw fetch failure', async () => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const agent = createOpenClawAgent({ daemonUrl: 'http://orchestrator:3000' })

    const result = await agent.handleMessage('api reposuna gec', 'clear-error', {})
    expect(result.reply).toContain('OpenClaw planner su anda istegi isleyemedi')
  })

  it('lets OpenClaw plan and start autopilot from a freeform request', async () => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repos') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify([{ id: 'repo-api', rootPath: '/host-home/Desktop/api-service' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply: 'OpenClaw devraldi. API reposunda PLAN.md uzerinden devam ediyorum.',
                    selectRepoHint: 'api-service',
                    taskScope: 'long',
                    plan: ['PLAN.md maddelerini tara', 'en kritik isi sec'],
                    successCriteria: 'PLAN.md maddeleri kapanana kadar devam et',
                    queue: 'loop',
                    autopilot: {
                      enabled: true,
                      goal: 'PLAN.md maddelerini bitir',
                      taskScope: 'long',
                      plan: ['PLAN.md maddelerini tara', 'en kritik isi sec'],
                      successCriteria: 'PLAN.md maddeleri kapanana kadar devam et',
                      roundsPerJob: 1,
                      maxCycles: 3,
                      usePlanMd: true,
                    },
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/jobs/loop') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        expect(body.goal).toBe('PLAN.md maddelerini bitir')
        expect(body.planExcerpt).toBeUndefined()
        return new Response(JSON.stringify({ id: 'job-loop-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as typeof fetch
    const agent = createOpenClawAgent({ daemonUrl: 'http://127.0.0.1:3000' })

    const result = await agent.handleMessage(
      'api reposunda plan md uzerinden saatlerce calis ve durmadan gelistir',
      '99',
      {},
    )

    expect(result.reply).toContain('OpenClaw devraldi')
    expect(result.reply).toContain('Plani birakmadan tur tur ilerleyecegim')
    expect(result.reply).not.toContain('Queued loop job')
    expect(result.updatedSessions?.['99']?.autopilot?.enabled).toBe(true)
    expect(result.updatedSessions?.['99']?.autopilot?.currentJobId).toBe('job-loop-1')
    expect(result.updatedSessions?.['99']?.autopilot?.taskScope).toBe('long')
    expect(result.updatedSessions?.['99']?.autopilot?.plan).toEqual([
      'PLAN.md maddelerini tara',
      'en kritik isi sec',
    ])
    expect(result.updatedSessions?.['99']?.autopilot?.successCriteria).toBe(
      'PLAN.md maddeleri kapanana kadar devam et',
    )
  })

  it('does not pretend work has started when planner wants a loop job without a repo', async () => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
    const hostHome = await mkdtemp(join(tmpdir(), 'coco-repo-selection-'))
    process.env.COCO_HOST_HOME = hostHome
    const desktopRepo = join(hostHome, 'Desktop', 'Subs-api')
    await mkdir(join(desktopRepo, '.git'), { recursive: true })
    await writeFile(join(desktopRepo, 'Subs-api.sln'), '')

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repos') && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply: 'Tamam, autopilot modlari icin proje dosyalarini olusturuyorum.',
                    queue: 'loop',
                    autopilot: {
                      enabled: true,
                      goal: 'autopilot modlarini kur',
                      roundsPerJob: 1,
                      maxCycles: 3,
                      usePlanMd: true,
                    },
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as typeof fetch
    const agent = createOpenClawAgent({ daemonUrl: 'http://127.0.0.1:3000' })

    try {
      const result = await agent.handleMessage(
        'autopilot modlari icin dosyalar olustur, hepsinin backendi subs api olsun',
        'repo-needed',
        {},
      )

      expect(result.reply).toContain('Hangi repoda calisacagimi once secmem gerekiyor.')
      expect(result.reply).toContain('Subs-api')
      expect(result.reply).not.toContain(
        'Tamam, autopilot modlari icin proje dosyalarini olusturuyorum.',
      )
    } finally {
      await rm(hostHome, { recursive: true, force: true })
    }
  })

  it('can control docker containers from a natural-language request', async () => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repos') && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply: 'Docker tarafini hallediyorum.',
                    queue: 'docker',
                    dockerAction: 'restart',
                    dockerTargetHint: 'postgres-dev',
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/docker/containers') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify([
            {
              id: 'abc123',
              name: 'postgres-dev',
              image: 'postgres:16',
              state: 'running',
              status: 'Up 2 minutes',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/docker/containers/restart') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ ok: true, action: 'restart', target: 'postgres-dev' }),
          {
            status: 202,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as typeof fetch
    const agent = createOpenClawAgent({ daemonUrl: 'http://127.0.0.1:3000' })

    const result = await agent.handleMessage('postgres-dev containerini restart et', '55', {})
    expect(result.reply).toContain('Docker restart -> postgres-dev')
  })

  it('strips internal planner protocol explanations from user-facing replies', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repos') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify([{ id: 'repo-api', rootPath: '/host-home/Desktop/cognify-subs-api' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/jobs/doctor') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'job-ux-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
    const agent = createOpenClawAgent({
      daemonUrl: 'http://127.0.0.1:3000',
      planner: async () => ({
        reply:
          'Ben dogrudan JSON formatinda cevap veriyorum. Her yanitimda reply, taskScope, queue ve autopilot alanlari oluyor.',
        queue: 'doctor',
        selectRepoHint: 'cognify-subs-api',
      }),
    })

    const result = await agent.handleMessage('subs-api repo yapisini analiz et', 'ux-clean', {})
    expect(result.reply).toContain('cognify-subs-api uzerinde ilk incelemeyi baslatiyorum.')
    expect(result.reply).not.toContain('JSON')
    expect(result.reply).not.toContain('queue')
    expect(result.reply).not.toContain('autopilot')
  })

  it('auto-registers a Desktop repo by name when switching', async () => {
    const hostHome = await mkdtemp(join(tmpdir(), 'coco-host-home-'))
    process.env.COCO_HOST_HOME = hostHome
    const repoPath = join(hostHome, 'Desktop', 'telegram-desktop-repo')
    await mkdir(repoPath, { recursive: true })

    try {
      const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/repos') && (!init || init.method === undefined)) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (url.endsWith('/repos') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              id: 'desktop-repo-id',
              rootPath: repoPath,
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          )
        }
        throw new Error(`unexpected fetch: ${url}`)
      })
      globalThis.fetch = fetchMock as typeof fetch
      const agent = createOpenClawAgent({
        daemonUrl: 'http://127.0.0.1:3000',
        planner: async () => ({
          reply: 'Telegram desktop reposuna geciyorum.',
          selectRepoHint: 'telegram-desktop-repo',
          queue: 'none',
        }),
      })

      const result = await agent.handleMessage('telegram-desktop-repo reposuna gec', '88', {})
      expect(result.reply).toContain('Active repo set to')
      expect(result.updatedSessions?.['88']?.activeRepoId).toBe('desktop-repo-id')
    } finally {
      await rm(hostHome, { recursive: true, force: true })
    }
  })

  it('lists code projects from Desktop without requiring an active repo', async () => {
    const hostHome = await mkdtemp(join(tmpdir(), 'coco-desktop-projects-'))
    process.env.COCO_HOST_HOME = hostHome
    const desktopPath = join(hostHome, 'Desktop')
    const dotnetRepo = join(desktopPath, 'Subs-api')
    const nodeRepo = join(desktopPath, 'web-app')
    await mkdir(dotnetRepo, { recursive: true })
    await mkdir(nodeRepo, { recursive: true })
    await mkdir(join(nodeRepo, '.git'), { recursive: true })
    await mkdir(join(dotnetRepo, '.git'), { recursive: true })
    await mkdir(join(dotnetRepo, 'src'), { recursive: true })
    await mkdir(join(nodeRepo, 'src'), { recursive: true })
    await rm(join(dotnetRepo, 'Subs-api.sln'), { force: true })
    await rm(join(nodeRepo, 'package.json'), { force: true })
    await writeFile(join(dotnetRepo, 'Subs-api.sln'), '')
    await writeFile(join(nodeRepo, 'package.json'), '{"name":"web-app"}')

    const agent = createOpenClawAgent({
      daemonUrl: 'http://127.0.0.1:3000',
      planner: async () => ({
        reply: 'Desktop projelerini listeliyorum.',
        queue: 'desktop',
      }),
    })

    try {
      const result = await agent.handleMessage("Desktop'taki projeleri listele", 'list-desktop', {})
      expect(result.reply).toContain('Desktop projelerini listeliyorum.')
      expect(result.reply).toContain('Subs-api')
      expect(result.reply).toContain('web-app')
    } finally {
      await rm(hostHome, { recursive: true, force: true })
    }
  })

  it('returns a planner-unavailable message instead of falling back to rule routing', async () => {
    process.env.OPENROUTER_API_KEY = ''
    const agent = createOpenClawAgent({ daemonUrl: 'http://127.0.0.1:3000' })

    const result = await agent.handleMessage('openclaw kullan', 'planner-offline', {})
    expect(result.reply).toContain('OpenClaw planner su anda istegi isleyemedi')
  })

  it('continues autopilot with queued loop jobs and notifications', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/jobs') && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/jobs/loop') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'job-auto-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as typeof fetch
    const agent = createOpenClawAgent({ daemonUrl: 'http://127.0.0.1:3000' })
    const notifications: string[] = []

    const sessions = await agent.tickAutopilot(
      {
        local: {
          activeRepoId: 'repo-api',
          activeRepoPath: '/tmp/repo-api',
          provider: 'openclaw',
          model: 'stepfun/step-3.5-flash:free',
          autopilot: {
            enabled: true,
            goal: 'PLAN.md maddelerini bitir',
            taskScope: 'long',
            plan: ['ilk isi bitir', 'ikinci ise gec'],
            successCriteria: 'plan bitene kadar devam et',
            roundsPerJob: 1,
            maxCycles: 3,
            completedCycles: 0,
            usePlanMd: true,
          },
        },
      },
      async (_sessionId, message) => {
        notifications.push(message)
      },
    )

    expect(sessions.local?.autopilot?.currentJobId).toBe('job-auto-1')
    expect(notifications[0]).toContain('repo-api')
    expect(notifications[0]).toContain('yeni bir calisma turu baslattim')
  })

  it('notifies when a one-shot doctor job finishes', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/jobs') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify([
            {
              job: {
                id: 'job-doctor-1',
                type: 'doctor',
                status: 'completed',
                repoId: 'repo-api',
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/jobs/job-doctor-1') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify({
            job: {
              id: 'job-doctor-1',
              type: 'doctor',
              status: 'completed',
              repoId: 'repo-api',
            },
            result: {
              success: true,
              summary: 'Monorepo yapisi, test ve docker riskleri ozetlendi.',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
    const agent = createOpenClawAgent({ daemonUrl: 'http://127.0.0.1:3000' })
    const notifications: string[] = []

    const sessions = await agent.tickAutopilot(
      {
        local: {
          activeRepoId: 'repo-api',
          activeRepoPath: '/tmp/repo-api',
          pendingJobs: [
            {
              id: 'job-doctor-1',
              type: 'doctor',
              repoPath: '/tmp/repo-api',
            },
          ],
        },
      },
      async (_sessionId, message) => {
        notifications.push(message)
      },
    )

    expect(notifications[0]).toContain('repo-api icin ilk inceleme tamamlandi')
    expect(notifications[0]).toContain('Monorepo yapisi, test ve docker riskleri ozetlendi.')
    expect(sessions.local?.pendingJobs).toEqual([])
  })

  it('replans long-running autopilot work after each completed job', async () => {
    const agent = createOpenClawAgent({
      daemonUrl: 'http://127.0.0.1:3000',
      planner: async (inputText) => {
        if (inputText.includes('AUTOPILOT_REPLAN')) {
          return {
            reply: 'Ilk cycle bitti, ikinci cycle ile devam ediyorum.',
            taskScope: 'long',
            autopilot: {
              enabled: true,
              goal: 'Autopilot planini tamamla',
              taskScope: 'long',
              plan: ['ikinci cycle', 'ucuncu cycle'],
              successCriteria: 'tum hedefler kapansin',
              roundsPerJob: 1,
              maxCycles: 4,
              usePlanMd: true,
            },
            queue: 'none',
          }
        }
        return undefined
      },
    })
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/jobs') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify([
            {
              job: {
                id: 'job-auto-1',
                type: 'loop',
                status: 'completed',
                repoId: 'repo-api',
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/jobs/job-auto-1') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify({
            job: {
              id: 'job-auto-1',
              type: 'loop',
              status: 'completed',
              repoId: 'repo-api',
            },
            result: {
              summary: 'Ilk cycle tamamlandi.',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch
    const notifications: string[] = []

    const sessions = await agent.tickAutopilot(
      {
        local: {
          activeRepoId: 'repo-api',
          activeRepoPath: '/tmp/repo-api',
          provider: 'openclaw',
          model: 'stepfun/step-3.5-flash:free',
          autopilot: {
            enabled: true,
            goal: 'Autopilot planini tamamla',
            taskScope: 'long',
            plan: ['ilk cycle'],
            successCriteria: 'tum hedefler kapansin',
            roundsPerJob: 1,
            maxCycles: 3,
            completedCycles: 0,
            currentJobId: 'job-auto-1',
            usePlanMd: true,
          },
        },
      },
      async (_sessionId, message) => {
        notifications.push(message)
      },
    )

    expect(sessions.local?.autopilot?.currentJobId).toBeUndefined()
    expect(sessions.local?.autopilot?.completedCycles).toBe(1)
    expect(sessions.local?.autopilot?.plan).toEqual(['ikinci cycle', 'ucuncu cycle'])
    expect(sessions.local?.autopilot?.lastSummary).toBe('Ilk cycle tamamlandi.')
    expect(
      notifications.some((message) => message.includes('ikinci cycle ile devam ediyorum')),
    ).toBe(true)
  })
})
