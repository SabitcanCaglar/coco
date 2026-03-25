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
    process.env.COCO_HOST_HOME = hostHome
    const repoPath = join(hostHome, 'Desktop', 'Subs-api')
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(repoPath, 'Subs-api.sln'), '')

    try {
      const supervisor = createSupervisor({ daemonUrl: 'http://127.0.0.1:3000' })
      const result = await supervisor.handleMessage("Desktop'taki projeleri listele", 's', {})
      expect(result.reply).toContain('Desktop projelerini listeliyorum.')
      expect(result.reply).toContain('Subs-api')
    } finally {
      await rm(hostHome, { recursive: true, force: true })
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
})
