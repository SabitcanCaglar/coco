import type { DesktopRuntimeStatus, SessionInfo, Task, WorkerInfo } from '@coco/core'

export interface CocoWorkbenchPanel {
  id: string
  title: string
  area: 'left' | 'main' | 'right' | 'bottom'
  description: string
}

export interface CocoWorkbenchBlueprint {
  productName: string
  primaryMode: 'chat-first'
  panels: CocoWorkbenchPanel[]
}

export interface MonitorSnapshot {
  runtime?: DesktopRuntimeStatus | undefined
  tasks: Task[]
  workers: WorkerInfo[]
  sessions: SessionInfo[]
}

export function buildWorkbenchBlueprint(): CocoWorkbenchBlueprint {
  return {
    productName: 'Coco IDE',
    primaryMode: 'chat-first',
    panels: [
      {
        id: 'coco.chat',
        title: 'OpenClaw Chat',
        area: 'left',
        description: 'Natural-language task entrypoint backed by the shared OpenClaw supervisor.',
      },
      {
        id: 'coco.monitor',
        title: 'Task Monitor',
        area: 'right',
        description: 'Live task, worker, and session state from the orchestrator.',
      },
      {
        id: 'coco.timeline',
        title: 'Execution Timeline',
        area: 'bottom',
        description: 'Step-by-step task progress, blocked reasons, and next actions.',
      },
      {
        id: 'coco.editor',
        title: 'Workspace',
        area: 'main',
        description:
          'The main editing surface where Coco plans, reviews, and applies code changes.',
      },
    ],
  }
}

export function defaultTheiaOrchestratorUrl(): string {
  return (
    process.env.COCO_THEIA_ORCHESTRATOR_URL ??
    process.env.COCO_DAEMON_URL ??
    'http://127.0.0.1:3000'
  )
}

export function summarizeMonitorSnapshot(snapshot: MonitorSnapshot): string {
  const runningTasks = snapshot.tasks.filter((task) => task.status === 'running').length
  const blockedTasks = snapshot.tasks.filter((task) => task.status === 'blocked').length
  const busyWorkers = snapshot.workers.filter((worker) => worker.status === 'busy').length
  const runtimePrefix = snapshot.runtime
    ? `${snapshot.runtime.mode} · ${snapshot.runtime.state}`
    : 'runtime unknown'
  return `${runtimePrefix} · ${snapshot.tasks.length} tasks · ${runningTasks} running · ${blockedTasks} blocked · ${busyWorkers}/${snapshot.workers.length} workers busy · ${snapshot.sessions.length} sessions`
}

export function normalizeTaskHeadline(task: Task): string {
  return `${task.mode.toUpperCase()} · ${task.status} · ${task.goal}`.trim()
}

export function choosePrimaryTask(tasks: Task[]): Task | undefined {
  return (
    tasks.find((task) => task.status === 'running') ??
    tasks.find((task) => task.status === 'blocked') ??
    tasks.at(0)
  )
}

export function formatRuntimeLine(status: DesktopRuntimeStatus): string {
  const suffix = status.lastError ? ` · ${status.lastError}` : ''
  return `${status.mode} · ${status.state} · ${status.daemonUrl}${suffix}`
}
