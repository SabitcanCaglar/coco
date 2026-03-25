import type { CocoId, ISO8601Timestamp } from './shared.js'

export const TASK_MODES = ['analyze', 'fix', 'autopilot'] as const
export const TASK_STATUSES = [
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'blocked',
  'canceled',
] as const
export const TASK_STEP_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'blocked',
] as const
export const WORKER_KINDS = ['analysis-worker', 'fix-worker', 'background-worker'] as const
export const WORKER_STATUSES = ['idle', 'busy', 'offline'] as const

export type TaskMode = (typeof TASK_MODES)[number]
export type TaskStatus = (typeof TASK_STATUSES)[number]
export type TaskStepStatus = (typeof TASK_STEP_STATUSES)[number]
export type WorkerKind = (typeof WORKER_KINDS)[number]
export type WorkerStatus = (typeof WORKER_STATUSES)[number]

export interface TaskStep {
  id: CocoId
  taskId: CocoId
  order: number
  tool: string
  title: string
  status: TaskStepStatus
  input?: Record<string, unknown> | undefined
  outputSummary?: string | undefined
  startedAt?: ISO8601Timestamp | undefined
  finishedAt?: ISO8601Timestamp | undefined
}

export interface TaskPlan {
  steps: TaskStep[]
  currentStepId?: CocoId | undefined
  successCriteria?: string | undefined
  stopCriteria?: string | undefined
}

export interface TaskMemory {
  repoSummary?: string | undefined
  gitState?: Record<string, unknown> | undefined
  doctorSummary?: string | undefined
  loopSummary?: string | undefined
  notes?: string[] | undefined
  lastUpdatedAt: ISO8601Timestamp
}

export interface TaskCheckpoint {
  currentPhase: string
  cycleCount: number
  lastCompletedStepId?: CocoId | undefined
  summary?: string | undefined
  updatedAt: ISO8601Timestamp
}

export interface TaskArtifactSummary {
  reviewOutcome?: string | undefined
  patchArtifactPath?: string | undefined
  worktreePath?: string | undefined
  branchName?: string | undefined
  commitHash?: string | undefined
}

export interface Task {
  id: CocoId
  goal: string
  mode: TaskMode
  status: TaskStatus
  sessionId: string
  repoId?: CocoId | undefined
  plan: TaskPlan
  memory?: TaskMemory | undefined
  checkpoint?: TaskCheckpoint | undefined
  latestSummary?: string | undefined
  blockedReason?: string | undefined
  activeWorkerId?: CocoId | undefined
  artifacts?: TaskArtifactSummary | undefined
  createdAt: ISO8601Timestamp
  updatedAt: ISO8601Timestamp
}

export interface WorkerInfo {
  id: CocoId
  kind: WorkerKind
  status: WorkerStatus
  currentTaskId?: CocoId | undefined
  currentStepId?: CocoId | undefined
  repoId?: CocoId | undefined
  lastHeartbeat: ISO8601Timestamp
  lastError?: string | undefined
}

export interface SessionInfo {
  id: string
  activeRepoId?: CocoId | undefined
  activeTaskId?: CocoId | undefined
  updatedAt: ISO8601Timestamp
  taskCount: number
}

export interface MonitorEvent {
  id: CocoId
  taskId: CocoId
  timestamp: ISO8601Timestamp
  phase: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  data?: Record<string, unknown>
}

export interface TaskCreateInput {
  goal: string
  mode: TaskMode
  sessionId: string
  repoId?: CocoId | undefined
  provider?: string | undefined
  model?: string | undefined
  successCriteria?: string | undefined
  maxCycles?: number | undefined
}
