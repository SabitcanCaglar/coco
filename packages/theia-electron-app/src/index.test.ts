import { afterEach, describe, expect, it } from 'vitest'

import { createDaemon } from '@coco/orchestrator'

import { createDesktopRuntimeManager } from './runtime.js'

describe('@coco/theia-electron-app', () => {
  afterEach(async () => {
    // no-op guard for tests that stop their own daemons
  })

  it('starts an embedded daemon by default', async () => {
    const manager = createDesktopRuntimeManager()
    const status = await manager.start()
    expect(status.mode).toBe('embedded')
    expect(status.state).toBe('connected')
    expect(status.daemonUrl).toContain('127.0.0.1')
    await manager.stop()
    expect(manager.getStatus().state).toBe('disconnected')
  })

  it('attaches to an external daemon when requested', async () => {
    const daemon = createDaemon({ host: '127.0.0.1', port: 0 })
    await daemon.start()
    const manager = createDesktopRuntimeManager({
      mode: 'external',
      externalDaemonUrl: daemon.url(),
    })
    const status = await manager.start()
    expect(status.mode).toBe('external')
    expect(status.state).toBe('connected')
    await daemon.stop()
    await manager.stop()
  })
})
