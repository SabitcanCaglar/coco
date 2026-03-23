import type { Observation } from './observation.js'
import type { PatchPlan } from './patch.js'
import type { CocoId, ISO8601Timestamp, Priority, Severity } from './shared.js'

export const DOCTOR_PHASES = [
  'triage',
  'vitals',
  'history',
  'examination',
  'lab',
  'diagnosis',
  'treatment',
  'follow-up',
] as const

export type DoctorPhase = (typeof DOCTOR_PHASES)[number]

export interface EvidenceItem {
  filePath: string
  summary: string
  excerpt?: string
}

export interface DoctorFinding {
  id: CocoId
  phase: DoctorPhase
  title: string
  summary: string
  severity: Severity
  tags: string[]
  evidence: EvidenceItem[]
  targetFiles: string[]
}

export interface Diagnosis {
  id: CocoId
  label: string
  summary: string
  confidence: number
  findingIds: CocoId[]
}

export interface Prescription {
  id: CocoId
  title: string
  summary: string
  kind: 'advisory' | 'autofix' | 'experiment'
  priority: Priority
  targetFiles: string[]
  patchPlan?: PatchPlan
}

export interface DoctorReport {
  generatedAt: ISO8601Timestamp
  observation: Observation
  findings: DoctorFinding[]
  diagnoses: Diagnosis[]
  prescriptions: Prescription[]
}
