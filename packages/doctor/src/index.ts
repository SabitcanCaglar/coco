import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import type {
  Diagnosis,
  DoctorFinding,
  DoctorReport,
  Observation,
  PatchPlan,
  Prescription,
  Priority,
  RepoRef,
  Severity,
} from '@coco/core'
import { observeProject } from '@coco/loop'

export interface DoctorRuntimeOptions {
  maxDepth?: number
}

export interface FrameworkExpertContext {
  repo: RepoRef
  observation: Observation
}

export interface FrameworkExpertDefinition {
  framework: string
  name: string
  description?: string
  detect(context: FrameworkExpertContext): boolean
  find(context: FrameworkExpertContext): DoctorFinding[]
  prescribe(context: FrameworkExpertContext, findings: DoctorFinding[]): Prescription[]
}

export const expertRegistry: FrameworkExpertDefinition[] = []

export function defineFrameworkExpert(
  definition: FrameworkExpertDefinition,
): FrameworkExpertDefinition {
  expertRegistry.push(definition)
  return definition
}

function now(): string {
  return new Date().toISOString()
}

function makeFinding(
  phase: DoctorFinding['phase'],
  title: string,
  summary: string,
  severity: Severity,
  targetFiles: string[],
  tags: string[],
): DoctorFinding {
  return {
    id: randomUUID(),
    phase,
    title,
    summary,
    severity,
    targetFiles,
    tags,
    evidence: targetFiles.map((filePath) => ({
      filePath,
      summary,
    })),
  }
}

function makePrescription(
  title: string,
  summary: string,
  priority: Priority,
  kind: Prescription['kind'],
  targetFiles: string[],
  patchPlan?: PatchPlan,
): Prescription {
  const prescription: Prescription = {
    id: randomUUID(),
    title,
    summary,
    priority,
    kind,
    targetFiles,
  }
  if (patchPlan) {
    prescription.patchPlan = patchPlan
  }
  return prescription
}

defineFrameworkExpert({
  framework: 'node-typescript',
  name: 'Node/TypeScript Expert',
  description: 'Looks for JavaScript or TypeScript repos and flags maintainability hotspots.',
  detect: ({ repo }) =>
    repo.languageHints.some((hint) => ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(hint)),
  find: ({ observation }) => {
    const findings: DoctorFinding[] = []
    if (observation.summary.consoleLogCount > 0) {
      findings.push(
        makeFinding(
          'examination',
          'Console logging left in source',
          `Found ${observation.summary.consoleLogCount} console logging statements in source files.`,
          'medium',
          observation.files
            .filter((file) => file.metrics.consoleLogs > 0)
            .map((file) => file.relativePath),
          ['node', 'typescript', 'maintainability'],
        ),
      )
    }

    if (observation.summary.largeFileCount > 0) {
      findings.push(
        makeFinding(
          'examination',
          'Large source files detected',
          `${observation.summary.largeFileCount} files exceed the large-file threshold.`,
          'low',
          observation.files
            .filter((file) => file.metrics.lineCount > 200)
            .map((file) => file.relativePath),
          ['node', 'typescript', 'size'],
        ),
      )
    }

    return findings
  },
  prescribe: (_context, findings) =>
    findings.map((finding) =>
      makePrescription(
        finding.title,
        finding.summary,
        finding.severity === 'medium' ? 'high' : 'medium',
        'experiment',
        finding.targetFiles,
      ),
    ),
})

defineFrameworkExpert({
  framework: 'docker',
  name: 'Docker Expert',
  description: 'Flags repos that ship Docker assets but do not ignore env files.',
  detect: ({ repo }) => repo.languageHints.includes('docker'),
  find: ({ repo, observation }) => {
    if (!existsSync(join(repo.rootPath, 'docker'))) {
      return []
    }

    if (observation.summary.envExposed) {
      return [
        makeFinding(
          'examination',
          'Environment files may be exposed',
          'The repository appears to contain .env files without an ignore rule.',
          'high',
          ['.gitignore'],
          ['docker', 'security'],
        ),
      ]
    }

    return []
  },
  prescribe: (_context, findings) =>
    findings.map((finding) =>
      makePrescription(finding.title, finding.summary, 'critical', 'advisory', finding.targetFiles),
    ),
})

