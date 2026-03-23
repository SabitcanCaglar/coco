export type ProjectType = 'web_app' | 'api' | 'library' | 'cli' | 'monorepo' | 'mobile' | 'unknown'
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'

// ── Triage ──────────────────────────────────────────────────────────────────

export interface LanguageInfo {
  language: string
  percentage: number
  fileCount: number
}

export interface FrameworkInfo {
  name: string
  version?: string
  confidence: number   // 0.0 – 1.0
  category?: string    // 'frontend' | 'backend' | 'orm' | 'infra'
}

export interface RedFlag {
  id: string
  severity: Severity
  message: string
  file?: string
}

export interface TriageResult {
  projectType: ProjectType
  languages: LanguageInfo[]
  primaryLanguage: string
  frameworks: FrameworkInfo[]
  packageManager: string
  hasDocker: boolean
  hasCICD: boolean
  hasTests: boolean
  hasTypeScript: boolean
  hasMonorepo: boolean
  redFlags: RedFlag[]
  urgency: 'critical' | 'high' | 'normal' | 'low'
}

// ── Vitals ──────────────────────────────────────────────────────────────────

export interface VitalsResult {
  totalFiles: number
  totalLines: number
  avgFileSize: number
  maxFileSize: { path: string; lines: number }
  avgComplexity: number
  maxComplexity: { path: string; fn: string; score: number }
  dependencyCount: number
  devDependencyCount: number
  circularDependencyCount: number
  hasTests: boolean
  testFileCount: number
  testToCodeRatio: number
  envFileCount: number
  secretsExposed: number
  outdatedDependencies: number
  hasLinter: boolean
  hasFormatter: boolean
  hasPreCommitHook: boolean
}

// ── History ─────────────────────────────────────────────────────────────────

export interface HistoryResult {
  hasGit: boolean
  commitCount: number
  contributorCount: number
  lastCommitDate?: Date
  hotspots: Array<{
    path: string
    changeCount: number
    lastChanged: Date
    authors: string[]
  }>
  highChurnFiles: Array<{
    path: string
    churn: number
    risk: 'high' | 'medium' | 'low'
  }>
}

// ── Findings ─────────────────────────────────────────────────────────────────

export interface Finding {
  id: string
  expertId: string
  category: 'security' | 'architecture' | 'performance' | 'maintainability' | 'reliability'
  severity: Severity
  title: string
  description: string
  filePath?: string
  lineStart?: number
  lineEnd?: number
  fix?: string           // kurşun geçirmez, kopyala-yapıştır fix
  references?: string[]
}

// ── Diagnosis ────────────────────────────────────────────────────────────────

export interface Condition {
  id: string
  name: string
  category: Finding['category']
  severity: Severity
  evidence: Finding[]
  affectedFiles: string[]
  estimatedDebtHours: number
  riskOfInaction: string
}

export interface Diagnosis {
  conditions: Condition[]
  severity: 'critical' | 'serious' | 'moderate' | 'healthy'
  summary: string
}

// ── Treatment ────────────────────────────────────────────────────────────────

export interface TreatmentItem {
  priority: number
  conditionId: string
  title: string
  effortHours: number
  steps: string[]
  adrPath?: string    // generated ADR file
}

export interface TreatmentPlan {
  items: TreatmentItem[]
  totalDebtHours: number
}

// ── Health Score ─────────────────────────────────────────────────────────────

export interface HealthScore {
  overall: number   // 0–100
  breakdown: {
    security: number
    architecture: number
    performance: number
    maintainability: number
    reliability: number
    testCoverage: number
  }
  grade: Grade
}

// ── Full Examination ──────────────────────────────────────────────────────────

export interface Examination {
  projectPath: string
  examinedAt: Date
  durationMs: number
  triage: TriageResult
  vitals: VitalsResult
  history: HistoryResult
  findings: Finding[]
  diagnosis: Diagnosis
  treatmentPlan: TreatmentPlan
  healthScore: HealthScore
  llmUsed: { provider: string; model: string } | null
}
