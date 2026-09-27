import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { simpleGit } from 'simple-git'
import { describe, expect, it } from 'vitest'

import type { Job, JobEvent, RepoRef } from '@coco/core'

import { resolveGitIdentity, runJob, workerPackage } from './index.js'

async function createFixtureRepo(): Promise<{ repo: RepoRef; cleanup(): Promise<void> }> {
  const repoPath = await mkdtemp(join(tmpdir(), 'coco-worker-'))
  await mkdir(join(repoPath, 'src'))
  await writeFile(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'worker-fixture',
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

  return {
    repo: {
      id: 'repo-1',
      rootPath: repoPath,
      defaultBranch: 'main',
      languageHints: ['ts', 'js'],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    cleanup: async () => rm(repoPath, { recursive: true, force: true }),
  }
}

describe('@coco/worker', () => {
  it('exposes worker runtime metadata', () => {
    expect(workerPackage.name).toBe('@coco/worker')
    expect(workerPackage.status).toBe('ready')
    expect(workerPackage.heartbeatIntervalMs).toBe(60_000)
  })

  it('runs a doctor job and returns a report', async () => {
    const fixture = await createFixtureRepo()
    const events: Omit<JobEvent, 'id' | 'timestamp'>[] = []
    const job: Job = {
      id: 'job-1',
      type: 'doctor',
      repoId: fixture.repo.id,
      requestedAt: new Date().toISOString(),
      status: 'queued',
      payload: {},
    }
    try {
      const result = await runJob(job, {
        getRepo: async () => fixture.repo,
        appendEvent: async (event) => {
          events.push(event)
        },
      })

      expect(result.success).toBe(true)
      expect(result.report?.findings.length).toBeGreaterThan(0)
      expect(events.length).toBeGreaterThan(0)
    } finally {
      await fixture.cleanup()
    }
  })

  it('runs a loop job and returns experiment plus review results', async () => {
    const fixture = await createFixtureRepo()
    const git = simpleGit(fixture.repo.rootPath)
    let worktreePath: string | undefined
    let patchArtifactPath: string | undefined
    const job: Job = {
      id: 'job-2',
      type: 'loop',
      repoId: fixture.repo.id,
      requestedAt: new Date().toISOString(),
      status: 'queued',
      payload: {
        rounds: 1,
        provider: 'null',
      },
    }
    try {
      const beforeHead = (await git.revparse(['HEAD'])).trim()
      const result = await runJob(job, {
        getRepo: async () => fixture.repo,
        appendEvent: async () => undefined,
      })
      const afterHead = (await git.revparse(['HEAD'])).trim()

      expect(result.review).toBeDefined()
      expect(result.review?.outcome).toBe('needs-approval')
      expect(result.review?.decision).toBe('needs-human-approval')
      expect(result.experiment?.worktreePath).toBeDefined()
      expect(result.experiment?.branchName).toBeDefined()
      expect(result.experiment?.patchArtifactPath).toBeDefined()
      worktreePath = result.experiment?.worktreePath
      patchArtifactPath = result.experiment?.patchArtifactPath
      expect(beforeHead).toBe(afterHead)
      expect(result.summary).toContain('Loop completed')
    } finally {
      if (worktreePath) {
        await rm(worktreePath, { recursive: true, force: true })
      }
      if (patchArtifactPath) {
        await rm(patchArtifactPath, { force: true })
      }
      await fixture.cleanup()
    }
  })

  it('falls back to the existing loop when aider is unavailable', async () => {
    const fixture = await createFixtureRepo()
    const job: Job = {
      id: 'job-3',
      type: 'loop',
      repoId: fixture.repo.id,
      requestedAt: new Date().toISOString(),
      status: 'queued',
      payload: {
        rounds: 1,
        provider: 'null',
        executionSurface: 'aider',
      },
    }
    try {
      const result = await runJob(job, {
        getRepo: async () => fixture.repo,
        appendEvent: async () => undefined,
      })
      expect(result.review?.decision).toBeDefined()
      expect(result.experiment?.branchName).toBeDefined()
    } finally {
      await fixture.cleanup()
    }
  })

  it('bootstraps git identity from the latest commit when repo config is missing', async () => {
    const fixture = await createFixtureRepo()
    const git = simpleGit(fixture.repo.rootPath)
    try {
      await git.raw(['config', '--unset', 'user.name']).catch(() => undefined)
      await git.raw(['config', '--unset', 'user.email']).catch(() => undefined)

      const identity = await resolveGitIdentity(fixture.repo.rootPath)

      expect(identity.name.length).toBeGreaterThan(0)
      expect(identity.email.length).toBeGreaterThan(0)
      expect((await git.raw(['config', '--get', 'user.name'])).trim()).toBe(identity.name)
      expect((await git.raw(['config', '--get', 'user.email'])).trim()).toBe(identity.email)
    } finally {
      await fixture.cleanup()
    }
  })
})