defineFrameworkExpert({
  framework: 'repo-hygiene',
  name: 'Repo Hygiene Expert',
  description: 'Provides generic hygiene findings for any repository.',
  detect: () => true,
  find: ({ observation }) => {
    const findings: DoctorFinding[] = []
    if (observation.summary.todoCount > 0) {
      findings.push(
        makeFinding(
          'examination',
          'Deferred work markers detected',
          `Found ${observation.summary.todoCount} TODO/FIXME/HACK markers.`,
          'low',
          observation.files
            .filter((file) => file.metrics.todos > 0)
            .map((file) => file.relativePath),
          ['hygiene', 'maintainability'],
        ),
      )
    }
    if (observation.summary.hardcodedSecrets > 0) {
      findings.push(
        makeFinding(
          'diagnosis',
          'Potential hardcoded secrets detected',
          `Detected ${observation.summary.hardcodedSecrets} potential hardcoded secret values.`,
          'critical',
          observation.files
            .filter((file) => file.metrics.hardcodedSecrets > 0)
            .map((file) => file.relativePath),
          ['security', 'hygiene'],
        ),
      )
    }
    return findings
  },
  prescribe: (_context, findings) =>
    findings.map((finding) =>
      makePrescription(
        finding.title,
        finding.summary,
        finding.severity === 'critical' ? 'critical' : 'medium',
        finding.severity === 'critical' ? 'advisory' : 'experiment',
        finding.targetFiles,
      ),
    ),
})

async function detectLanguageHints(rootPath: string): Promise<string[]> {
  const hints = new Set<string>()
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === 'docker') hints.add('docker')
    if (!entry.isFile()) continue
    const extension = extname(entry.name).replace('.', '')
    if (extension) hints.add(extension)
    if (basename(entry.name) === 'Dockerfile') hints.add('docker')
  }
  return [...hints].sort()
}

function deriveDiagnoses(findings: DoctorFinding[]): Diagnosis[] {
  const diagnoses: Diagnosis[] = []
  const securityFindings = findings.filter((finding) =>
    finding.tags.some((tag) => ['security'].includes(tag)),
  )
  if (securityFindings.length > 0) {
    diagnoses.push({
      id: randomUUID(),
      label: 'Security hygiene debt',
      summary:
        'The repository has security-related findings that should be addressed before automation expands.',
      confidence: 0.9,
      findingIds: securityFindings.map((finding) => finding.id),
    })
  }

  const maintainabilityFindings = findings.filter((finding) =>
    finding.tags.some((tag) => ['maintainability', 'size'].includes(tag)),
  )
  if (maintainabilityFindings.length > 0) {
    diagnoses.push({
      id: randomUUID(),
      label: 'Maintainability friction',
      summary:
        'The repository has code-shape issues that are suitable for automated improvement experiments.',
      confidence: 0.8,
      findingIds: maintainabilityFindings.map((finding) => finding.id),
    })
  }

  return diagnoses
}

export class DoctorRuntime {
  async examine(repo: RepoRef, _options: DoctorRuntimeOptions = {}): Promise<DoctorReport> {
    const observation = await observeProject(repo.rootPath)
    const enrichedRepo: RepoRef = {
      ...repo,
      languageHints:
        repo.languageHints.length > 0
          ? repo.languageHints
          : await detectLanguageHints(repo.rootPath),
    }

    const context: FrameworkExpertContext = {
      repo: enrichedRepo,
      observation: {
        projectPath: repo.rootPath,
        observedAt: now(),
        score: {
          ...observation.score,
          modelVersion: 'loop-v0.1',
        },
        summary: observation.metrics,
        metrics: [],
        files: observation.fileDetails.map((file: (typeof observation.fileDetails)[number]) => {
          const language = extname(file.relativePath).replace('.', '')
          return {
            absolutePath: file.path,
            relativePath: file.relativePath,
            ...(language ? { language } : {}),
            metrics: {
              lineCount: file.lines,
              consoleLogs: file.consoleLogs,
              emptyCatches: file.emptyCatches,
              todos: file.todos,
              magicNumbers: file.magicNumbers,
              deepNesting: file.deepNesting,
              hardcodedSecrets: 0,
            },
          }
        }),
      },
    }

    const applicableExperts = expertRegistry.filter((expert) => expert.detect(context))
    const findings = applicableExperts.flatMap((expert) => expert.find(context))
    const diagnoses = deriveDiagnoses(findings)
    const prescriptions = applicableExperts.flatMap((expert) => {
      const expertFindings = findings.filter(
        (finding) => finding.tags.includes(expert.framework) || expert.framework === 'repo-hygiene',
      )
      return expert.prescribe(context, expertFindings)
    })

    return {
      generatedAt: now(),
      observation: context.observation,
      findings,
      diagnoses,
      prescriptions,
    }
  }
}

export const DoctorEngine = DoctorRuntime

export const doctorPackage = {
  name: '@coco/doctor',
  status: 'ready',
  message: 'Doctor runtime with built-in Node/TypeScript, Docker, and hygiene experts.',
} as const
