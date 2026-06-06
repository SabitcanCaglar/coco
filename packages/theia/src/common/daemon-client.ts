import type {
  DesktopRuntimeStatus,
  Mission,
  MissionEvent,
  MonitorEvent,
  ApprovalQueueItem,
  RepoExecutionProfile,
  SessionInfo,
  Task,
  TaskControlAction,
  WorkerInfo,
  WorkspaceSession,
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
  missions?: Mission[] | undefined
  approvals?: ApprovalQueueItem[] | undefined
}

export interface ThreadSnapshot {
  threadId: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant'
    text: string
    createdAt: string
    missionId?: string | undefined
  }>
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
    async requestThread(threadId: string): Promise<ThreadSnapshot> {
      return request<ThreadSnapshot>(`/threads/${encodeURIComponent(threadId)}`)
    },
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
    async getMissions(): Promise<Mission[]> {
      return request<Mission[]>('/missions')
    },
    async getApprovals(): Promise<ApprovalQueueItem[]> {
      return request<ApprovalQueueItem[]>('/approvals')
    },
    async approveMission(missionId: string, payload: Record<string, unknown>): Promise<Mission> {
      return request<Mission>(`/approvals/${missionId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
    async getRepoProfiles(): Promise<RepoExecutionProfile[]> {
      return request<RepoExecutionProfile[]>('/repo-profiles')
    },
    async getMission(missionId: string): Promise<Mission> {
      return request<Mission>(`/missions/${missionId}`)
    },
    async getMissionEvents(missionId: string): Promise<MissionEvent[]> {
      return request<MissionEvent[]>(`/missions/${missionId}/events`)
    },
    async postThreadMessage(
      threadId: string,
      payload: Record<string, unknown>,
    ): Promise<{ reply: string; mission?: Mission | undefined }> {
      return request<{ reply: string; mission?: Mission | undefined }>(
        `/threads/${encodeURIComponent(threadId)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
    },
    async getWorkspaceSession(sessionId: string): Promise<WorkspaceSession> {
      return request<WorkspaceSession>(`/sessions/${sessionId}`)
    },
    async discoverWorkspaceRepos(sessionId: string): Promise<WorkspaceSession> {
      return request<WorkspaceSession>(`/sessions/${sessionId}/discover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    },
    async controlWorkspaceSession(
      sessionId: string,
      payload: Record<string, unknown>,
    ): Promise<WorkspaceSession> {
      return request<WorkspaceSession>(`/sessions/${sessionId}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
    async snapshot(): Promise<DaemonClientSnapshot> {
      const runtime = await this.getRuntimeStatus()
      const [tasks, workers, sessions, approvals] = await Promise.all([
        this.getTasks(),
        this.getWorkers(),
        this.getSessions(),
        this.getApprovals().catch(() => []),
      ])
      return { runtime, tasks, workers, sessions, approvals }
    },
    async controlTask(taskId: string, action: TaskControlAction): Promise<Task> {
      return request<Task>(`/tasks/${taskId}/${action}`, {
        method: 'POST',
      })
    },
  }
}
