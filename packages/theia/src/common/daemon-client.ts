import type {
  DesktopRuntimeStatus,
  MonitorEvent,
  SessionInfo,
  Task,
  TaskControlAction,
  WorkerInfo,
} from '@coco/core'

import { defaultTheiaOrchestratorUrl } from './model.js'

export interface DaemonClientConfig {
  baseUrl?: string
  fetchImpl?: typeof fetch
  mode?: DesktopRuntimeStatus['mode']
}

export interface DaemonClientSnapshot {
  runtime: DesktopRuntimeStatus
  tasks: Task[]
  workers: WorkerInfo[]
  sessions: SessionInfo[]
}

function now(): string {
  return new Date().toISOString()
}

async function expectOK(response: Response, fallbackMessage: string): Promise<Response> {
  if (response.ok) {
    return response
  }
  let message = fallbackMessage
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) {
      message = body.error
    }
  } catch {
    // Ignore JSON parse failures and use the fallback message.
  }
  throw new Error(message)
}

export function createDaemonClient(config: DaemonClientConfig = {}) {
  const fetchImpl = config.fetchImpl ?? fetch
  let runtimeMode: DesktopRuntimeStatus['mode'] = config.mode ?? 'embedded'
  let baseUrl = config.baseUrl ?? defaultTheiaOrchestratorUrl()

  function status(state: DesktopRuntimeStatus['state'], message: string, lastError?: string) {
    return {
      mode: runtimeMode,
      state,
      daemonUrl: baseUrl,
      message,
      lastCheckedAt: now(),
      ...(lastError ? { lastError } : {}),
    } satisfies DesktopRuntimeStatus
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, init)
    await expectOK(response, `Daemon request failed for ${path}.`)
    return (await response.json()) as T
  }

  return {
    getBaseUrl(): string {
      return baseUrl
    },
    setBaseUrl(nextUrl: string): void {
      baseUrl = nextUrl
    },
    getMode(): DesktopRuntimeStatus['mode'] {
      return runtimeMode
    },
    setMode(nextMode: DesktopRuntimeStatus['mode']): void {
      runtimeMode = nextMode
    },
    async getRuntimeStatus(): Promise<DesktopRuntimeStatus> {
      try {
        const health = await request<{ status: string; message?: string }>('/health')
        return status(
          'connected',
          health.message ?? (health.status === 'ok' ? 'Daemon reachable.' : 'Daemon replied.'),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return status('error', 'Daemon unreachable.', message)
      }
    },
    async getTasks(): Promise<Task[]> {
      return request<Task[]>('/tasks')
    },
    async getTask(
      taskId: string,
    ): Promise<{ task: Task; steps: unknown[]; events: MonitorEvent[] }> {
      return request<{ task: Task; steps: unknown[]; events: MonitorEvent[] }>(`/tasks/${taskId}`)
    },
    async getTaskEvents(taskId: string): Promise<MonitorEvent[]> {
      const payload = await this.getTask(taskId)
      return payload.events
    },
    async getWorkers(): Promise<WorkerInfo[]> {
      return request<WorkerInfo[]>('/workers')
    },
    async getSessions(): Promise<SessionInfo[]> {
      return request<SessionInfo[]>('/sessions')
    },
    async snapshot(): Promise<DaemonClientSnapshot> {
      const runtime = await this.getRuntimeStatus()
      const [tasks, workers, sessions] = await Promise.all([
        this.getTasks(),
        this.getWorkers(),
        this.getSessions(),
      ])
      return { runtime, tasks, workers, sessions }
    },
    async controlTask(taskId: string, action: TaskControlAction): Promise<Task> {
      return request<Task>(`/tasks/${taskId}/${action}`, {
        method: 'POST',
      })
    },
  }
}
