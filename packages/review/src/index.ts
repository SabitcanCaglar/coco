import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ReviewCheck,
  ReviewCheckResult,
  ReviewPolicy,
  ReviewReport,
  ReviewViolation,
} from '@coco/core'
import { simpleGit } from 'simple-git'

export interface ReviewContext {
  projectPath: string
  patchApplied: boolean
}

export class ReviewGate {
  readonly status = 'ready' as const

  discoverCommands(projectPath: string): ReviewPolicy['discovery'] {
    const packageJsonPath = join(projectPath, 'package.json')
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
        scripts?: Record<string, string>
      }
      return {
        build: packageJson.scripts?.build ? 'npm run build' : null,
        test:
          packageJson.scripts?.test &&
          packageJson.scripts.test !== 'echo "Error: no test specified" && exit 1'
            ? 'npm test'
            : null,
      }
    }

    return {
      build: null,
      test: null,
    }
  }

  async run(context: ReviewContext): Promise<ReviewReport> {
    const discovery = this.discoverCommands(context.projectPath)
    const checks: ReviewCheck[] = [
      {
        id: 'diff',
        name: 'Git diff summary',
        kind: 'diff',
        required: true,
      },
    ]
    if (discovery.build) {
      checks.push({
        id: 'build',
        name: 'Build command',
        kind: 'build',
        required: false,
        command: ['sh', '-lc', discovery.build],
      })
    }
    if (discovery.test) {
      checks.push({
        id: 'test',
        name: 'Test command',
        kind: 'test',
        required: false,
        command: ['sh', '-lc', discovery.test],
      })
    }

    const policy: ReviewPolicy = {
      requiredChecks: ['diff'],
      optionalChecks: ['build', 'test'],
      discovery,
    }

    const results: ReviewCheckResult[] = []
    const violations: ReviewViolation[] = []
    const git = simpleGit(context.projectPath)
    const diffSummary = await git.diffSummary()
    results.push({
      checkId: 'diff',
      status: 'pass',
      summary: `${diffSummary.files.length} files changed, +${diffSummary.insertions} / -${diffSummary.deletions}`,
    })

    for (const check of checks.filter((candidate) => candidate.command)) {
      const startedAt = Date.now()
      try {
        const [command, ...args] = check.command ?? []
        if (!command) {
          throw new Error(`Missing command for ${check.name}`)
        }
        execFileSync(command, args, {
          cwd: context.projectPath,
          stdio: 'pipe',
          env: {
            ...process.env,
            CI: '1',
          },
        })
        results.push({
          checkId: check.id,
          status: 'pass',
          summary: `${check.name} passed.`,
          durationMs: Date.now() - startedAt,
        })
      } catch (error) {
        results.push({
          checkId: check.id,
          status: 'fail',
          summary: `${check.name} failed.`,
          durationMs: Date.now() - startedAt,
        })
        violations.push({
          id: `${check.id}-failed`,
          severity: check.kind === 'test' ? 'high' : 'medium',
          summary: `${check.name} failed.`,
          checkId: check.id,
        })
        if (check.required) {
          break
        }
      }
    }

    if (!discovery.build) {
      results.push({
        checkId: 'build',
        status: 'skipped',
        summary: 'No build command was discovered.',
      })
    }

    if (!discovery.test) {
      results.push({
        checkId: 'test',
        status: 'skipped',
        summary: 'No test command was discovered.',
      })
    }

    const failedChecks = new Set(
      results.filter((result) => result.status === 'fail').map((result) => result.checkId),
    )
    const hasRequiredFailure = policy.requiredChecks.some((checkId) => failedChecks.has(checkId))
    const outcome = hasRequiredFailure ? 'fail' : context.patchApplied ? 'needs-approval' : 'pass'

    return {
      generatedAt: new Date().toISOString(),
      outcome,
      policy,
      results,
      violations,
    }
  }
}

export const reviewPackage = {
  name: '@coco/review',
  status: 'ready',
  message: 'Review gate with diff, build, and test checks.',
} as const
