import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  CocoPluginModule,
  ReviewCheckPlugin,
  ReviewCheckPluginContext,
  ReviewCheckPluginDefinition,
  ReviewPolicy,
  ReviewReport,
} from '@coco/core'
import { resolvePluginEntrypoints, validatePluginModule } from '@coco/core'
import { simpleGit } from 'simple-git'

export interface ReviewContext extends ReviewCheckPluginContext {}

export interface ReviewGateConfig {
  pluginPaths?: string[]
  checks?: ReviewCheckPluginDefinition[]
}

function discoverPackageScripts(projectPath: string): {
  build: string | null
  test: string | null
} {
  const packageJsonPath = join(projectPath, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return { build: null, test: null }
  }

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

function builtInReviewPlugins(): ReviewCheckPlugin[] {
  return [
    {
      manifest: {
        name: '@coco/plugin-review-diff',
        version: '0.1.0',
        kind: 'review-check',
        source: 'builtin',
        capabilities: ['review-diff'],
        description: 'Git diff summary review check.',
      },
      check: {
        id: 'diff',
        name: 'Git diff summary',
        kind: 'diff',
        required: true,
        discover: () => null,
        run: async (context) => {
          const diffSummary = await simpleGit(context.projectPath).diffSummary()
          return {
            result: {
              checkId: 'diff',
              status: 'pass',
              summary: `${diffSummary.files.length} files changed, +${diffSummary.insertions} / -${diffSummary.deletions}`,
            },
          }
        },
      },
    },
    {
      manifest: {
        name: '@coco/plugin-review-build',
        version: '0.1.0',
        kind: 'review-check',
        source: 'builtin',
        capabilities: ['review-build'],
        description: 'Build command review check.',
      },
      check: {
        id: 'build',
        name: 'Build command',
        kind: 'build',
        required: false,
        discover: (context) => {
          const discovery = discoverPackageScripts(context.projectPath)
          return discovery.build ? ['sh', '-lc', discovery.build] : null
        },
        run: (context, command) =>
          runShellCheck(context.projectPath, 'build', 'Build command', command),
      },
    },
    {
      manifest: {
        name: '@coco/plugin-review-test',
        version: '0.1.0',
        kind: 'review-check',
        source: 'builtin',
        capabilities: ['review-test'],
        description: 'Test command review check.',
      },
      check: {
        id: 'test',
        name: 'Test command',
        kind: 'test',
        required: false,
        discover: (context) => {
          const discovery = discoverPackageScripts(context.projectPath)
          return discovery.test ? ['sh', '-lc', discovery.test] : null
        },
        run: (context, command) =>
          runShellCheck(context.projectPath, 'test', 'Test command', command),
      },
    },
  ]
}

function runShellCheck(
  projectPath: string,
  checkId: string,
  name: string,
  command: string[] | null,
) {
  if (!command) {
    return {
      result: {
        checkId,
        status: 'skipped' as const,
        summary: `No ${checkId} command was discovered.`,
      },
    }
  }

  const [binary, ...args] = command
  if (!binary) {
    return {
      result: {
        checkId,
        status: 'skipped' as const,
        summary: `No ${checkId} command was discovered.`,
      },
    }
  }
  const startedAt = Date.now()
  try {
    execFileSync(binary, args, {
      cwd: projectPath,
      stdio: 'pipe',
      env: {
        ...process.env,
        CI: '1',
      },
    })
    return {
      result: {
        checkId,
        status: 'pass' as const,
        summary: `${name} passed.`,
        durationMs: Date.now() - startedAt,
      },
    }
  } catch {
    return {
      result: {
        checkId,
        status: 'fail' as const,
        summary: `${name} failed.`,
        durationMs: Date.now() - startedAt,
      },
      violations: [
        {
          id: `${checkId}-failed`,
          severity: checkId === 'test' ? ('high' as const) : ('medium' as const),
          summary: `${name} failed.`,
          checkId,
        },
      ],
    }
  }
}

export async function loadReviewCheckPlugins(pluginPaths: string[]): Promise<ReviewCheckPlugin[]> {
  const loaded: ReviewCheckPlugin[] = []
  for (const pluginPath of await resolvePluginEntrypoints(pluginPaths)) {
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      default?: CocoPluginModule
      plugin?: CocoPluginModule
    }
    const plugin = module.plugin ?? module.default
    if (!plugin || plugin.manifest.kind !== 'review-check') {
      continue
    }
    const validation = validatePluginModule(plugin)
    if (!validation.valid) {
      throw new Error(
        `Invalid review check plugin at ${pluginPath}: ${validation.errors.join(' ')}`,
      )
    }
    loaded.push(plugin as ReviewCheckPlugin)
  }
  return loaded
}

export function listReviewPlugins(): ReviewCheckPlugin[] {
  return builtInReviewPlugins()
}

export class ReviewGate {
  readonly status = 'ready' as const
  private externalChecks: ReviewCheckPluginDefinition[] | null = null

  constructor(private readonly config: ReviewGateConfig = {}) {}

  private async getChecks(): Promise<ReviewCheckPluginDefinition[]> {
    if (this.externalChecks === null) {
      const externalPlugins = await loadReviewCheckPlugins(this.config.pluginPaths ?? [])
      this.externalChecks = externalPlugins.map((plugin) => plugin.check)
    }
    return [
      ...builtInReviewPlugins().map((plugin) => plugin.check),
      ...(this.config.checks ?? []),
      ...this.externalChecks,
    ]
  }

  async run(context: ReviewContext): Promise<ReviewReport> {
    const checks = await this.getChecks()
    const discovery: ReviewPolicy['discovery'] = {
      build: null,
      test: null,
    }
    const results: ReviewReport['results'] = []
    const violations: ReviewReport['violations'] = []

    for (const check of checks) {
      const command = await check.discover(context)
      if (check.kind === 'build') {
        discovery.build = command ? command.join(' ') : null
      }
      if (check.kind === 'test') {
        discovery.test = command ? command.join(' ') : null
      }

      const execution = await check.run(context, command)
      results.push(execution.result)
      if (execution.violations) {
        violations.push(...execution.violations)
      }
    }

    const policy: ReviewPolicy = {
      requiredChecks: checks.filter((check) => check.required).map((check) => check.kind),
      optionalChecks: checks.filter((check) => !check.required).map((check) => check.kind),
      discovery,
    }

    const failedChecks = new Set(
      results.filter((result) => result.status === 'fail').map((result) => result.checkId),
    )
    const requiredCheckIds = new Set(
      checks.filter((check) => check.required).map((check) => check.id),
    )
    const hasRequiredFailure = [...failedChecks].some((checkId) => requiredCheckIds.has(checkId))
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
  message: 'Review gate with plugin-backed diff, build, and test checks.',
} as const
