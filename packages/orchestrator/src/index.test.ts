import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { simpleGit } from 'simple-git'
import { afterEach, describe, expect, it } from 'vitest'

import { createDaemon } from './index.js'

const daemons: Array<ReturnType<typeof createDaemon>> = []

async function createFixtureRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'coco-orchestrator-repo-'))
  await mkdir(join(repoPath, 'src'))
  await writeFile(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'orchestrator-fixture',
        private: true,
        scripts: {
          test: 'node -e "process.exit(0)"',
          build: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    ),
  )
  await writeFile(join(repoPath, '.gitignore'), 'node_modules\ndist\n.env\n')
  await writeFile(
    join(repoPath, 'src', 'index.ts'),
    "console.log('debug')\nexport const value = 1\n",
  )
  const git = simpleGit(repoPath)
  await git.init()
  await git.addConfig('user.name', 'coco-test')
  await git.addConfig('user.email', 'coco@example.com')
  await git.add('.')
  await git.commit('initial commit')
  return repoPath
}

async function createPluginDirectory(): Promise<string> {
  const pluginDir = await mkdtemp(join(tmpdir(), 'coco-orchestrator-plugins-'))
  await writeFile(
    join(pluginDir, 'doctor-plugin.mjs'),
    `export const plugin = {
      manifest: {
        name: 'external-daemon-doctor-plugin',
        version: '0.1.0',
        kind: 'framework-expert',
        capabilities: ['doctor-findings']
      },
      expert: {
        framework: 'daemon-external',
        name: 'Daemon External Expert',
        detect: () => true,
        find: () => [{
          id: 'daemon-external-finding',
          phase: 'diagnosis',
          title: 'Daemon external finding',
          summary: 'Loaded from daemon plugin directory',
          severity: 'low',
          tags: ['external'],
          evidence: [],
          targetFiles: []
        }],
        prescribe: () => []
      }
    };`,
  )
  return pluginDir
}

