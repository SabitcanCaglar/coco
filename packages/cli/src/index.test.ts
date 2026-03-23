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

async function createPluginDirectory(): Promise<string> {
  const pluginDir = await mkdtemp(join(tmpdir(), 'coco-cli-plugins-'))
  await writeFile(
    join(pluginDir, 'doctor-plugin.mjs'),
    `export const plugin = {
      manifest: {
        name: 'external-doctor-plugin',
        version: '0.1.0',
        kind: 'framework-expert',
        capabilities: ['doctor-findings']
      },
      expert: {
        framework: 'external',
        name: 'External Expert',
        detect: () => true,
        find: () => [{
          id: 'external-finding',
          phase: 'diagnosis',
          title: 'External finding',
          summary: 'Loaded from plugin directory',
          severity: 'low',
          tags: ['external'],
          evidence: [],
          targetFiles: []
        }],
        prescribe: () => []
      }
    };`,
  )
  await writeFile(
    join(pluginDir, 'review-plugin.mjs'),
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
  await writeFile(
    join(pluginDir, 'llm-plugin.mjs'),
    `export const plugin = {
      manifest: {
        name: 'external-llm-plugin',
        version: '0.1.0',
        kind: 'llm-provider',
        capabilities: ['llm-generate']
      },
      provider: {
        name: 'external-llm',
        models: [{ provider: 'external-llm', name: 'mock-1', family: 'mock', supportsJson: true, supportsTools: false }],
        async generate() {
          return { model: this.models[0], content: 'ok', finishReason: 'stop' };
        }
      }
    };`,
  )
  return pluginDir
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
    const git = simpleGit(repoPath)
    let worktreePath: string | undefined
    try {
      process.env.COCO_DAEMON_URL = 'http://127.0.0.1:65530'
      const beforeHead = (await git.revparse(['HEAD'])).trim()
      await expect(
        runCLI(['loop', 'run', repoPath, '--rounds', '1', '--provider', 'null', '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      const payload = JSON.parse(output.at(-1) ?? '{}') as {
        review?: { outcome?: string }
        experiment?: { worktreePath?: string; branchName?: string }
      }
      const afterHead = (await git.revparse(['HEAD'])).trim()
      worktreePath = payload.experiment?.worktreePath
      expect(payload.review?.outcome).toBe('needs-approval')
      expect(payload.experiment?.worktreePath).toBeDefined()
      expect(payload.experiment?.branchName).toBeDefined()
      expect(beforeHead).toBe(afterHead)
    } finally {
      process.env.COCO_DAEMON_URL = undefined
      if (worktreePath) {
        await rm(worktreePath, { recursive: true, force: true })
      }
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('lists and inspects built-in plugins', async () => {
    const output: string[] = []

    await expect(
      runCLI(['plugins', 'list', '--json'], {
        write: (message) => output.push(message),
        error: (message) => output.push(`ERR:${message}`),
      }),
    ).resolves.toBe(0)
    const plugins = JSON.parse(output.at(-1) ?? '[]') as Array<{ name: string }>
    expect(plugins.some((plugin) => plugin.name === '@coco/provider-null')).toBe(true)

    output.length = 0
    await expect(
      runCLI(['plugins', 'inspect', '@coco/provider-null', '--json'], {
        write: (message) => output.push(message),
        error: (message) => output.push(`ERR:${message}`),
      }),
    ).resolves.toBe(0)
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ name: '@coco/provider-null' })
  })

  it('loads external plugins from a plugin directory end to end', async () => {
    const repoPath = await createFixtureRepo()
    const pluginDir = await createPluginDirectory()
    const output: string[] = []

    try {
      process.env.COCO_DAEMON_URL = 'http://127.0.0.1:65530'
      process.env.COCO_PLUGIN_PATHS = pluginDir

      await expect(
        runCLI(['plugins', 'list', '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      const plugins = JSON.parse(output.at(-1) ?? '[]') as Array<{ name: string }>
      expect(plugins.some((plugin) => plugin.name === 'external-doctor-plugin')).toBe(true)
      expect(plugins.some((plugin) => plugin.name === 'external-review-plugin')).toBe(true)
      expect(plugins.some((plugin) => plugin.name === 'external-llm-plugin')).toBe(true)

      output.length = 0
      await expect(
        runCLI(['doctor', 'run', repoPath, '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      const report = JSON.parse(output.at(-1) ?? '{}') as { findings?: Array<{ title: string }> }
      expect(report.findings?.some((finding) => finding.title === 'External finding')).toBe(true)
    } finally {
      process.env.COCO_DAEMON_URL = undefined
      process.env.COCO_PLUGIN_PATHS = undefined
      await rm(pluginDir, { recursive: true, force: true })
      await rm(repoPath, { recursive: true, force: true })
    }
  })
})
