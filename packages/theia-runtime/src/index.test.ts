import { describe, expect, it, vi } from 'vitest'

import { createTheiaRuntimeConfig, createTheiaSidecar } from './index.js'

describe('@coco/theia-runtime', () => {
  it('creates a node20 sidecar config by default', () => {
    const config = createTheiaRuntimeConfig()
    expect(config.nodeCommand).toBe('npx')
    expect(config.nodeArgs).toEqual(['-y', 'node@20'])
    expect(config.port).toBe(3011)
  })

  it('starts a sidecar and probes readiness', async () => {
    const spawnImpl = vi.fn(() => ({ pid: 123, killed: false, kill: vi.fn() })) as never
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 })) as typeof fetch

    const sidecar = createTheiaSidecar({
      spawnImpl,
      fetchImpl,
      workspaceRoot: '/tmp/workspace',
      appPath: '/tmp/app',
      backendMainPath: '/tmp/app/src-gen/backend/main.js',
    })

    const status = await sidecar.start()
    expect(status.state).toBe('ready')
    expect(status.pid).toBe(123)
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:3011')
  })
})
