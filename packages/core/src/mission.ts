import type { CocoId, ISO8601Timestamp } from './shared.js'

export const MISSION_STATUSES = [
  'pending',
  'running',
  'paused',
  'blocked',
  'failed',
  'completed',
  'cancelled',
] as const
export const PHASE_STEP_STATUSES = [
  'queued',
  'running',
  'retryable',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const
export const MISSION_ACTIONS = [
  'create',
  'update',
  'pause',
  'resume',
  'cancel',
  'reprioritize',
  'status',
] as const
export const EXECUTION_MODES = ['chat_only', 'one_shot', 'durable_autopilot'] as const
export const STEP_CLASSES = [
  'chat',
  'analysis',
  'edit',
  'build',
  'test',
  'research',
  'deploy',
  'migration',
  'destructive',
] as const
export const APPROVAL_MODES = ['auto', 'mixed', 'approval-heavy'] as const
export const STACK_FAMILIES = ['ts', 'csharp', 'cpp-unreal', 'mixed'] as const
export const CREATED_BY_SURFACES = ['web', 'telegram', 'api'] as const
export const MISSION_EVENT_TYPES = [
  'MissionCreated',
  'MissionUpdated',
  'MissionPaused',
  'MissionResumed',
  'MissionCancelled',
  'MissionCheckpointed',
  'MissionBlocked',
  'PhaseStarted',
  'StepQueued',
  'StepStarted',
  'StepRetried',
  'StepCompleted',
  'StepFailed',
  'WorkerAssigned',
  'ResearchAttached',
  'UserMessageReceived',
  'AssistantMessageSent',
] as const

export type MissionStatus = (typeof MISSION_STATUSES)[number]
export type PhaseStepStatus = (typeof PHASE_STEP_STATUSES)[number]
export type MissionAction = (typeof MISSION_ACTIONS)[number]
export type ExecutionMode = (typeof EXECUTION_MODES)[number]
export type StepClass = (typeof STEP_CLASSES)[number]
export type ApprovalMode = (typeof APPROVAL_MODES)[number]
export type StackFamily = (typeof STACK_FAMILIES)[number]
export type CreatedBySurface = (typeof CREATED_BY_SURFACES)[number]
export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number]

export interface WorkerCapabilities {
  canEditCode: boolean
  canRunTests: boolean
  canBuild: boolean
  canUseBrowser: boolean
  canSearchWeb: boolean
  canRunShell: boolean
  canOpenIde: boolean
  artifactPaths: string[]
  timeoutLimits: Record<string, number>
  sandboxClass: string
}

export interface RepoExecutionProfile {
  repoId: CocoId
  rootPath: string
  stackFamily: StackFamily
  runnerType: string
  buildCommands: string[]
  testCommands: string[]
  lintCommands: string[]
  artifactPaths: string[]
  sandboxClass: string
  timeoutProfile: Record<string, number>
  allowedTools: string[]
  workerCapabilities: WorkerCapabilities
}

export interface ApprovalQueueItem {
  missionId: CocoId
  stepId: CocoId
  threadId: string
  goal: string
  stepClass: StepClass
  repoId?: CocoId | undefined
  runnerType?: string | undefined
  summary: string
  createdAt: ISO8601Timestamp
}

export interface MissionAutonomyPolicy {
  mode: 'mixed-auto' | 'full-auto' | 'approval-heavy'
  retryIntervalSeconds: number
  maxAutoRetriesPerStep: number
  enableWebResearch: boolean
  pauseOnRepeatedFailure: boolean
}

export interface MissionCheckpoint {
  summary: string
  blockedReason?: string | undefined
  suggestedNextAction?: string | undefined
  createdAt: ISO8601Timestamp
}

export interface Mission {
  missionId: CocoId
  tenantId?: string | undefined
  workspaceId?: string | undefined
  userId: string
  threadId: string
  status: MissionStatus
  goal: string
  activeRepos: CocoId[]
  priority: number
  createdBySurface: CreatedBySurface
  approvalMode: ApprovalMode
  autonomyPolicy: MissionAutonomyPolicy
  assignedWorkerSet: string[]
  currentPhase: string
  checkpointSummary?: string | undefined
  blockedReason?: string | undefined
  lastHumanInputAt: ISO8601Timestamp
  createdAt: ISO8601Timestamp
  updatedAt: ISO8601Timestamp
  version: number
}

export interface MissionStep {
  phaseId: CocoId
  stepId: CocoId
  stepClass: StepClass
  status: PhaseStepStatus
  workerId?: string | undefined
  repoId?: CocoId | undefined
  inputs: Record<string, unknown>
  outputs?: Record<string, unknown> | undefined
  attemptCount: number
  maxAttempts: number
  nextRetryAt?: ISO8601Timestamp | undefined
  requiresApproval: boolean
  idempotencyKey: string
}

export interface MissionEvent {
  eventId: CocoId
  missionId: CocoId
  eventType: MissionEventType
  surface: CreatedBySurface
  causationId?: string | undefined
  correlationId?: string | undefined
  idempotencyKey: string
  entityVersion: number
  createdAt: ISO8601Timestamp
  payload: Record<string, unknown>
}

export interface ResearchRecord {
  queryBundle: string[]
  errorSignature: string
  sources: string[]
  citations: string[]
  summary: string
  recommendedAction: string
  expiresAt: ISO8601Timestamp
}

export interface MissionCommandEnvelope {
  chatReply: string
  missionAction: MissionAction
  executionMode: ExecutionMode
  targetRepos: string[]
  requestedStepClasses: StepClass[]
  autonomyPolicy: MissionAutonomyPolicy
  approvalMode: ApprovalMode
  idempotencyKey: string
  surfaceEventId: string
}
