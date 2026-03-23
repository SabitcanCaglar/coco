import type { CocoId, ISO8601Timestamp, Severity } from './shared.js'

export const REVIEW_CHECK_KINDS = ['lint', 'test', 'build', 'diff', 'policy'] as const

export type ReviewCheckKind = (typeof REVIEW_CHECK_KINDS)[number]

export type ReviewOutcome = 'pass' | 'fail' | 'needs-approval'

export interface ReviewCheck {
  id: CocoId
  name: string
  kind: ReviewCheckKind
  required: boolean
  command?: string[]
}

export interface ReviewCheckResult {
  checkId: CocoId
  status: 'pass' | 'fail' | 'skipped'
  summary: string
  durationMs?: number
}

export interface ReviewViolation {
  id: CocoId
  severity: Severity
  summary: string
  checkId?: CocoId
  filePath?: string
}

export interface ReviewReport {
  generatedAt: ISO8601Timestamp
  outcome: ReviewOutcome
  results: ReviewCheckResult[]
  violations: ReviewViolation[]
}
