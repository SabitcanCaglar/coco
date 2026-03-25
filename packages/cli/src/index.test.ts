import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { simpleGit } from 'simple-git'
import { describe, expect, it } from 'vitest'

import { createDaemon } from '@coco/orchestrator'
import {
  cliPackage,
  getCLIStubMessage,
  loadEnvFile,
  renderCocoBanner,
  renderLaunchdPlist,
  runCLI,
  startCocoShell,
} from './index.js'

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
    expect(renderCocoBanner()).toContain('local-first maintainer runtime')
    expect(renderCocoBanner()).toContain('repo doctor · loop · review · patches')
    expect(renderCocoBanner()).toContain('\x1b[32m')
    expect(renderLaunchdPlist('dev.coco.daemon', '/tmp/coco', 4)).toContain('dev.coco.daemon')
    expect(renderLaunchdPlist('dev.coco.daemon', '/tmp/coco', 4)).toContain('daemon')
  })

  it('loads OPENROUTER settings from a local env file', async () => {
    const envDir = await mkdtemp(join(tmpdir(), 'coco-env-'))
    const envPath = join(envDir, '.env')
    const previousKey = process.env.OPENROUTER_API_KEY
    const previousModel = process.env.COCO_OPENROUTER_MODEL

    await writeFile(
      envPath,
      'OPENROUTER_API_KEY=test-openrouter-key\nCOCO_OPENROUTER_MODEL=minimax/minimax-m2.7\n',
    )

    try {
      process.env.OPENROUTER_API_KEY = undefined
      process.env.COCO_OPENROUTER_MODEL = undefined
      loadEnvFile(envPath)
      expect(process.env.OPENROUTER_API_KEY).toBe('test-openrouter-key')
      expect(process.env.COCO_OPENROUTER_MODEL).toBe('minimax/minimax-m2.7')
    } finally {
      process.env.OPENROUTER_API_KEY = previousKey
      process.env.COCO_OPENROUTER_MODEL = previousModel
      await rm(envDir, { recursive: true, force: true })
    }
  })

  it('uses the shared OpenClaw agent runtime from the CLI', async () => {
    const output: string[] = []
    const previousKey = process.env.OPENROUTER_API_KEY
    const previousModel = process.env.COCO_OPENROUTER_MODEL
    const previousEnvFile = process.env.COCO_ENV_FILE
    const envDir = await mkdtemp(join(tmpdir(), 'coco-agent-env-'))
    const envPath = join(envDir, '.env')
    await writeFile(envPath, '')

    process.env.COCO_DAEMON_URL = 'http://127.0.0.1:65530'
    process.env.OPENROUTER_API_KEY = ''
    process.env.COCO_OPENROUTER_MODEL = undefined
    process.env.COCO_ENV_FILE = envPath
    try {
      await expect(
        runCLI(['agent', 'ask', 'openclaw', 'kullan', '--session', 'test-agent', '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)

      const payload = JSON.parse(output.at(-1) ?? '{}') as {
        session?: string
        reply?: string
        sessionState?: { provider?: string }
      }
      expect(payload.session).toBe('test-agent')
      expect(payload.reply).toContain('Varsayilan provider artik openclaw')
      expect(payload.sessionState?.provider).toBe('openclaw')
    } finally {
      process.env.COCO_DAEMON_URL = undefined
      process.env.OPENROUTER_API_KEY = previousKey
      process.env.COCO_OPENROUTER_MODEL = previousModel
      process.env.COCO_ENV_FILE = previousEnvFile
      await rm(envDir, { recursive: true, force: true })
    }
  })

  it('renders the coco cat banner in help output', async () => {
    const output: string[] = []

    await expect(
      runCLI([], {
        write: (message) => output.push(message),
        error: (message) => output.push(`ERR:${message}`),
      }),
    ).resolves.toBe(0)

    const help = output.join('\n')
    expect(help).toContain('coco')
    expect(help).toContain('local-first maintainer runtime')
    expect(help).toContain('Usage:')
    expect(help).toContain('coco loop run <repo-or-path>')
  })

  it('runs an interactive shell session with shortcuts', async () => {
    const repoPath = await createFixtureRepo()
    const writes: string[] = []

    try {
      const session = startCocoShell({
        io: {
          write: (message) => writes.push(message),
          error: (message) => writes.push(`ERR:${message}`),
        },
        scriptedLines: ['help', `doctor "${repoPath}" --json`, 'exit'],
      })

      await expect(session).resolves.toBe(0)
      expect(writes.some((message) => message.includes('Interactive shell ready.'))).toBe(true)
      expect(writes.some((message) => message.includes('Shell commands:'))).toBe(true)
      expect(writes.some((message) => message.includes('"findings"'))).toBe(true)
      expect(writes.at(-1)).toBe('bye')
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
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
    let patchArtifactPath: string | undefined
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
        experiment?: { worktreePath?: string; branchName?: string; patchArtifactPath?: string }
      }
      const afterHead = (await git.revparse(['HEAD'])).trim()
      worktreePath = payload.experiment?.worktreePath
      patchArtifactPath = payload.experiment?.patchArtifactPath
      expect(payload.review?.outcome).toBe('needs-approval')
      expect(payload.experiment?.worktreePath).toBeDefined()
      expect(payload.experiment?.branchName).toBeDefined()
      expect(payload.experiment?.patchArtifactPath).toBeDefined()
      expect(beforeHead).toBe(afterHead)
    } finally {
      process.env.COCO_DAEMON_URL = undefined
      if (worktreePath) {
        await rm(worktreePath, { recursive: true, force: true })
      }
      if (patchArtifactPath) {
        await rm(patchArtifactPath, { force: true })
      }
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('applies a generated patch artifact back onto the repo', async () => {
    const repoPath = await createFixtureRepo()
    const output: string[] = []
    let worktreePath: string | undefined
    let patchArtifactPath: string | undefined

    try {
      process.env.COCO_DAEMON_URL = 'http://127.0.0.1:65530'
      await expect(
        runCLI(['loop', 'run', repoPath, '--rounds', '1', '--provider', 'null', '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)

      const loopPayload = JSON.parse(output.at(-1) ?? '{}') as {
        experiment?: { worktreePath?: string; patchArtifactPath?: string }
      }
      worktreePath = loopPayload.experiment?.worktreePath
      patchArtifactPath = loopPayload.experiment?.patchArtifactPath
      expect(patchArtifactPath).toBeDefined()

      output.length = 0
      await expect(
        runCLI(['apply', patchArtifactPath ?? '', repoPath, '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ applied: true, repoPath })

      const updatedSource = await readFile(join(repoPath, 'src', 'index.ts'), 'utf-8')
      expect(updatedSource.includes('console.log(')).toBe(false)
    } finally {
      process.env.COCO_DAEMON_URL = undefined
      if (worktreePath) {
        await rm(worktreePath, { recursive: true, force: true })
      }
      if (patchArtifactPath) {
        await rm(patchArtifactPath, { force: true })
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

  it('queues fanout loop jobs across multiple repos when the daemon is running', async () => {
    const repoOne = await createFixtureRepo()
    const repoTwo = await createFixtureRepo()
    const dataDir = await mkdtemp(join(tmpdir(), 'coco-cli-daemon-'))
    const output: string[] = []
    const daemon = createDaemon({
      port: 0,
      dataDir,
      maxConcurrentJobs: 2,
      workerRunner: async (job) => ({
        jobId: job.id,
        repoId: job.repoId,
        type: job.type,
        success: true,
        summary: `queued ${job.id}`,
      }),
    })

    try {
      await daemon.start()
      process.env.COCO_DAEMON_URL = daemon.url()

      await expect(
        runCLI(
          [
            'loop',
            'fanout',
            repoOne,
            repoTwo,
            '--provider',
            'openclaw',
            '--model',
            'moonshotai/kimi-k2',
            '--json',
          ],
          {
            write: (message) => output.push(message),
            error: (message) => output.push(`ERR:${message}`),
          },
        ),
      ).resolves.toBe(0)

      const payload = JSON.parse(output.at(-1) ?? '{}') as {
        count?: number
        provider?: string
        model?: string
        queued?: Array<{ repoPath: string }>
      }
      expect(payload.count).toBe(2)
      expect(payload.provider).toBe('openclaw')
      expect(payload.model).toBe('moonshotai/kimi-k2')
      expect(payload.queued?.map((item) => item.repoPath).sort()).toEqual([repoOne, repoTwo].sort())

      output.length = 0
      await expect(
        runCLI(['jobs', 'list', '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      const jobs = JSON.parse(output.at(-1) ?? '[]') as Array<{ job: { id: string } }>
      expect(jobs.length).toBeGreaterThanOrEqual(2)

      output.length = 0
      const firstJobId = jobs[0]?.job.id
      expect(firstJobId).toBeDefined()
      await expect(
        runCLI(['jobs', 'inspect', firstJobId ?? '', '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      expect(JSON.parse(output.at(-1) ?? '{}')).toHaveProperty('job.id')
    } finally {
      process.env.COCO_DAEMON_URL = undefined
      await daemon.stop()
      await rm(dataDir, { recursive: true, force: true })
      await rm(repoOne, { recursive: true, force: true })
      await rm(repoTwo, { recursive: true, force: true })
    }
  })

  it('lists, watches tasks and shows worker state from the daemon', async () => {
    const repoPath = await createFixtureRepo()
    const dataDir = await mkdtemp(join(tmpdir(), 'coco-cli-tasks-'))
    const output: string[] = []
    const daemon = createDaemon({
      port: 0,
      dataDir,
    })

    try {
      await daemon.start()
      process.env.COCO_DAEMON_URL = daemon.url()

      const repoResponse = await fetch(`${daemon.url()}/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: repoPath }),
      })
      const repo = (await repoResponse.json()) as { id: string }

      const taskResponse = await fetch(`${daemon.url()}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: 'Repo yapisini analiz et',
          mode: 'analyze',
          sessionId: 'cli-monitor-test',
          repoId: repo.id,
        }),
      })
      const createdTask = (await taskResponse.json()) as { id: string }

      await expect(
        runCLI(['tasks', '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      const tasks = JSON.parse(output.at(-1) ?? '[]') as Array<{
        id: string
        mode: string
        goal: string
      }>
      expect(tasks).toContainEqual(
        expect.objectContaining({
          id: createdTask.id,
          mode: 'analyze',
          goal: 'Repo yapisini analiz et',
        }),
      )

      output.length = 0
      await expect(
        runCLI(['watch', createdTask.id, '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      const watchedTask = JSON.parse(output.at(-1) ?? '{}') as {
        task?: { id: string; status: string; plan?: { steps?: Array<{ tool: string }> } }
        events?: Array<{ phase: string }>
      }
      expect(watchedTask.task?.id).toBe(createdTask.id)
      expect(watchedTask.task?.status).toBe('completed')
      expect(watchedTask.task?.plan?.steps?.some((step) => step.tool === 'run_loop_fix')).toBe(
        false,
      )
      expect(watchedTask.events?.some((event) => event.phase === 'doctor_inspect')).toBe(true)

      output.length = 0
      await expect(
        runCLI(['workers', '--json'], {
          write: (message) => output.push(message),
          error: (message) => output.push(`ERR:${message}`),
        }),
      ).resolves.toBe(0)
      const workers = JSON.parse(output.at(-1) ?? '[]') as Array<{
        id: string
        kind: string
        status: string
      }>
      expect(workers.length).toBeGreaterThan(0)
      expect(workers.every((worker) => worker.id.startsWith('worker-'))).toBe(true)
      expect(workers.every((worker) => ['idle', 'busy', 'offline'].includes(worker.status))).toBe(
        true,
      )
    } finally {
      process.env.COCO_DAEMON_URL = undefined
      await daemon.stop()
      await rm(dataDir, { recursive: true, force: true })
      await rm(repoPath, { recursive: true, force: true })
    }
  })
})
