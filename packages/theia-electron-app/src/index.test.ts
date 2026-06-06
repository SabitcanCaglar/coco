import { afterEach, describe, expect, it } from 'vitest'

import { createDaemon } from '@coco/orchestrator'

import { buildAgentOverlayScript } from './overlay.js'
import { createDesktopRuntimeManager } from './runtime.js'

function stubSidecar(state: 'ready' | 'error' | 'stopped' = 'ready') {
  let current = {
    state,
    url: 'http://127.0.0.1:3011',
    host: '127.0.0.1',
    port: 3011,
    logFilePath: '/tmp/theia.log',
  }
  return {
    getConfig() {
      return {
        host: '127.0.0.1',
        port: 3011,
        workspaceRoots: ['/tmp/workspace'],
        logFilePath: '/tmp/theia.log',
        nodeCommand: 'npx',
        nodeArgs: ['-y', 'node@20'],
      }
    },
    getStatus() {
      return current
    },
    async start() {
      current = {
        ...current,
        state,
      }
      return current
    },
    async stop() {
      current = {
        ...current,
        state: 'stopped',
      }
    },
    async probe() {
      return current
    },
  }
}

describe('@coco/theia-electron-app', () => {
  afterEach(async () => {
    // no-op guard for tests that stop their own daemons
  })

  it('starts an embedded daemon by default', async () => {
    const manager = createDesktopRuntimeManager({
      embeddedPort: 0,
      theiaSidecar: stubSidecar() as never,
    })
    const status = await manager.start()
    expect(status.mode).toBe('embedded')
    expect(status.state).toBe('connected')
    expect(status.daemonUrl).toContain('127.0.0.1')
    expect(['ready', 'error']).toContain(manager.getBootStatus().theia.state)
    await manager.stop()
    expect(manager.getStatus().state).toBe('disconnected')
  })

  it('attaches to an external daemon when requested', async () => {
    const daemon = createDaemon({ host: '127.0.0.1', port: 0 })
    await daemon.start()
    const manager = createDesktopRuntimeManager({
      mode: 'external',
      externalDaemonUrl: daemon.url(),
      embeddedPort: 0,
      theiaSidecar: stubSidecar() as never,
    })
    const status = await manager.start()
    expect(status.mode).toBe('external')
    expect(status.state).toBe('connected')
    await daemon.stop()
    await manager.stop()
  })

  it('builds the agent overlay script with the expected cockpit markers', () => {
    const script = buildAgentOverlayScript()
    expect(script).toContain('coco-agent-overlay')
    expect(script).toContain('OpenClaw')
    expect(script).toContain('__COCO_DESKTOP__')
    expect(script).toContain('Connecting to Coco bridge')
  })
})
