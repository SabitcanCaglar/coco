import type { CocoId, ISO8601Timestamp } from './shared.js'

export const TASK_MODES = ['analyze', 'fix', 'autopilot'] as const
export const WORKER_SURFACES = ['aider', 'roo', 'openclaw'] as const
export const CONTROL_SURFACES = ['terminal', 'ide', 'telegram'] as const
export const MILESTONE_STATUSES = ['pending', 'reached', 'blocked'] as const
export const REVIEW_DECISIONS = ['pass', 'revise', 'blocked', 'needs-human-approval'] as const
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
export type WorkerSurface = (typeof WORKER_SURFACES)[number]
export type ControlSurface = (typeof CONTROL_SURFACES)[number]
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]
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
  reviewDecision?: ReviewDecision | undefined
  milestoneTarget?: string | undefined
  executionSurface?: WorkerSurface | undefined
  patchArtifactPath?: string | undefined
  worktreePath?: string | undefined
  branchName?: string | undefined
  commitHash?: string | undefined
}

export interface MilestoneDefinition {
  id: CocoId
  key: string
  title: string
  status: MilestoneStatus
  summary?: string | undefined
  successCriteria?: string | undefined
  reachedAt?: ISO8601Timestamp | undefined
}

export interface ManagedRepoState {
  repoId: CocoId
  rootPath: string
  priority: number
  status: 'idle' | 'active' | 'blocked' | 'reviewing'
  workerSurface: WorkerSurface
  lastMilestone?: string | undefined
  lastReviewOutcome?: string | undefined
  lastReviewDecision?: ReviewDecision | undefined
  goalRelevance?: number | undefined
  hints?: string[] | undefined
  updatedAt: ISO8601Timestamp
}

export interface WorkspaceSession {
  id: CocoId
  goal: string
  status: 'active' | 'paused' | 'completed'
  workerSurface: WorkerSurface
  controlSurfaces: ControlSurface[]
  successCriteria?: string | undefined
  repoRoots: string[]
  managedRepos: ManagedRepoState[]
  focusRepoId?: CocoId | undefined
  activeTaskId?: CocoId | undefined
  activeWorkerId?: CocoId | undefined
  latestSummary?: string | undefined
  lastReviewDecision?: ReviewDecision | undefined
  createdAt: ISO8601Timestamp
  updatedAt: ISO8601Timestamp
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
  goal?: string | undefined
  status?: 'active' | 'paused' | 'completed' | undefined
  workerSurface?: WorkerSurface | undefined
  controlSurfaces?: ControlSurface[] | undefined
  focusRepoId?: CocoId | undefined
  managedRepos?: ManagedRepoState[] | undefined
  latestSummary?: string | undefined
  lastReviewDecision?: ReviewDecision | undefined
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
  workerSurface?: WorkerSurface | undefined
  managedRepoId?: CocoId | undefined
  milestoneTarget?: string | undefined
  successCriteria?: string | undefined
  maxCycles?: number | undefined
}
