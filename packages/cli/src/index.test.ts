import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { simpleGit } from 'simple-git'
import { describe, expect, it } from 'vitest'

import { cliPackage, getCLIStubMessage, runCLI } from './index.js'

async function createFixtureRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'coco-cli-'))
  await mkdir(join(repoPath, 'src'))
  await writeFile(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'cli-fixture',
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
    "console.log('debug')\n// TODO: remove\nexport const value = 1\n",
  )
  const git = simpleGit(repoPath)
  await git.init()
  await git.addConfig('user.name', 'coco-test')
  await git.addConfig('user.email', 'coco@example.com')
  await git.add('.')
  await git.commit('initial commit')
  return repoPath
}

describe('@coco/cli', () => {
  it('exposes the CLI runtime message', () => {
    expect(cliPackage.name).toBe('@coco/cli')
    expect(getCLIStubMessage()).toContain('local-first')
  })

  it('supports repo add and doctor run in fallback mode with json output', async () => {
    const repoPath = await createFixtureRepo()
    const output: string[] = []
    try {
      process.env.COCO_DAEMON_URL = 'http://127.0.0.1:65530'
      await expect(
        runCLI(['repo', 'add', repoPath, '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ rootPath: repoPath })

      output.length = 0
      await expect(
        runCLI(['doctor', 'run', repoPath, '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      expect(JSON.parse(output.at(-1) ?? '{}')).toHaveProperty('findings')
    } finally {
      process.env.COCO_DAEMON_URL = undefined
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('supports loop run in fallback mode with json output', async () => {
    const repoPath = await createFixtureRepo()
    const output: string[] = []
    try {
      process.env.COCO_DAEMON_URL = 'http://127.0.0.1:65530'
      await expect(
        runCLI(['loop', 'run', repoPath, '--rounds', '1', '--provider', 'null', '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      expect(JSON.parse(output.at(-1) ?? '{}')).toHaveProperty('results')
    } finally {
      process.env.COCO_DAEMON_URL = undefined
      await rm(repoPath, { recursive: true, force: true })
    }
  })
})
