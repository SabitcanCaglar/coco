import type { DoctorReport } from './doctor.js'
import type { ExperimentResult } from './loop.js'
import type { ReviewReport } from './review.js'
import type { CocoId, ISO8601Timestamp } from './shared.js'

export type JobType = 'doctor' | 'loop'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'retryable'

export type JobLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DoctorJobPayload {
  provider?: string
  model?: string
}

export interface LoopJobPayload {
  rounds: number
  provider?: string
  model?: string
  dryRun?: boolean
  goal?: string
  planExcerpt?: string
}

export type JobPayload = DoctorJobPayload | LoopJobPayload

export interface Job {
  id: CocoId
  type: JobType
  repoId: CocoId
  requestedAt: ISO8601Timestamp
  startedAt?: ISO8601Timestamp
  finishedAt?: ISO8601Timestamp
  status: JobStatus
  payload: JobPayload
}

export interface JobEvent {
  id: CocoId
  jobId: CocoId
  timestamp: ISO8601Timestamp
  phase: string
  level: JobLevel
  message: string
  data?: Record<string, unknown>
}

export interface JobResult {
  jobId: CocoId
  repoId: CocoId
  type: JobType
  success: boolean
  report?: DoctorReport
  experiment?: ExperimentResult
  review?: ReviewReport
  summary: string
}
