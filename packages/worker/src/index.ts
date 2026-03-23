import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Job, JobEvent, JobResult, RepoRef } from '@coco/core'
import { DoctorRuntime } from '@coco/doctor'
import { LLMRegistry } from '@coco/llm'
import { runKarpathyLoop } from '@coco/loop'
import { ReviewGate } from '@coco/review'

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
    case 'null':
      return 'deterministic'
    default:
      return 'auto'
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

export async function runJob(job: Job, services: WorkerServices): Promise<JobResult> {
  const repo = await services.getRepo(job.repoId)
  const pluginPaths = getConfiguredPluginPaths()
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
  const report = await doctor.examine(repo)
  const selection: { provider?: string; model?: string } = {}
  if ('provider' in job.payload && job.payload.provider) {
    selection.provider = job.payload.provider
  }
  if ('model' in job.payload && job.payload.model) {
    selection.model = job.payload.model
  }
  const resolution = await llm.resolve(selection)
  await emit(services, job.id, 'loop', 'Running Karpathy Loop experiment.', 'info', {
    provider: resolution.provider,
    model: resolution.model,
  })
  const loopSummary = await runKarpathyLoop({
    projectPath: repo.rootPath,
    rounds: 1,
    dryRun: 'dryRun' in job.payload ? Boolean(job.payload.dryRun) : false,
    verbose: false,
    mode: toLoopMode(resolution.provider),
    model: resolution.model,
    ollamaUrl: 'http://127.0.0.1:11434',
    mergeValidated: false,
  })
  const latestExperiment = loopSummary.results.at(-1)
  const reviewPath =
    latestExperiment?.status === 'validated' && latestExperiment.worktreePath
      ? latestExperiment.worktreePath
      : repo.rootPath
  const reviewReport = await review.run({
    projectPath: reviewPath,
    patchApplied: loopSummary.validated.length > 0,
  })
  await emit(services, job.id, 'review', 'Review gate completed.', 'info', {
    outcome: reviewReport.outcome,
  })

  const experiment = latestExperiment
    ? {
        hypothesisId: latestExperiment.hypothesisId,
        hypothesis: latestExperiment.hypothesis,
        beforeScore: latestExperiment.beforeScore,
        afterScore: latestExperiment.afterScore,
        delta: latestExperiment.delta,
        testsPassed: latestExperiment.testsPassed,
        status: latestExperiment.status,
        durationMs: latestExperiment.duration,
        ...(latestExperiment.commitHash ? { commitHash: latestExperiment.commitHash } : {}),
        ...(latestExperiment.branchName ? { branchName: latestExperiment.branchName } : {}),
        ...(latestExperiment.worktreePath ? { worktreePath: latestExperiment.worktreePath } : {}),
        ...(latestExperiment.error ? { error: latestExperiment.error } : {}),
      }
    : undefined

  return {
    jobId: job.id,
    repoId: repo.id,
    type: job.type,
    success: reviewReport.outcome !== 'fail',
    report,
    ...(experiment ? { experiment } : {}),
    review: reviewReport,
    summary: `Loop completed with ${loopSummary.validated.length} validated and ${loopSummary.reverted.length} reverted experiments.`,
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
