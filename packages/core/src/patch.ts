import type { CocoId, Priority } from './shared.js'

export const PATCH_OPERATIONS = ['create', 'update', 'delete', 'rename'] as const

export type PatchOperation = (typeof PATCH_OPERATIONS)[number]

export const PATCH_FORMATS = ['full-file', 'unified-diff'] as const

export type PatchFormat = (typeof PATCH_FORMATS)[number]

export interface PatchHunk {
  startLine: number
  endLine: number
  before?: string
  after?: string
}

export interface FilePatch {
  path: string
  operation: PatchOperation
  format: PatchFormat
  summary: string
  content: string
  previousPath?: string
  hunks?: PatchHunk[]
}

export interface PatchPlan {
  id: CocoId
  title: string
  description: string
  rationale: string
  targetFiles: string[]
  expectedScoreDelta: number
  priority: Priority
  operations: FilePatch[]
  safetyChecks: string[]
  rollbackCommand?: string[]
}

export interface PatchResult {
  planId: CocoId
  description: string
  filesModified: number
  bytesChanged?: number
  warnings?: string[]
}
