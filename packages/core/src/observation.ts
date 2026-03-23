import type { HealthScore, MetricSample } from './scoring.js'
import type { ISO8601Timestamp } from './shared.js'

export interface FileMetrics {
  lineCount: number
  consoleLogs: number
  emptyCatches: number
  todos: number
  magicNumbers: number
  deepNesting: number
  hardcodedSecrets: number
}

export interface FileObservation {
  absolutePath: string
  relativePath: string
  language?: string
  metrics: FileMetrics
}

export interface ObservationSummary {
  totalFiles: number
  totalLines: number
  todoCount: number
  consoleLogCount: number
  emptyCatchCount: number
  largeFileCount: number
  envExposed: boolean
  hardcodedSecrets: number
  magicNumbers: number
  deepNesting: number
}

export interface Observation {
  projectPath: string
  observedAt: ISO8601Timestamp
  score: HealthScore
  summary: ObservationSummary
  metrics: MetricSample[]
  files: FileObservation[]
}
