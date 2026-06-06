import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSupervisor, supervisorPackage } from './index.js'

const originalFetch = globalThis.fetch
const originalHostHome = process.env.COCO_HOST_HOME

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env.COCO_HOST_HOME = originalHostHome
  vi.unstubAllEnvs()
})

describe('@coco/openclaw-supervisor', () => {
  it('exposes package metadata', () => {
    expect(supervisorPackage.name).toBe('@coco/openclaw-supervisor')
    expect(supervisorPackage.message).toContain('supervisor')
  })

  it('classifies analyze requests into analyze tasks instead of loop jobs', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repos') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify([{ id: 'repo-1', rootPath: '/host-home/Desktop/subs-api' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/tasks') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { mode: string }
        expect(body.mode).toBe('analyze')
        return new Response(
          JSON.stringify({
            id: 'task-1',
            goal: 'subs-api repo yapisini analiz et',
            mode: 'analyze',
            status: 'queued',
            sessionId: 'session-1',
            repoId: 'repo-1',
            plan: { steps: [] },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
    const result = await supervisor.handleMessage('subs-api repo yapisini analiz et', 'session-1', {
      'session-1': {
        activeRepoId: 'repo-1',
        activeRepoPath: '/host-home/Desktop/subs-api',
      },
    })

    expect(result.task?.mode).toBe('analyze')
    expect(result.reply).toContain('read-only analiz')
    expect(result.reply).not.toContain('loop')
  })

  it('lists desktop projects without requiring daemon-backed routing', async () => {
    const hostHome = await mkdtemp(join(tmpdir(), 'coco-supervisor-home-'))
    vi.stubEnv('HOME', hostHome)
    process.env.COCO_HOST_HOME = hostHome
    const repoPath = join(hostHome, 'Desktop', 'Subs-api')
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(repoPath, 'Subs-api.sln'), '')

    try {
      const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
      const result = await supervisor.handleMessage("Desktop'taki projeleri listele", 's', {})
      expect(result.reply).toContain('Buldugum proje adaylarini listeliyorum.')
      expect(result.reply).toContain('Subs-api')
    } finally {
      await rm(hostHome, { recursive: true, force: true })
    }
  })

  it('discovers local projects from HOME without relying on host-home desktop mount', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'coco-supervisor-local-home-'))
    vi.stubEnv('HOME', fakeHome)
    process.env.COCO_HOST_HOME = join(fakeHome, 'missing-host-home')
    const repoPath = join(fakeHome, 'Desktop', 'cognify-subs-api')
    await mkdir(join(repoPath, '.git'), { recursive: true })

    try {
      const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
      const result = await supervisor.handleMessage('projeleri listele', 'local-home', {})
      expect(result.reply).toContain('Buldugum proje adaylarini listeliyorum.')
      expect(result.reply).toContain('cognify-subs-api')
      expect(result.reply).toContain(repoPath)
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('prefers local HOME path when daemon repo path points at /host-home mirror', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'coco-supervisor-path-map-'))
    vi.stubEnv('HOME', fakeHome)
    process.env.COCO_HOST_HOME = '/host-home'
    const localRepoPath = join(fakeHome, 'Desktop', 'cognify-subs-api')
    await mkdir(join(localRepoPath, '.git'), { recursive: true })

    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/repos') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify([{ id: 'repo-1', rootPath: '/host-home/Desktop/cognify-subs-api' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/tasks') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'task-1',
            goal: 'cognify-subs-api analiz et',
            mode: 'analyze',
            status: 'queued',
            sessionId: 'session-local-path',
            repoId: 'repo-1',
            plan: { steps: [] },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/sessions/session-local-path') && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      }
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'session-local-path',
            goal: 'cognify-subs-api analiz et',
            status: 'active',
            workerSurface: 'aider',
            controlSurfaces: ['terminal', 'ide', 'telegram'],
            repoRoots: [],
            managedRepos: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/sessions/session-local-path/discover') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'session-local-path',
            goal: 'cognify-subs-api analiz et',
            status: 'active',
            workerSurface: 'aider',
            controlSurfaces: ['terminal', 'ide', 'telegram'],
            focusRepoId: 'repo-1',
            repoRoots: [],
            managedRepos: [
              {
                repoId: 'repo-1',
                rootPath: '/host-home/Desktop/cognify-subs-api',
                priority: 100,
                status: 'idle',
                workerSurface: 'aider',
                updatedAt: new Date().toISOString(),
              },
            ],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/sessions/session-local-path/control') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    try {
      const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
      const result = await supervisor.handleMessage('cognify-subs-api analiz et', 'session-local-path', {})
      expect(result.reply).toContain(localRepoPath)
      expect(result.reply).not.toContain('/host-home/Desktop/cognify-subs-api')
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('tracks provider and model preferences in session state', async () => {
    const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
    const providerResult = await supervisor.handleMessage('openclaw kullan', 'session-2', {})
    expect(providerResult.updatedSessions?.['session-2']?.provider).toBe('openclaw')
    expect(providerResult.reply).toContain('openclaw')

    const modelResult = await supervisor.handleMessage(
      'model stepfun/step-3.5-flash:free olsun',
      'session-2',
      providerResult.updatedSessions ?? {},
    )
    expect(modelResult.updatedSessions?.['session-2']?.model).toBe('stepfun/step-3.5-flash:free')
  })

  it('returns help for short yardım-style prompts instead of creating analyze tasks', async () => {
    const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
    const result = await supervisor.handleMessage('yard', 'help-session', {
      'help-session': {
        activeRepoId: 'repo-1',
        activeRepoPath: '/host-home/Desktop/cognify-subs-api',
      },
    })

    expect(result.reply).toContain('OpenClaw supervisor mode')
    expect(result.task).toBeUndefined()
  })

  it('asks for clarification on vague complaints instead of defaulting to analyze', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      throw new Error(`unexpected fetch: ${String(input)}`)
    }) as typeof fetch

    const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
    const result = await supervisor.handleMessage('hep ayni cevap aq ya', 'frustrated-session', {
      'frustrated-session': {
        activeRepoId: 'repo-1',
        activeRepoPath: '/host-home/Desktop/cognify-subs-api',
      },
    })

    expect(result.reply).toContain('Aktif repo')
    expect(result.reply).toContain('Ne yapmami istedigini daha acik yaz.')
    expect(result.task).toBeUndefined()
  })

  it('creates and discovers a workspace session through the daemon api', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'session-3',
            goal: 'workspace olustur',
            status: 'active',
            workerSurface: 'aider',
            controlSurfaces: ['terminal', 'ide', 'telegram'],
            repoRoots: [],
            managedRepos: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/sessions/session-3/discover') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'session-3',
            goal: 'workspace olustur',
            status: 'active',
            workerSurface: 'aider',
            controlSurfaces: ['terminal', 'ide', 'telegram'],
            focusRepoId: 'repo-1',
            repoRoots: [],
            managedRepos: [
              {
                repoId: 'repo-1',
                rootPath: '/host-home/Desktop/subs-api',
                priority: 100,
                status: 'idle',
                workerSurface: 'aider',
                updatedAt: new Date().toISOString(),
              },
            ],
            latestSummary: '1 repos discovered and prioritized.',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/sessions/session-3') && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
    const created = await supervisor.handleMessage('workspace olustur', 'session-3', {})
    expect(created.updatedSessions?.['session-3']?.workspaceSessionId).toBe('session-3')

    const discovered = await supervisor.handleMessage(
      'projeleri kesfet',
      'session-3',
      created.updatedSessions ?? {},
    )
    expect(discovered.reply).toContain('discovered')
    expect(discovered.updatedSessions?.['session-3']?.activeRepoId).toBe('repo-1')
  })

  it('bootstraps workspace discovery and autopilot from a single prompt', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/sessions/single-shot') && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      }
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'single-shot',
            goal: 'subs-api uzerinde bitene kadar ilerle',
            status: 'active',
            workerSurface: 'aider',
            controlSurfaces: ['terminal', 'ide', 'telegram'],
            repoRoots: [],
            managedRepos: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/sessions/single-shot/discover') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'single-shot',
            goal: 'subs-api uzerinde bitene kadar ilerle',
            status: 'active',
            workerSurface: 'aider',
            controlSurfaces: ['terminal', 'ide', 'telegram'],
            focusRepoId: 'repo-1',
            repoRoots: [],
            managedRepos: [
              {
                repoId: 'repo-1',
                rootPath: '/host-home/Desktop/subs-api',
                priority: 100,
                status: 'idle',
                workerSurface: 'aider',
                updatedAt: new Date().toISOString(),
              },
            ],
            latestSummary: '1 repos discovered and prioritized.',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/sessions/single-shot/control') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            ok: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/sessions/single-shot/autopilot') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'task-auto-1',
            goal: 'subs-api uzerinde bitene kadar ilerle',
            mode: 'autopilot',
            status: 'queued',
            sessionId: 'single-shot',
            repoId: 'repo-1',
            plan: { steps: [] },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/repos') && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
    const result = await supervisor.handleMessage(
      'subs-api uzerinde bitene kadar ilerle',
      'single-shot',
      {},
    )

    expect(result.task?.mode).toBe('autopilot')
    expect(result.reply).toContain('autopilot')
    expect(result.updatedSessions?.['single-shot']?.workspaceSessionId).toBe('single-shot')
    expect(result.updatedSessions?.['single-shot']?.activeRepoId).toBe('repo-1')
  })

  it('automatically fans out parallel autopilot when multiple repos are mentioned without keyword gating', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/multi-session') && (!init || init.method === undefined)) {
        return new Response(
          JSON.stringify({
            id: 'multi-session',
            goal: 'parallel',
            status: 'active',
            workerSurface: 'aider',
            controlSurfaces: ['terminal', 'ide', 'telegram'],
            repoRoots: [],
            managedRepos: [
              {
                repoId: 'repo-api',
                rootPath: '/host-home/Desktop/cognify-subs-api',
                priority: 100,
                status: 'idle',
                workerSurface: 'aider',
                updatedAt: new Date().toISOString(),
              },
              {
                repoId: 'repo-convert',
                rootPath: '/host-home/Desktop/convertboost',
                priority: 90,
                status: 'idle',
                workerSurface: 'aider',
                updatedAt: new Date().toISOString(),
              },
              {
                repoId: 'repo-mobile',
                rootPath: '/host-home/Desktop/vcs_mobile_ui',
                priority: 90,
                status: 'idle',
                workerSurface: 'aider',
                updatedAt: new Date().toISOString(),
              },
              {
                repoId: 'repo-llm',
                rootPath: '/host-home/Desktop/llm-friendly',
                priority: 90,
                status: 'idle',
                workerSurface: 'aider',
                updatedAt: new Date().toISOString(),
              },
            ],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.endsWith('/repos') && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/tasks') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { repoId: string; mode: string; goal: string }
        return new Response(
          JSON.stringify({
            id: `task-${body.repoId}`,
            goal: body.goal,
            mode: body.mode,
            status: 'queued',
            sessionId: 'multi-session',
            repoId: body.repoId,
            plan: { steps: [] },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
    const result = await supervisor.handleMessage(
      'convertboost, vcs_mobile_ui ve llm-friendly projelerini cognify-subs-api backend omurgasiyla bitene kadar devam et',
      'multi-session',
      {
        'multi-session': {
          workspaceSessionId: 'multi-session',
          workerSurface: 'aider',
        },
      },
    )

    expect(result.tasks).toHaveLength(4)
    expect(result.reply).toContain('paralel autopilot')
  })
})
