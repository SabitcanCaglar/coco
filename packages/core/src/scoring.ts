import type { CocoId } from './shared.js'

export const SCORE_CATEGORIES = ['security', 'maintainability', 'reliability', 'size'] as const

export type ScoreCategory = (typeof SCORE_CATEGORIES)[number]

export interface MetricSample {
  key: string
  label: string
  value: number | boolean
  unit: 'count' | 'boolean' | 'ratio' | 'score' | 'ms'
  category: ScoreCategory
  direction: 'lower-is-better' | 'higher-is-better'
  weight?: number
}

export interface HealthScore extends Record<ScoreCategory, number> {
  overall: number
  modelVersion: string
}

export interface ScoringRule {
  id: CocoId
  metricKey: string
  category: ScoreCategory
  weight: number
  direction: 'lower-is-better' | 'higher-is-better'
  description: string
  maxPenalty?: number
}

export interface ScoringModel {
  id: CocoId
  version: string
  categories: readonly ScoreCategory[]
  overallWeights: Record<ScoreCategory, number>
  rules: readonly ScoringRule[]
}

const DEFAULT_OVERALL_WEIGHTS: Record<ScoreCategory, number> = {
  security: 0.3,
  maintainability: 0.3,
  reliability: 0.25,
  size: 0.15,
}

export const DEFAULT_SCORING_MODEL: ScoringModel = {
  id: 'health-score-default',
  version: '0.1.0',
  categories: SCORE_CATEGORIES,
  overallWeights: DEFAULT_OVERALL_WEIGHTS,
  rules: [
    {
      id: 'secret-penalty',
      metricKey: 'hardcodedSecrets',
      category: 'security',
      weight: 15,
      direction: 'lower-is-better',
      description: 'Penalize hardcoded credentials and likely secrets.',
      maxPenalty: 60,
    },
    {
      id: 'env-exposure-penalty',
      metricKey: 'envExposed',
      category: 'security',
      weight: 25,
      direction: 'lower-is-better',
      description: 'Penalize repositories that appear to expose .env files.',
      maxPenalty: 25,
    },
    {
      id: 'console-log-penalty',
      metricKey: 'consoleLogCount',
      category: 'maintainability',
      weight: 2,
      direction: 'lower-is-better',
      description: 'Penalize stray console logging in source files.',
      maxPenalty: 30,
    },
    {
      id: 'todo-penalty',
      metricKey: 'todoCount',
      category: 'maintainability',
      weight: 1.5,
      direction: 'lower-is-better',
      description: 'Penalize lingering TODO/FIXME/HACK markers.',
      maxPenalty: 20,
    },
    {
      id: 'magic-number-penalty',
      metricKey: 'magicNumbers',
      category: 'maintainability',
      weight: 1,
      direction: 'lower-is-better',
      description: 'Penalize repeated unexplained numeric literals.',
      maxPenalty: 15,
    },
    {
      id: 'large-file-penalty',
      metricKey: 'largeFileCount',
      category: 'maintainability',
      weight: 5,
      direction: 'lower-is-better',
      description: 'Penalize oversized files that are harder to reason about.',
      maxPenalty: 25,
    },
    {
      id: 'deep-nesting-penalty',
      metricKey: 'deepNesting',
      category: 'maintainability',
      weight: 3,
      direction: 'lower-is-better',
      description: 'Penalize deeply nested control flow.',
      maxPenalty: 15,
    },
    {
      id: 'empty-catch-penalty',
      metricKey: 'emptyCatchCount',
      category: 'reliability',
      weight: 10,
      direction: 'lower-is-better',
      description: 'Penalize empty catch blocks that suppress failures.',
      maxPenalty: 50,
    },
    {
      id: 'average-file-size-penalty',
      metricKey: 'averageLinesPerFile',
      category: 'size',
      weight: 1,
      direction: 'lower-is-better',
      description: 'Penalize high average file size as a proxy for complexity.',
      maxPenalty: 30,
    },
  ],
}