afterEach(async () => {
  process.env.COCO_PLUGIN_PATHS = undefined
  process.env.COCO_BIND_HOST = undefined
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

describe('@coco/orchestrator', () => {
  it('serves health, registers repos, and runs queued jobs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coco-orchestrator-data-'))
    const repoPath = await createFixtureRepo()
    const pluginDir = await createPluginDirectory()
    const daemon = createDaemon({
      port: 0,
      dataDir,
      pluginPaths: [pluginDir],
    })
    daemons.push(daemon)
    await daemon.start()

    const address = daemon.server.address()
    expect(address).not.toBeNull()
    expect(typeof address).toBe('object')
    const port = typeof address === 'object' && address ? address.port : 0
    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`)
    expect(healthResponse.status).toBe(200)
    const healthPayload = (await healthResponse.json()) as {
      status: string
      package: string
      queuedJobs: number
      activeJobs: number
    }
    expect(healthPayload.status).toBe('ok')
    expect(healthPayload.package).toBe('@coco/orchestrator')
    expect(typeof healthPayload.queuedJobs).toBe('number')
    expect(typeof healthPayload.activeJobs).toBe('number')

    const repoResponse = await fetch(`http://127.0.0.1:${port}/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repoPath }),
    })
    const repo = (await repoResponse.json()) as { id: string; rootPath: string }
    expect(repo.rootPath).toBe(repoPath)
    const reposListResponse = await fetch(`http://127.0.0.1:${port}/repos`)
    const reposList = (await reposListResponse.json()) as Array<{ id: string }>
    expect(reposList.some((entry) => entry.id === repo.id)).toBe(true)

    const doctorResponse = await fetch(`http://127.0.0.1:${port}/jobs/doctor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: repo.id }),
    })
    const doctorJob = (await doctorResponse.json()) as { id: string }
    const jobsListResponse = await fetch(`http://127.0.0.1:${port}/jobs`)
    const jobsList = (await jobsListResponse.json()) as Array<{ job: { id: string } }>
    expect(jobsList.some((entry) => entry.job.id === doctorJob.id)).toBe(true)
    const completedDoctor = await waitForJob(port, doctorJob.id)
    expect(completedDoctor.job.status).toBe('completed')
    expect(
      completedDoctor.result?.report?.findings?.some(
        (finding) => finding.title === 'Daemon external finding',
      ),
    ).toBe(true)

    const loopResponse = await fetch(`http://127.0.0.1:${port}/jobs/loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: repo.id, rounds: 1, provider: 'null' }),
    })
    const loopJob = (await loopResponse.json()) as { id: string }
    const completedLoop = await waitForJob(port, loopJob.id)
    expect(['completed', 'failed']).toContain(completedLoop.job.status)
    const worktreePath = completedLoop.result?.experiment?.worktreePath
    const patchArtifactPath = completedLoop.result?.experiment?.patchArtifactPath
    if (typeof worktreePath === 'string') {
      await rm(worktreePath, { recursive: true, force: true })
    }
    if (typeof patchArtifactPath === 'string') {
      await rm(patchArtifactPath, { force: true })
    }

    await rm(repoPath, { recursive: true, force: true })
    await rm(pluginDir, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })

  it('runs multiple queued jobs in parallel when configured', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coco-orchestrator-parallel-'))
    const repoOne = await createFixtureRepo()
    const repoTwo = await createFixtureRepo()
    const started: string[] = []
    const daemon = createDaemon({
      port: 0,
      dataDir,
      maxConcurrentJobs: 2,
      workerRunner: async (job) => {
        started.push(job.id)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
        return {
          jobId: job.id,
          repoId: job.repoId,
          type: job.type,
          success: true,
          summary: `completed ${job.id}`,
        }
      },
    })
    daemons.push(daemon)
    await daemon.start()

    const address = daemon.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const repoResponseOne = await fetch(`http://127.0.0.1:${port}/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repoOne }),
    })
    const repoResponseTwo = await fetch(`http://127.0.0.1:${port}/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repoTwo }),
    })
    const repoOneRecord = (await repoResponseOne.json()) as { id: string }
    const repoTwoRecord = (await repoResponseTwo.json()) as { id: string }

    const startedAt = Date.now()
    const jobResponseOne = await fetch(`http://127.0.0.1:${port}/jobs/loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: repoOneRecord.id, rounds: 1, provider: 'null' }),
    })
    const jobResponseTwo = await fetch(`http://127.0.0.1:${port}/jobs/loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: repoTwoRecord.id, rounds: 1, provider: 'null' }),
    })
    const jobOne = (await jobResponseOne.json()) as { id: string }
    const jobTwo = (await jobResponseTwo.json()) as { id: string }

    await Promise.all([waitForJob(port, jobOne.id), waitForJob(port, jobTwo.id)])
    const durationMs = Date.now() - startedAt
    expect(started).toHaveLength(2)
    expect(durationMs).toBeLessThan(450)

    await rm(repoOne, { recursive: true, force: true })
    await rm(repoTwo, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })

  it('lists and controls docker containers through the daemon API', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coco-orchestrator-docker-'))
    const daemon = createDaemon({
      port: 0,
      dataDir,
      dockerExec: async (args) => {
        if (args[0] === 'ps') {
          return [
            JSON.stringify({
              ID: 'abc123',
              Names: 'postgres-dev',
              Image: 'postgres:16',
              State: 'running',
              Status: 'Up 2 minutes',
            }),
          ].join('\n')
        }
        if (args[0] === 'restart' && args[1] === 'postgres-dev') {
          return 'postgres-dev'
        }
        throw new Error(`unexpected docker args: ${args.join(' ')}`)
      },
    })
    daemons.push(daemon)
    await daemon.start()

    const address = daemon.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const listResponse = await fetch(`http://127.0.0.1:${port}/docker/containers`)
    expect(listResponse.status).toBe(200)
    const containers = (await listResponse.json()) as Array<{ name: string; state: string }>
    expect(containers[0]).toMatchObject({
      name: 'postgres-dev',
      state: 'running',
    })

    const restartResponse = await fetch(`http://127.0.0.1:${port}/docker/containers/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idOrName: 'postgres-dev' }),
    })
    expect(restartResponse.status).toBe(202)
    const restartBody = (await restartResponse.json()) as { action: string; target: string }
    expect(restartBody).toMatchObject({
      action: 'restart',
      target: 'postgres-dev',
    })

    await rm(dataDir, { recursive: true, force: true })
  })

  it('creates analyze tasks with monitoring data and no loop step', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coco-orchestrator-tasks-'))
    const repoPath = await createFixtureRepo()
    const daemon = createDaemon({
      port: 0,
      dataDir,
    })
    daemons.push(daemon)
    await daemon.start()

    const address = daemon.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const repoResponse = await fetch(`http://127.0.0.1:${port}/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repoPath }),
    })
    const repo = (await repoResponse.json()) as { id: string }

    const taskResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: 'Repo yapisini analiz et',
        mode: 'analyze',
        sessionId: 'monitor-test',
        repoId: repo.id,
      }),
    })
    expect(taskResponse.status).toBe(202)
    const task = (await taskResponse.json()) as { id: string; mode: string; status: string }
    expect(task.mode).toBe('analyze')

    const completedTask = await waitForTask(port, task.id)
    expect(completedTask.task.status).toBe('completed')
    expect(completedTask.task.plan.steps.some((step) => step.tool === 'run_loop_fix')).toBe(false)
    expect(completedTask.task.plan.steps.map((step) => step.tool)).toEqual([
      'inspect_git_state',
      'doctor_inspect',
    ])
    expect(completedTask.task.latestSummary).toContain('Doctor completed')

    const workersResponse = await fetch(`http://127.0.0.1:${port}/workers`)
    expect(workersResponse.status).toBe(200)
    const workers = (await workersResponse.json()) as Array<{
      id: string
      kind: string
      status: string
      lastHeartbeat: string
    }>
    expect(workers.length).toBeGreaterThan(0)
    expect(workers.every((worker) => worker.id.startsWith('worker-'))).toBe(true)
    expect(workers.every((worker) => ['idle', 'busy', 'offline'].includes(worker.status))).toBe(
      true,
    )
    expect(workers.every((worker) => typeof worker.lastHeartbeat === 'string')).toBe(true)

    const sessionsResponse = await fetch(`http://127.0.0.1:${port}/sessions`)
    expect(sessionsResponse.status).toBe(200)
    const sessions = (await sessionsResponse.json()) as Array<{ id: string; taskCount: number }>
    expect(sessions).toContainEqual(
      expect.objectContaining({
        id: 'monitor-test',
        taskCount: 1,
      }),
    )

    const eventsResponse = await fetch(`http://127.0.0.1:${port}/tasks/${task.id}/events`)
    expect(eventsResponse.status).toBe(200)
    const events = (await eventsResponse.json()) as Array<{ phase: string; message: string }>
    expect(events.some((event) => event.phase === 'inspect_git_state')).toBe(true)
    expect(events.some((event) => event.phase === 'doctor_inspect')).toBe(true)
    expect(events.some((event) => event.phase === 'replanned')).toBe(true)

    await rm(repoPath, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })

  it('uses an externally reachable bind host when COCO_BIND_HOST is set', async () => {
    process.env.COCO_BIND_HOST = '0.0.0.0'
    const dataDir = await mkdtemp(join(tmpdir(), 'coco-orchestrator-bind-'))
    const daemon = createDaemon({
      port: 0,
      dataDir,
    })

    expect(daemon.config.host).toBe('0.0.0.0')
    await rm(dataDir, { recursive: true, force: true })
  })
})

async function waitForJob(
  port: number,
  jobId: string,
): Promise<{
  job: { status: string }
  result?: {
    report?: { findings?: Array<{ title: string }> }
    experiment?: { worktreePath?: string; patchArtifactPath?: string }
  }
}> {
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}`)
    const payload = (await response.json()) as {
      job: { status: string }
      result?: Record<string, unknown>
    }
    if (['completed', 'failed'].includes(payload.job.status)) {
      return payload
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
}

async function waitForTask(
  port: number,
  taskId: string,
): Promise<{
  task: {
    status: string
    latestSummary?: string
    plan: { steps: Array<{ tool: string }> }
  }
}> {
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/tasks/${taskId}`)
    const payload = (await response.json()) as {
      task: {
        status: string
        latestSummary?: string
        plan: { steps: Array<{ tool: string }> }
      }
    }
    if (['completed', 'failed', 'blocked', 'canceled'].includes(payload.task.status)) {
      return payload
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
}
