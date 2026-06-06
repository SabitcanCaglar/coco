import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ExperimentResult, Job, JobEvent, JobResult, LoopJobPayload, RepoRef } from '@coco/core'
import { DoctorRuntime } from '@coco/doctor'
import { LLMRegistry } from '@coco/llm'
import { runKarpathyLoop } from '@coco/loop'
import { ReviewGate } from '@coco/review'
import { simpleGit } from 'simple-git'

const HEARTBEAT_INTERVAL_MS = 60_000

function getConfiguredPluginPaths(): string[] {
  return (process.env.COCO_PLUGIN_PATHS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export interface WorkerServices {
  getRepo(repoId: string): Promise<RepoRef>
  appendEvent(event: Omit<JobEvent, 'id' | 'timestamp'>): Promise<void>
  pluginPaths?: string[]
}

export interface GitIdentityResolution {
  name: string
  email: string
  source: 'repo-config' | 'env' | 'git-log' | 'default'
}

export const workerPackage = {
  name: '@coco/worker',
  status: 'ready',
  message: 'Local execution worker for doctor and loop jobs.',
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
} as const

function toLoopMode(provider?: string): 'auto' | 'deterministic' | 'ollama' | 'openclaw' {
  switch (provider) {
    case 'ollama':
      return 'ollama'
    case 'openclaw':
    case 'openrouter':
      return 'openclaw'
    case 'null':
      return 'deterministic'
    default:
      return 'auto'
  }
}

function runExec(file: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message))
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

async function detectCommand(command: string, cwd: string): Promise<boolean> {
  try {
    await runExec('sh', ['-lc', `command -v ${command}`], cwd)
    return true
  } catch {
    return false
  }
}

function normalizeExecutionSurface(payload: LoopJobPayload): 'aider' | 'roo' | 'openclaw' {
  if (payload.executionSurface === 'roo') return 'roo'
  if (payload.executionSurface === 'openclaw') return 'openclaw'
  return 'aider'
}

async function runAiderAdapter(
  repo: RepoRef,
  payload: LoopJobPayload,
): Promise<ExperimentResult | undefined> {
  const hasAider = await detectCommand('aider', repo.rootPath)
  if (!hasAider) {
    return undefined
  }

  const git = simpleGit(repo.rootPath)
  const baseBranch =
    (await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => repo.defaultBranch)).trim() ||
    repo.defaultBranch
  const branchName = `coco/aider-${Date.now()}`
  const worktreeRoot = join(repo.rootPath, '..', '.coco-worktrees', basename(repo.rootPath))
  const worktreePath = join(worktreeRoot, branchName.replaceAll('/', '-'))
  await mkdir(worktreeRoot, { recursive: true })
  await git.raw(['worktree', 'add', '-b', branchName, worktreePath, baseBranch])

  try {
    const message = [
      payload.goal ?? 'Improve the repository safely.',
      payload.planExcerpt ? `Plan:\n${payload.planExcerpt}` : null,
      payload.successCriteria ? `Success criteria:\n${payload.successCriteria}` : null,
      payload.milestoneTarget ? `Milestone target: ${payload.milestoneTarget}` : null,
      'Apply the smallest safe change, run relevant tests, and create a git commit.',
    ]
      .filter(Boolean)
      .join('\n\n')

    const transcriptDir = join(repo.rootPath, '..', '.coco-artifacts', basename(repo.rootPath), 'aider')
    await mkdir(transcriptDir, { recursive: true })
    const transcriptPath = join(transcriptDir, `${branchName.replaceAll('/', '-')}.log`)

    const args = ['--yes-always', '--message', message]
    if (payload.model) {
      args.unshift(payload.model)
      args.unshift('--model')
    }

    const startedAt = Date.now()
    const { stdout, stderr } = await runExec('aider', args, worktreePath)
    await writeFile(transcriptPath, [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n'), 'utf-8')

    const status = await simpleGit(worktreePath).status()
    const head = (await simpleGit(worktreePath).revparse(['HEAD']).catch(() => '')).trim()
    const diffSummary = await simpleGit(worktreePath).diffSummary([`${baseBranch}...HEAD`]).catch(() => undefined)

    return {
      hypothesisId: `aider-${Date.now()}`,
      hypothesis: payload.goal ?? 'Aider execution',
      beforeScore: 0,
      afterScore: 0,
      delta: 0,
      testsPassed: null,
      status: status.isClean() ? 'error' : 'validated',
      durationMs: Date.now() - startedAt,
      ...(head ? { commitHash: head } : {}),
      branchName,
      worktreePath,
      patchArtifactPath: transcriptPath,
      ...(diffSummary
        ? {
            patchResult: {
              planId: `aider-${Date.now()}`,
              description: `Aider modified ${diffSummary.files.length} files.`,
              filesModified: diffSummary.files.length,
            },
          }
        : {}),
      ...(status.isClean() ? { error: 'Aider completed without producing a diff.' } : {}),
    }
  } catch (error) {
    await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => undefined)
    throw error
  }
}

async function emit(
  services: WorkerServices,
  jobId: string,
  phase: string,
  message: string,
  level: JobEvent['level'] = 'info',
  data?: Record<string, unknown>,
): Promise<void> {
  const event: Omit<JobEvent, 'id' | 'timestamp'> = {
    jobId,
    phase,
    level,
    message,
  }
  if (data) {
    event.data = data
  }
  await services.appendEvent(event)
}

export async function resolveGitIdentity(repoPath: string): Promise<GitIdentityResolution> {
  const git = simpleGit(repoPath)
  const configuredName = (await git.raw(['config', '--get', 'user.name']).catch(() => '')).trim()
  const configuredEmail = (await git.raw(['config', '--get', 'user.email']).catch(() => '')).trim()
  if (configuredName && configuredEmail) {
    return {
      name: configuredName,
      email: configuredEmail,
      source: 'repo-config',
    }
  }

  const envName = process.env.COCO_GIT_USER_NAME?.trim()
  const envEmail = process.env.COCO_GIT_USER_EMAIL?.trim()
  if (envName && envEmail) {
    await git.addConfig('user.name', envName)
    await git.addConfig('user.email', envEmail)
    return {
      name: envName,
      email: envEmail,
      source: 'env',
    }
  }

  const logName = (await git.raw(['log', '-1', '--pretty=%an']).catch(() => '')).trim()
  const logEmail = (await git.raw(['log', '-1', '--pretty=%ae']).catch(() => '')).trim()
  if (logName && logEmail) {
    await git.addConfig('user.name', logName)
    await git.addConfig('user.email', logEmail)
    return {
      name: logName,
      email: logEmail,
      source: 'git-log',
    }
  }

  const fallback = {
    name: 'Coco Agent',
    email: 'coco-agent@local.invalid',
  }
  await git.addConfig('user.name', fallback.name)
  await git.addConfig('user.email', fallback.email)
  return {
    ...fallback,
    source: 'default',
  }
}

export async function runJob(job: Job, services: WorkerServices): Promise<JobResult> {
  const repo = await services.getRepo(job.repoId)
  const pluginPaths = services.pluginPaths ?? getConfiguredPluginPaths()
  const doctor = new DoctorRuntime({ pluginPaths })
  const review = new ReviewGate({ pluginPaths })
  const llm = new LLMRegistry(undefined, { pluginPaths })

  await emit(services, job.id, 'worker', `Starting ${job.type} job for ${repo.rootPath}.`)

  if (job.type === 'doctor') {
    await emit(services, job.id, 'doctor', 'Running doctor examination.')
    const report = await doctor.examine(repo)
    const reviewReport = await review.run({
      projectPath: repo.rootPath,
      patchApplied: false,
    })
    await emit(services, job.id, 'doctor', 'Doctor examination completed.')
    return {
      jobId: job.id,
      repoId: repo.id,
      type: job.type,
      success: true,
      report,
      review: reviewReport,
      summary: `Doctor completed with ${report.findings.length} findings and ${report.prescriptions.length} prescriptions.`,
    }
  }

  await emit(services, job.id, 'doctor', 'Collecting baseline report before loop run.')
  const gitIdentity = await resolveGitIdentity(repo.rootPath)
  await emit(
    services,
    job.id,
    'git',
    `Using git identity ${gitIdentity.name} <${gitIdentity.email}> (${gitIdentity.source}).`,
  )
  const report = await doctor.examine(repo)
  const selection: { provider?: string; model?: string } = {}
  if ('provider' in job.payload && job.payload.provider) {
    selection.provider = job.payload.provider
  }
  if ('model' in job.payload && job.payload.model) {
    selection.model = job.payload.model
  }
  const resolution = await llm.resolve(selection)
  const loopPayload = job.payload as LoopJobPayload
  const executionSurface = normalizeExecutionSurface(loopPayload)
  await emit(services, job.id, 'loop', 'Running Karpathy Loop experiment.', 'info', {
    provider: resolution.provider,
    model: resolution.model,
    executionSurface,
  })
  let latestExperiment: Record<string, unknown> | undefined =
    executionSurface === 'aider' ? ((await runAiderAdapter(repo, loopPayload)) as unknown as Record<string, unknown> | undefined) : undefined
  let loopSummary:
    | Awaited<ReturnType<typeof runKarpathyLoop>>
    | undefined
  if (!latestExperiment || latestExperiment.status === 'error') {
    loopSummary = await runKarpathyLoop({
      projectPath: repo.rootPath,
      rounds:
        'rounds' in job.payload && typeof job.payload.rounds === 'number' ? job.payload.rounds : 1,
      dryRun: 'dryRun' in job.payload ? Boolean(job.payload.dryRun) : false,
      verbose: false,
      mode: toLoopMode(resolution.provider),
      model: resolution.model,
      ollamaUrl: 'http://127.0.0.1:11434',
      ...(process.env.OPENROUTER_API_KEY ? { openRouterApiKey: process.env.OPENROUTER_API_KEY } : {}),
      ...(process.env.OPENROUTER_BASE_URL
        ? { openRouterBaseUrl: process.env.OPENROUTER_BASE_URL }
        : {}),
      mergeValidated: false,
      ...('goal' in job.payload && typeof job.payload.goal === 'string'
        ? { taskGoal: job.payload.goal }
        : {}),
      ...('planExcerpt' in job.payload && typeof job.payload.planExcerpt === 'string'
        ? { planExcerpt: job.payload.planExcerpt }
        : {}),
    })
    latestExperiment = loopSummary.results.at(-1) as unknown as Record<string, unknown> | undefined
  }
  const reviewPath =
      latestExperiment?.status === 'validated' && typeof latestExperiment.worktreePath === 'string'
        ? latestExperiment.worktreePath
        : repo.rootPath
  const reviewReport = await review.run({
    projectPath: reviewPath,
    patchApplied:
      latestExperiment?.status === 'validated' ||
      Boolean(loopSummary && loopSummary.validated.length > 0),
    ...(loopPayload.goal ? { goal: loopPayload.goal } : {}),
    ...(loopPayload.successCriteria ? { successCriteria: loopPayload.successCriteria } : {}),
    ...(loopPayload.milestoneTarget ? { milestoneTarget: loopPayload.milestoneTarget } : {}),
  })
  await emit(services, job.id, 'review', 'Review gate completed.', 'info', {
    outcome: reviewReport.outcome,
  })

  const experiment = latestExperiment
    ? {
        hypothesisId: String(latestExperiment.hypothesisId ?? 'unknown'),
        hypothesis: String(latestExperiment.hypothesis ?? 'unknown'),
        beforeScore: Number(latestExperiment.beforeScore ?? 0),
        afterScore: Number(latestExperiment.afterScore ?? 0),
        delta: Number(latestExperiment.delta ?? 0),
        testsPassed:
          typeof latestExperiment.testsPassed === 'boolean' || latestExperiment.testsPassed === null
            ? latestExperiment.testsPassed
            : null,
        status: String(latestExperiment.status ?? 'error') as ExperimentResult['status'],
        durationMs:
          typeof latestExperiment.durationMs === 'number'
            ? latestExperiment.durationMs
            : Number(latestExperiment.duration ?? 0),
        ...(typeof latestExperiment.commitHash === 'string'
          ? { commitHash: latestExperiment.commitHash }
          : {}),
        ...(typeof latestExperiment.branchName === 'string'
          ? { branchName: latestExperiment.branchName }
          : {}),
        ...(typeof latestExperiment.worktreePath === 'string'
          ? { worktreePath: latestExperiment.worktreePath }
          : {}),
        ...(typeof latestExperiment.patchArtifactPath === 'string'
          ? { patchArtifactPath: latestExperiment.patchArtifactPath }
          : {}),
        ...(typeof latestExperiment.error === 'string' ? { error: latestExperiment.error } : {}),
      }
    : undefined

  return {
    jobId: job.id,
    repoId: repo.id,
    type: job.type,
    success: !['fail'].includes(reviewReport.outcome),
    report,
    ...(experiment ? { experiment } : {}),
    review: reviewReport,
    summary: latestExperiment && !loopSummary
      ? `Loop completed through ${executionSurface} with review decision ${reviewReport.decision ?? reviewReport.outcome}.`
      : `Loop completed with ${loopSummary?.validated.length ?? 0} validated and ${loopSummary?.reverted.length ?? 0} reverted experiments.`,
  }
}

export function startWorkerStub(intervalMs = HEARTBEAT_INTERVAL_MS): NodeJS.Timeout {
  console.log(workerPackage.message)
  return setInterval(() => undefined, intervalMs)
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false
}

if (isDirectExecution()) {
  const timer = startWorkerStub()
  const shutdown = () => {
    clearInterval(timer)
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
