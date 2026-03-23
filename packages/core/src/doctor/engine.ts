import { triage } from './phases/triage.js'
import { expertRegistry } from './experts/registry.js'
import type {
  Examination,
  Finding,
  Diagnosis,
  HealthScore,
  TreatmentPlan,
  TriageResult,
  VitalsResult,
  HistoryResult,
} from './types.js'
import type { LLMRegistry } from '../llm/registry.js'

/**
 * DoctorEngine — examines every project through a systematic 8-phase process.
 *
 * Linus philosophy: deterministic analysis first, LLM optional.
 * Full examination works without LLM — only explanations are missing.
 */
export class DoctorEngine {
  constructor(private readonly llm: LLMRegistry) {}

  async examine(projectPath: string): Promise<Examination> {
    const start = Date.now()
    const examinedAt = new Date()

    // Phase 1: Triage
    const triageResult = await triage(projectPath)

    // Phase 2: Vitals (stub — real implementation next sprint)
    const vitals = buildEmptyVitals()

    // Phase 3: History
    const history = buildEmptyHistory()

    // Phase 4+5: Framework examination
    const findings = await this.runExperts(projectPath, triageResult)

    // Phase 6: Diagnosis
    const diagnosis = this.diagnose(findings)

    // Phase 7: Treatment plan
    const treatmentPlan = this.prescribe(diagnosis)

    // Score
    const healthScore = this.calculateScore(vitals, diagnosis)

    const llmProvider = this.llm.getBestFor('codeUnderstanding')
    const llmUsed =
      llmProvider.id !== 'null'
        ? { provider: llmProvider.id, model: llmProvider.name }
        : null

    return {
      projectPath,
      examinedAt,
      durationMs: Date.now() - start,
      triage: triageResult,
      vitals,
      history,
      findings,
      diagnosis,
      treatmentPlan,
      healthScore,
      llmUsed,
    }
  }

  private async runExperts(projectPath: string, triageResult: TriageResult): Promise<Finding[]> {
    const findings: Finding[] = []

    // Generic expert — runs on every project
    const generic = expertRegistry.get('generic')
    if (generic) {
      findings.push(...(await generic.examine(projectPath, triageResult)))
    }

    // Framework-specific experts
    for (const fw of triageResult.frameworks) {
      const expert = expertRegistry.get(fw.name) ?? expertRegistry.get(fw.category ?? '')
      if (expert) {
        findings.push(...(await expert.examine(projectPath, triageResult)))
      }
    }

    return findings
  }

  private diagnose(findings: Finding[]): Diagnosis {
    const criticalCount = findings.filter((f) => f.severity === 'critical').length
    const highCount = findings.filter((f) => f.severity === 'high').length

    const overallSeverity =
      criticalCount > 0
        ? 'critical'
        : highCount > 2
        ? 'serious'
        : findings.length > 5
        ? 'moderate'
        : 'healthy'

    return {
      conditions: [],  // rule engine next sprint
      severity: overallSeverity,
      summary:
        findings.length === 0
          ? 'No significant issues detected.'
          : `Found ${findings.length} findings (${criticalCount} critical, ${highCount} high).`,
    }
  }

  private prescribe(diagnosis: Diagnosis): TreatmentPlan {
    return {
      items: diagnosis.conditions.map((c, i) => ({
        priority: i + 1,
        conditionId: c.id,
        title: c.name,
        effortHours: c.estimatedDebtHours,
        steps: [],
      })),
      totalDebtHours: diagnosis.conditions.reduce((s, c) => s + c.estimatedDebtHours, 0),
    }
  }

  private calculateScore(_vitals: VitalsResult, diagnosis: Diagnosis): HealthScore {
    const base =
      diagnosis.severity === 'critical'
        ? 25
        : diagnosis.severity === 'serious'
        ? 45
        : diagnosis.severity === 'moderate'
        ? 65
        : 85

    const grade: HealthScore['grade'] =
      base >= 80 ? 'A' : base >= 65 ? 'B' : base >= 50 ? 'C' : base >= 35 ? 'D' : 'F'

    return {
      overall: base,
      breakdown: {
        security: base,
        architecture: base,
        performance: base,
        maintainability: base,
        reliability: base,
        testCoverage: base,
      },
      grade,
    }
  }
}

function buildEmptyVitals(): VitalsResult {
  return {
    totalFiles: 0, totalLines: 0, avgFileSize: 0,
    maxFileSize: { path: '', lines: 0 },
    avgComplexity: 0,
    maxComplexity: { path: '', fn: '', score: 0 },
    dependencyCount: 0, devDependencyCount: 0, circularDependencyCount: 0,
    hasTests: false, testFileCount: 0, testToCodeRatio: 0,
    envFileCount: 0, secretsExposed: 0, outdatedDependencies: 0,
    hasLinter: false, hasFormatter: false, hasPreCommitHook: false,
  }
}

function buildEmptyHistory(): HistoryResult {
  return { hasGit: false, commitCount: 0, contributorCount: 0, hotspots: [], highChurnFiles: [] }
}
