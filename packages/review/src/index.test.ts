import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { simpleGit } from 'simple-git'
import { describe, expect, it } from 'vitest'

import { ReviewGate, listReviewPlugins, loadReviewCheckPlugins, reviewPackage } from './index.js'

async function createReviewRepo(testScript = 'node -e "process.exit(0)"'): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'coco-review-'))
  await writeFile(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'review-fixture',
        private: true,
        scripts: {
          test: testScript,
          build: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    ),
  )
  await writeFile(join(repoPath, 'index.js'), "console.log('hello')\n")
  const git = simpleGit(repoPath)
  await git.init()
  await git.addConfig('user.name', 'coco-test')
  await git.addConfig('user.email', 'coco@example.com')
  await git.add('.')
  await git.commit('initial commit')
  await writeFile(join(repoPath, 'index.js'), "console.log('changed')\n")
  return repoPath
}

describe('@coco/review', () => {
  it('exposes runtime metadata', () => {
    expect(reviewPackage.name).toBe('@coco/review')
    expect(reviewPackage.status).toBe('ready')
    expect(listReviewPlugins().length).toBeGreaterThan(0)
  })

  it('returns needs-approval when patch checks pass', async () => {
    const repoPath = await createReviewRepo()
    try {
      const report = await new ReviewGate().run({
        projectPath: repoPath,
        patchApplied: true,
      })
      expect(report.outcome).toBe('needs-approval')
      expect(report.results.some((result) => result.checkId === 'test')).toBe(true)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('keeps optional command failures in needs-approval when required checks pass', async () => {
    const repoPath = await createReviewRepo('node -e "process.exit(1)"')
    try {
      const report = await new ReviewGate().run({
        projectPath: repoPath,
        patchApplied: true,
      })
      expect(report.outcome).toBe('needs-approval')
      expect(report.violations.length).toBeGreaterThan(0)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('loads external review check plugins from file paths', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'coco-review-plugin-'))
    const pluginPath = join(pluginDir, 'review.mjs')
    await writeFile(
      pluginPath,
      `export const plugin = {
        manifest: {
          name: 'external-review-plugin',
          version: '0.1.0',
          kind: 'review-check',
          capabilities: ['review-policy']
        },
        check: {
          id: 'external-policy',
          name: 'External Policy',
          kind: 'policy',
          required: false,
          discover: () => null,
          run: () => ({ result: { checkId: 'external-policy', status: 'pass', summary: 'External policy passed.' } })
        }
      };`,
    )

    try {
      const plugins = await loadReviewCheckPlugins([pluginPath])
      expect(plugins).toHaveLength(1)
      expect(plugins[0]?.manifest.name).toBe('external-review-plugin')
    } finally {
      await rm(pluginDir, { recursive: true, force: true })
    }
  })
})
