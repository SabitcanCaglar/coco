import type { Observation } from './observation.js'
import type { PatchPlan, PatchResult } from './patch.js'
import type { ScoreCategory } from './scoring.js'
import type { CocoId } from './shared.js'

export const LOOP_MODES = ['auto', 'deterministic', 'ollama', 'openclaw'] as const

export type LoopMode = (typeof LOOP_MODES)[number]

export interface Hypothesis {
  id: CocoId
  key: string
  description: string
  category: ScoreCategory
  expectedDelta: number
  targetFiles: string[]
  rationale?: string
  patchPlan?: PatchPlan
}

export type ExperimentStatus = 'proposed' | 'validated' | 'reverted' | 'error'

export interface ExperimentResult {
  hypothesisId: CocoId
  hypothesis: string
  beforeScore: number
  afterScore: number
  delta: number
  testsPassed: boolean | null
  status: ExperimentStatus
  durationMs: number
  commitHash?: string
  branchName?: string
  worktreePath?: string
  patchArtifactPath?: string
  error?: string
  patchResult?: PatchResult
}

export interface LoopRound {
  round: number
  observation: Observation
  hypothesis?: Hypothesis
  result?: ExperimentResult
}
