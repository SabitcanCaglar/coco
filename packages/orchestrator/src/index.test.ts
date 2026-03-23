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
    })
    daemons.push(daemon)
    process.env.COCO_PLUGIN_PATHS = pluginDir
    await daemon.start()

    const address = daemon.server.address()
    expect(address).not.toBeNull()
    expect(typeof address).toBe('object')
    const port = typeof address === 'object' && address ? address.port : 0
    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`)
    expect(healthResponse.status).toBe(200)

    const repoResponse = await fetch(`http://127.0.0.1:${port}/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repoPath }),
    })
    const repo = (await repoResponse.json()) as { id: string; rootPath: string }
    expect(repo.rootPath).toBe(repoPath)

    const doctorResponse = await fetch(`http://127.0.0.1:${port}/jobs/doctor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: repo.id }),
    })
    const doctorJob = (await doctorResponse.json()) as { id: string }
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
    if (typeof worktreePath === 'string') {
      await rm(worktreePath, { recursive: true, force: true })
    }

    await rm(repoPath, { recursive: true, force: true })
    await rm(pluginDir, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
    process.env.COCO_PLUGIN_PATHS = undefined
  })
})

async function waitForJob(
  port: number,
  jobId: string,
): Promise<{
  job: { status: string }
  result?: {
    report?: { findings?: Array<{ title: string }> }
    experiment?: { worktreePath?: string }
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
