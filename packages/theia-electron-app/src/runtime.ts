import { randomUUID } from 'node:crypto'

import type { DesktopDaemonMode, DesktopRuntimeStatus } from '@coco/core'
import { createDaemon, orchestratorPackage } from '@coco/orchestrator'

export interface DesktopRuntimeManagerConfig {
  mode?: DesktopDaemonMode
  externalDaemonUrl?: string
  embeddedPort?: number
  dataDir?: string
}

export interface DesktopRuntimeManager {
  readonly id: string
  getStatus(): DesktopRuntimeStatus
  setMode(mode: DesktopDaemonMode): void
  setExternalDaemonUrl(url: string): void
  start(): Promise<DesktopRuntimeStatus>
  stop(): Promise<void>
}

function now(): string {
  return new Date().toISOString()
}

export function createDesktopRuntimeManager(
  config: DesktopRuntimeManagerConfig = {},
): DesktopRuntimeManager {
  const id = randomUUID()
  const mode = { current: config.mode ?? ('embedded' as DesktopDaemonMode) }
  const externalDaemonUrl = { current: config.externalDaemonUrl ?? 'http://127.0.0.1:3000' }
  const daemon = createDaemon({
    host: '127.0.0.1',
    port: config.embeddedPort ?? 0,
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
  })
  let embeddedStarted = false
  let status: DesktopRuntimeStatus = {
    mode: mode.current,
    state: 'disconnected',
    daemonUrl: externalDaemonUrl.current,
    message: 'Desktop runtime hazir.',
    lastCheckedAt: now(),
  }

  async function connectExternal(url: string): Promise<DesktopRuntimeStatus> {
    try {
      const response = await fetch(`${url}/health`)
      const body = (await response.json()) as { status?: string; message?: string }
      status = {
        mode: 'external',
        state: response.ok ? 'connected' : 'error',
        daemonUrl: url,
        message: body.message ?? orchestratorPackage.message,
        lastCheckedAt: now(),
        ...(response.ok ? {} : { lastError: 'External daemon health check failed.' }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      status = {
        mode: 'external',
        state: 'error',
        daemonUrl: url,
        message: 'External daemon baglanamadi.',
        lastCheckedAt: now(),
        lastError: message,
      }
    }
    return status
  }

  return {
    id,
    getStatus(): DesktopRuntimeStatus {
      return status
    },
    setMode(nextMode: DesktopDaemonMode): void {
      mode.current = nextMode
      status = {
        ...status,
        mode: nextMode,
        daemonUrl: nextMode === 'external' ? externalDaemonUrl.current : daemon.url(),
        lastCheckedAt: now(),
      }
    },
    setExternalDaemonUrl(url: string): void {
      externalDaemonUrl.current = url
      if (mode.current === 'external') {
        status = {
          ...status,
          daemonUrl: url,
          lastCheckedAt: now(),
        }
      }
    },
    async start(): Promise<DesktopRuntimeStatus> {
      if (mode.current === 'external') {
        return connectExternal(externalDaemonUrl.current)
      }
      if (!embeddedStarted) {
        await daemon.start()
        embeddedStarted = true
      }
      status = {
        mode: 'embedded',
        state: 'connected',
        daemonUrl: daemon.url(),
        message: 'Embedded daemon desktop app tarafindan baslatildi.',
        lastCheckedAt: now(),
      }
      return status
    },
    async stop(): Promise<void> {
      if (embeddedStarted) {
        await daemon.stop()
        embeddedStarted = false
      }
      status = {
        ...status,
        state: 'disconnected',
        message: 'Desktop runtime durduruldu.',
        lastCheckedAt: now(),
      }
    },
  }
}
