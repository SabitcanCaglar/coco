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

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

describe('@coco/orchestrator', () => {
  it('serves health, registers repos, and runs queued jobs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'coco-orchestrator-data-'))
    const repoPath = await createFixtureRepo()
    const daemon = createDaemon({
      port: 0,
      dataDir,
    })
    daemons.push(daemon)
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

    const loopResponse = await fetch(`http://127.0.0.1:${port}/jobs/loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: repo.id, rounds: 1, provider: 'null' }),
    })
    const loopJob = (await loopResponse.json()) as { id: string }
    const completedLoop = await waitForJob(port, loopJob.id)
    expect(['completed', 'failed']).toContain(completedLoop.job.status)

    await rm(repoPath, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })
})

async function waitForJob(
  port: number,
  jobId: string,
): Promise<{ job: { status: string }; result?: Record<string, unknown> }> {
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
