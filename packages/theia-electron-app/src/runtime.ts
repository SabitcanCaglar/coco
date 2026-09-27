import { randomUUID } from 'node:crypto'

import type { DesktopBootStatus, DesktopDaemonMode, DesktopRuntimeStatus } from '@coco/core'
import { createDaemon, orchestratorPackage } from '@coco/orchestrator'
import { type TheiaSidecarController, createTheiaSidecar } from '@coco/theia-runtime'

export interface DesktopRuntimeManagerConfig {
  mode?: DesktopDaemonMode
  externalDaemonUrl?: string
  embeddedPort?: number
  dataDir?: string
  theiaSidecar?: TheiaSidecarController
}

export interface DesktopRuntimeManager {
  readonly id: string
  getStatus(): DesktopRuntimeStatus
  getBootStatus(): DesktopBootStatus
  setMode(mode: DesktopDaemonMode): void
  setExternalDaemonUrl(url: string): void
  start(): Promise<DesktopRuntimeStatus>
  stop(): Promise<void>
}

function now(): string {
  return new Date().toISOString()
}

function stoppedTheiaStatus() {
  return {
    state: 'stopped',
    url: 'http://127.0.0.1:3011',
    host: '127.0.0.1',
    port: 3011,
    logFilePath: '',
  } as const
}

export function createDesktopRuntimeManager(
  config: DesktopRuntimeManagerConfig = {},
): DesktopRuntimeManager {
  const id = randomUUID()
  const mode = { current: config.mode ?? ('embedded' as DesktopDaemonMode) }
  const externalDaemonUrl = { current: config.externalDaemonUrl ?? 'http://127.0.0.1:3000' }
  const daemon = createDaemon({
    host: '127.0.0.1',
    port: config.embeddedPort ?? 3000,
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
  })
  let embeddedStarted = false
  let recoverySuggestion = 'Theia sidecar hazir oldugunda editor otomatik acilacak.'
  let theiaSidecar: TheiaSidecarController | undefined = config.theiaSidecar
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
    getBootStatus(): DesktopBootStatus {
      return {
        daemon: status,
        theia: theiaSidecar?.getStatus() ?? stoppedTheiaStatus(),
        currentMode: mode.current,
        recoverySuggestion,
      }
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
        status = await connectExternal(externalDaemonUrl.current)
      } else {
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
      }
      if (!config.theiaSidecar) {
        if (theiaSidecar) {
          await theiaSidecar.stop()
        }
        theiaSidecar = createTheiaSidecar({
          env: {
            COCO_THEIA_ORCHESTRATOR_URL: status.daemonUrl,
          },
        })
      }
      const ensuredTheiaSidecar = theiaSidecar
      if (!ensuredTheiaSidecar) {
        throw new Error('Theia sidecar could not be initialized.')
      }
      const theiaStatus = await ensuredTheiaSidecar.start()
      recoverySuggestion =
        theiaStatus.state === 'ready'
          ? 'Theia hazir.'
          : 'Theia baslamazsa fallback cockpit ekraninda hata detayini izle.'
      return status
    },
    async stop(): Promise<void> {
      if (theiaSidecar) {
        await theiaSidecar.stop()
      }
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
