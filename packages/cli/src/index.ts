#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'

import type { RepoRef, Task, WorkerInfo } from '@coco/core'
import { DoctorRuntime } from '@coco/doctor'
import { runKarpathyLoop } from '@coco/loop'
import type { SupervisorSessionState } from '@coco/openclaw-supervisor'
import { createSupervisor } from '@coco/openclaw-supervisor'
import { ReviewGate } from '@coco/review'
import { simpleGit } from 'simple-git'

export const cliPackage = {
  name: '@coco/cli',
  status: 'ready',
  message:
    'CLI for local-first repository registration, doctor runs, loop runs, review runs, and daemon startup.',
} as const

export interface CLIIO {
  write(message: string): void
  error(message: string): void
}

const defaultIO: CLIIO = {
  write: (message) => console.log(message),
  error: (message) => console.error(message),
}

export function getCLIStubMessage(): string {
  return cliPackage.message
}

export function renderCocoBanner(): string {
  const reset = '\x1b[0m'
  const green = '\x1b[32m'
  const brightGreen = '\x1b[92m'
  const dim = '\x1b[90m'
  const bold = '\x1b[1m'
  const white = '\x1b[37m'

  return [
    `${dim}    /\\_/\\\\${reset}  ${bold}${white}coco${reset}`,
    `${dim}   / ${reset}${green}o${reset}${brightGreen}o${reset}${dim} \\\\${reset}  local-first maintainer runtime`,
    `${dim}  (   ${white}^${reset}${dim}   )${reset}  repo doctor · loop · review · patches`,
    `${dim}   \\_${white}___${reset}${dim}_/${reset}`,
  ].join('\n')
}

function renderUsage(): string {
  return `${renderCocoBanner()}

Usage:
coco repo add <path> [--json]
coco agent ask <message> [--session NAME] [--json]
coco apply <patch-file> [repo-path] [--json]
coco doctor run <repo-or-path> [--json]
coco tasks [--json]
coco task inspect <task-id> [--json]
coco workers [--json]
coco watch <task-id> [--json]
coco plugins list [--json]
coco plugins inspect <name> [--json]
coco loop run <repo-or-path> [--rounds N] [--provider null|ollama|openrouter|openclaw] [--model NAME] [--json]
coco loop fanout <repo-path...> [--rounds N] [--provider null|ollama|openrouter|openclaw] [--model NAME] [--json]
coco loop inspect <repo-path> [--rounds N] [--provider null|ollama|openrouter|openclaw] [--model NAME] [--json]
coco review run <repo-path> [--json]
coco jobs list [--json]
coco jobs inspect <job-id> [--json]
coco daemon print-launchd [--parallel N] [--label LABEL]
coco daemon install-launchd [--parallel N] [--label LABEL]
coco daemon start [--parallel N]`
}

function renderShellHelp(): string {
  return `Shell commands:
help                     Show shell help
clear                    Clear the terminal and redraw the header
exit                     Close the coco shell

Shortcuts:
repo <path>              Expand to: repo add <path>
doctor <path>            Expand to: doctor run <path>
loop <path>              Expand to: loop run <path>
review <path>            Expand to: review run <path>
plugins                  Expand to: plugins list
jobs                     Expand to: jobs list

Tip:
Paths with spaces can be quoted, for example:
doctor "/Users/name/My Repo"`
}

function renderShellWelcome(): string {
  return `${renderCocoBanner()}

Interactive shell ready.
Type ${'\x1b[1m'}help${'\x1b[0m'} for shortcuts, or run repo/doctor/loop/review commands directly.`
}

function getDaemonUrl(): string {
  return process.env.COCO_DAEMON_URL ?? 'http://127.0.0.1:3000'
}

async function loadCreateDaemon(): Promise<typeof import('@coco/orchestrator')['createDaemon']> {
  const orchestrator = await import('@coco/orchestrator')
  return orchestrator.createDaemon
}

async function loadRunJob(): Promise<typeof import('@coco/worker')['runJob']> {
  const worker = await import('@coco/worker')
  return worker.runJob
}

async function loadPluginViews(): Promise<{
  doctor: typeof import('@coco/doctor')
  review: typeof import('@coco/review')
  llm: typeof import('@coco/llm')
}> {
  const [doctor, review, llm] = await Promise.all([
    import('@coco/doctor'),
    import('@coco/review'),
    import('@coco/llm'),
  ])
  return { doctor, review, llm }
}

function now(): string {
  return new Date().toISOString()
}

export function loadEnvFile(envPathArg?: string): void {
  const envPath = resolve(envPathArg ?? process.env.COCO_ENV_FILE ?? '.env')
  if (!existsSync(envPath)) {
    return
  }

  const content = readFileSync(envPath, 'utf-8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }
    const key = line.slice(0, separatorIndex).trim()
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (
      process.env[key] === undefined ||
      process.env[key] === '' ||
      process.env[key] === 'undefined'
    ) {
      process.env[key] = value
    }
  }
}

function getPluginPaths(): string[] {
  return (process.env.COCO_PLUGIN_PATHS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function getSharedStateRoot(): string {
  return process.env.COCO_HOME ?? resolve(homedir(), '.local', 'share', 'coco')
}

function loadAgentSessions(): SupervisorSessionState {
  const path = resolve(getSharedStateRoot(), 'agent-cli', 'sessions.json')
  if (!existsSync(path)) {
    return {}
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as SupervisorSessionState
}

function saveAgentSessions(sessions: SupervisorSessionState): void {
  const dir = resolve(getSharedStateRoot(), 'agent-cli')
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'sessions.json'), JSON.stringify(sessions, null, 2), 'utf-8')
}

async function detectLocalRepo(repoArg: string): Promise<RepoRef> {
  const rootPath = resolve(repoArg)
  if (!existsSync(rootPath)) {
    throw new Error(`Repository path not found: ${repoArg}`)
  }

  const git = simpleGit(rootPath)
  const defaultBranch =
    (await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => 'main')).trim() || 'main'
  const languageHints = [
    existsSync(resolve(rootPath, 'package.json')) ? 'js' : null,
    existsSync(resolve(rootPath, 'tsconfig.json')) ? 'ts' : null,
    existsSync(resolve(rootPath, 'Dockerfile')) ? 'docker' : null,
  ].filter((hint): hint is string => Boolean(hint))

  return {
    id: randomUUID(),
    rootPath,
    defaultBranch,
    languageHints,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
  }
}

async function daemonRequest(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    const response = await fetch(`${getDaemonUrl()}${path}`, init)
    return response
  } catch {
    return null
  }
}

async function ensureRepo(repoArg: string): Promise<{ id: string; rootPath: string }> {
  const reposResponse = await daemonRequest('/repos')
  if (reposResponse?.ok) {
    const repos = (await reposResponse.json()) as Array<{ id: string; rootPath: string }>
    const existing = repos.find((repo) => repo.id === repoArg || repo.rootPath === resolve(repoArg))
    if (existing) {
      return existing
    }
  }

  if (!existsSync(resolve(repoArg))) {
    throw new Error(`Repository path not found: ${repoArg}`)
  }

  const registerResponse = await daemonRequest('/repos', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      path: resolve(repoArg),
    }),
  })

  if (!registerResponse?.ok) {
    const repo = await detectLocalRepo(repoArg)
    return {
      id: repo.id,
      rootPath: repo.rootPath,
    }
  }

  return (await registerResponse.json()) as { id: string; rootPath: string }
}

async function waitForJob(jobId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const response = await daemonRequest(`/jobs/${jobId}`)
    if (!response?.ok) {
      throw new Error(`Unable to fetch job ${jobId}.`)
    }
    const payload = (await response.json()) as Record<string, unknown>
    const job = payload.job as { status: string }
    if (['completed', 'failed'].includes(job.status)) {
      return payload
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
}

async function waitForTask(taskId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const response = await daemonRequest(`/tasks/${taskId}`)
    if (!response?.ok) {
      throw new Error(`Unable to fetch task ${taskId}.`)
    }
    const payload = (await response.json()) as { task: Task }
    if (['completed', 'failed', 'blocked', 'canceled'].includes(payload.task.status)) {
      return payload as unknown as Record<string, unknown>
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
}

function parseFlag(args: string[], flag: string, fallback?: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}

function removeFlagValues(args: string[], flags: string[]): string[] {
  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--json') {
      continue
    }
    if (flags.includes(value ?? '')) {
      index += 1
      continue
    }
    filtered.push(String(value))
  }
  return filtered
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function printOutput(io: CLIIO, jsonMode: boolean, payload: unknown, human: string): void {
  io.write(jsonMode ? JSON.stringify(payload, null, 2) : human)
}

function isInteractiveTerminal(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): boolean {
  return Boolean(input.isTTY && output.isTTY)
}

function tokenizeInput(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    token.replace(/^['"]|['"]$/g, ''),
  )
}

function expandShellCommand(tokens: string[]): string[] {
  const [group, ...rest] = tokens
  if (!group) {
    return []
  }

  if (group === 'repo' && rest.length > 0 && rest[0] !== 'add') {
    return ['repo', 'add', ...rest]
  }
  if (group === 'doctor' && rest.length > 0 && rest[0] !== 'run') {
    return ['doctor', 'run', ...rest]
  }
  if (group === 'loop' && rest.length > 0 && !['run', 'inspect'].includes(rest[0] ?? '')) {
    return ['loop', 'run', ...rest]
  }
  if (group === 'review' && rest.length > 0 && rest[0] !== 'run') {
    return ['review', 'run', ...rest]
  }
  if (group === 'plugins' && rest.length === 0) {
    return ['plugins', 'list']
  }
  if (group === 'jobs' && rest.length === 0) {
    return ['jobs', 'list']
  }

  return tokens
}

function firstPositionalArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (!value?.startsWith('--')) {
      return value
    }
    if (value === '--json') {
      continue
    }
    index += 1
  }
  return undefined
}

async function applyPatchArtifact(patchPathArg: string, repoArg?: string) {
  const patchPath = resolve(patchPathArg)
  if (!existsSync(patchPath)) {
    throw new Error(`Patch artifact not found: ${patchPathArg}`)
  }

  const repoPath = resolve(repoArg ?? process.cwd())
  const git = simpleGit(repoPath)
  const isRepo = await git.checkIsRepo().catch(() => false)
  if (!isRepo) {
    throw new Error(`Target path is not a git repository: ${repoPath}`)
  }

  const status = await git.status()
  const hasBlockingChanges =
    status.modified.length > 0 ||
    status.staged.length > 0 ||
    status.deleted.length > 0 ||
    status.renamed.length > 0 ||
    status.conflicted.length > 0
  if (hasBlockingChanges) {
    throw new Error('Repository has pending tracked changes. Commit or stash them before apply.')
  }

  execFileSync('git', ['apply', '--check', patchPath], {
    cwd: repoPath,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
    },
  })
  execFileSync('git', ['apply', patchPath], {
    cwd: repoPath,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
    },
  })

  return {
    applied: true,
    patchPath,
    repoPath,
  }
}

export interface CocoShellOptions {
  io?: CLIIO
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  prompt?: string
  scriptedLines?: string[]
}

export async function startCocoShell(options: CocoShellOptions = {}): Promise<number> {
  const io = options.io ?? defaultIO
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const prompt = options.prompt ?? '\x1b[90mcoco>\x1b[0m '
  io.write(renderShellWelcome())

  const runLine = async (line: string): Promise<number | undefined> => {
    const trimmed = line.trim()
    if (!trimmed) {
      return undefined
    }

    if (['exit', 'quit'].includes(trimmed)) {
      io.write('bye')
      return 0
    }

    if (trimmed === 'help' || trimmed === '?') {
      io.write(renderShellHelp())
      return undefined
    }

    if (trimmed === 'clear') {
      output.write('\x1Bc')
      io.write(renderShellWelcome())
      return undefined
    }

    const code = await runCLI(expandShellCommand(tokenizeInput(trimmed)), io, {
      shellMode: true,
    })
    if (code !== 0) {
      io.error(`command failed (${code})`)
    }
    return undefined
  }

  if (options.scriptedLines) {
    for (const line of options.scriptedLines) {
      const result = await runLine(line)
      if (result !== undefined) {
        return result
      }
    }
    return 0
  }

  const reader = createInterface({
    input,
    output,
    terminal: true,
  })

  try {
    for (;;) {
      const result = await runLine(await reader.question(prompt))
      if (result !== undefined) {
        return result
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return 0
    }
    throw error
  } finally {
    reader.close()
  }
}

interface RunCLIOptions {
  shellMode?: boolean
}

function currentEntryPath(): string {
  return resolve(process.argv[1] ?? 'packages/cli/dist/index.js')
}

export function renderLaunchdPlist(
  label: string,
  workingDirectory: string,
  parallel: number,
): string {
  const stdoutPath = resolve(homedir(), 'Library/Logs/coco-daemon.log')
  const stderrPath = resolve(homedir(), 'Library/Logs/coco-daemon.error.log')
  const envFilePath = resolve(workingDirectory, '.env')
  const entryPath = currentEntryPath()

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${process.execPath}</string>
      <string>${entryPath}</string>
      <string>daemon</string>
      <string>start</string>
      <string>--parallel</string>
      <string>${parallel}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${workingDirectory}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>COCO_ENV_FILE</key>
      <string>${envFilePath}</string>
      <key>PATH</key>
      <string>${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
  </dict>
</plist>`
}

function installLaunchdDaemon(label: string, workingDirectory: string, parallel: number) {
  const launchAgentsDir = resolve(homedir(), 'Library/LaunchAgents')
  mkdirSync(launchAgentsDir, { recursive: true })
  mkdirSync(resolve(homedir(), 'Library/Logs'), { recursive: true })
  const plistPath = resolve(launchAgentsDir, `${label}.plist`)
  writeFileSync(plistPath, renderLaunchdPlist(label, workingDirectory, parallel), 'utf-8')

  execFileSync('launchctl', ['unload', plistPath], {
    stdio: 'ignore',
  })
  execFileSync('launchctl', ['load', plistPath], {
    stdio: 'pipe',
  })

  return {
    installed: true,
    label,
    plistPath,
  }
}

export async function runCLI(
  argv: string[],
  io: CLIIO = defaultIO,
  options: RunCLIOptions = {},
): Promise<number> {
  loadEnvFile()
  const [group, maybeAction, maybeSubject, ...remaining] = argv
  const action = maybeAction?.startsWith('--') ? undefined : maybeAction
  const subject = maybeSubject?.startsWith('--') ? undefined : maybeSubject
  const rest = [
    ...(maybeAction?.startsWith('--') ? [maybeAction] : []),
    ...(maybeSubject?.startsWith('--') ? [maybeSubject] : []),
    ...remaining,
  ].filter((value): value is string => Boolean(value))
  const jsonMode = hasFlag(rest, '--json')

  try {
    if (!group) {
      if (!options.shellMode && isInteractiveTerminal()) {
        return await startCocoShell({ io })
      }
      io.write(renderUsage())
      return 0
    }

    if (group === 'shell') {
      return await startCocoShell({ io })
    }

    if (group === 'help' || group === '--help') {
      io.write(renderUsage())
      return 0
    }

    if (group === 'daemon' && action === 'start') {
      const createDaemon = await loadCreateDaemon()
      const parallel = Number(
        parseFlag(rest, '--parallel', process.env.COCO_MAX_CONCURRENCY ?? '2'),
      )
      const daemon = createDaemon({
        maxConcurrentJobs: Number.isFinite(parallel) ? parallel : 2,
      })
      await daemon.start()
      io.write(`${renderCocoBanner()}\n\ncoco daemon listening on ${daemon.url()}`)
      return await new Promise<number>(() => 0)
    }

    if (group === 'daemon' && action === 'print-launchd') {
      const parallel = Number(
        parseFlag(rest, '--parallel', process.env.COCO_MAX_CONCURRENCY ?? '2'),
      )
      const label = parseFlag(rest, '--label', 'dev.coco.daemon') ?? 'dev.coco.daemon'
      io.write(renderLaunchdPlist(label, process.cwd(), Number.isFinite(parallel) ? parallel : 2))
      return 0
    }

    if (group === 'daemon' && action === 'install-launchd') {
      const parallel = Number(
        parseFlag(rest, '--parallel', process.env.COCO_MAX_CONCURRENCY ?? '2'),
      )
      const label = parseFlag(rest, '--label', 'dev.coco.daemon') ?? 'dev.coco.daemon'
      const result = installLaunchdDaemon(
        label,
        process.cwd(),
        Number.isFinite(parallel) ? parallel : 2,
      )
      printOutput(
        io,
        jsonMode,
        result,
        `Installed launchd daemon ${result.label} at ${result.plistPath}.`,
      )
      return 0
    }

    if (group === 'repo' && action === 'add' && subject) {
      const registerResponse = await daemonRequest('/repos', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: resolve(subject),
        }),
      })
      const repo = registerResponse?.ok
        ? ((await registerResponse.json()) as RepoRef)
        : await detectLocalRepo(subject)
      printOutput(io, jsonMode, repo, `Registered repo ${repo.rootPath} as ${repo.id}`)
      return 0
    }

    if (group === 'agent' && action === 'ask' && subject) {
      const sessionName = parseFlag(rest, '--session', 'local') ?? 'local'
      const message = [subject, ...removeFlagValues(rest, ['--session'])].join(' ').trim()
      const supervisor = createSupervisor({ daemonUrl: getDaemonUrl() })
      const sessions = loadAgentSessions()
      const result = await supervisor.handleMessage(message, sessionName, sessions)
      if (result.updatedSessions) {
        saveAgentSessions(result.updatedSessions)
      }
      printOutput(
        io,
        jsonMode,
        {
          session: sessionName,
          reply: result.reply,
          task: result.task ?? null,
          sessionState: result.updatedSessions?.[sessionName] ?? sessions[sessionName] ?? null,
        },
        result.reply,
      )
      return 0
    }

    if (group === 'tasks' && !action) {
      const response = await daemonRequest('/tasks')
      if (!response?.ok) {
        throw new Error('Unable to fetch tasks.')
      }
      const tasks = (await response.json()) as Task[]
      printOutput(
        io,
        jsonMode,
        tasks,
        tasks.length === 0
          ? 'No tasks found.'
          : tasks
              .map((task) => `${task.id}  ${task.mode}  ${task.status}  ${task.goal}`)
              .join('\n'),
      )
      return 0
    }

    if (group === 'task' && action === 'inspect' && subject) {
      const response = await daemonRequest(`/tasks/${subject}`)
      if (!response?.ok) {
        throw new Error(`Unable to fetch task ${subject}.`)
      }
      const payload = (await response.json()) as Record<string, unknown>
      printOutput(io, jsonMode, payload, JSON.stringify(payload, null, 2))
      return 0
    }

    if (group === 'workers' && !action) {
      const response = await daemonRequest('/workers')
      if (!response?.ok) {
        throw new Error('Unable to fetch workers.')
      }
      const workers = (await response.json()) as WorkerInfo[]
      printOutput(
        io,
        jsonMode,
        workers,
        workers.length === 0
          ? 'No workers found.'
          : workers
              .map(
                (worker) =>
                  `${worker.id}  ${worker.kind}  ${worker.status}${worker.currentTaskId ? `  ${worker.currentTaskId}` : ''}`,
              )
              .join('\n'),
      )
      return 0
    }

    if (group === 'watch' && action) {
      const payload = await waitForTask(action)
      printOutput(io, jsonMode, payload, JSON.stringify(payload, null, 2))
      return 0
    }

    if (group === 'apply' && action) {
      const repoArg = subject ?? firstPositionalArg(rest)
      const result = await applyPatchArtifact(action, repoArg)
      printOutput(io, jsonMode, result, `Applied patch ${result.patchPath} to ${result.repoPath}.`)
      return 0
    }

    if (group === 'doctor' && action === 'run' && subject) {
      const repo = await ensureRepo(subject)
      const response = await daemonRequest('/jobs/doctor', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ repoId: repo.id }),
      })

      if (response?.ok) {
        const job = (await response.json()) as { id: string }
        const result = await waitForJob(job.id)
        printOutput(io, jsonMode, result, `Doctor job ${job.id} completed.`)
        return 0
      }

      const pluginPaths = getPluginPaths()
      const runtime = new DoctorRuntime({ pluginPaths })
      const report = await runtime.examine({
        id: repo.id,
        rootPath: repo.rootPath,
        defaultBranch: 'main',
        languageHints: [],
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      printOutput(
        io,
        jsonMode,
        report,
        `Doctor report generated with ${report.findings.length} findings.`,
      )
      return 0
    }

    if (group === 'loop' && action === 'run' && subject) {
      const repo = await ensureRepo(subject)
      const rounds = Number(parseFlag(rest, '--rounds', '1'))
      const provider = parseFlag(rest, '--provider')
      const model = parseFlag(rest, '--model')
      const response = await daemonRequest('/jobs/loop', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ repoId: repo.id, rounds, provider, model }),
      })

      if (response?.ok) {
        const job = (await response.json()) as { id: string }
        const result = await waitForJob(job.id)
        printOutput(io, jsonMode, result, `Loop job ${job.id} completed.`)
        return 0
      }

      const runJob = await loadRunJob()
      const pluginPaths = getPluginPaths()
      const result = await runJob(
        {
          id: randomUUID(),
          type: 'loop',
          repoId: repo.id,
          requestedAt: now(),
          status: 'queued',
          payload: {
            rounds,
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
          },
        },
        {
          pluginPaths,
          getRepo: async () => ({
            id: repo.id,
            rootPath: repo.rootPath,
            defaultBranch: 'main',
            languageHints: [],
            status: 'active',
            createdAt: now(),
            updatedAt: now(),
          }),
          appendEvent: async () => undefined,
        },
      )
      printOutput(
        io,
        jsonMode,
        result,
        `Loop completed with review outcome ${result.review?.outcome ?? 'unknown'}.`,
      )
      return 0
    }

    if (group === 'loop' && action === 'fanout') {
      const provider = parseFlag(rest, '--provider')
      const model = parseFlag(rest, '--model')
      const rounds = Number(parseFlag(rest, '--rounds', '1'))
      const repoPaths = [
        subject,
        ...removeFlagValues(rest, ['--provider', '--model', '--rounds']),
      ].filter((value): value is string => Boolean(value))

      if (repoPaths.length === 0) {
        throw new Error('Provide at least one repository path for loop fanout.')
      }

      const queued: Array<{ repoPath: string; repoId: string; jobId: string }> = []
      for (const repoPath of repoPaths) {
        const repo = await ensureRepo(repoPath)
        const response = await daemonRequest('/jobs/loop', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ repoId: repo.id, rounds, provider, model }),
        })

        if (!response?.ok) {
          throw new Error('loop fanout requires the daemon to be running.')
        }

        const job = (await response.json()) as { id: string }
        queued.push({
          repoPath: repo.rootPath,
          repoId: repo.id,
          jobId: job.id,
        })
      }

      printOutput(
        io,
        jsonMode,
        { queued, count: queued.length, provider: provider ?? 'auto', model: model ?? 'default' },
        `Queued ${queued.length} loop jobs for background execution.`,
      )
      return 0
    }

    if (group === 'plugins' && action === 'list') {
      const pluginPaths = getPluginPaths()
      const { doctor, review, llm } = await loadPluginViews()
      const [doctorExternal, reviewExternal, llmExternal] = await Promise.all([
        doctor.loadFrameworkExpertPlugins(pluginPaths),
        review.loadReviewCheckPlugins(pluginPaths),
        llm.loadLLMProviderPlugins(pluginPaths),
      ])
      const plugins = [
        ...doctor.listDoctorPlugins(),
        ...review.listReviewPlugins(),
        ...llm.listLLMPlugins(),
        ...doctorExternal,
        ...reviewExternal,
        ...llmExternal,
      ].map((plugin) => plugin.manifest)
      printOutput(io, jsonMode, plugins, `Loaded ${plugins.length} plugins.`)
      return 0
    }

    if (group === 'plugins' && action === 'inspect' && subject) {
      const pluginPaths = getPluginPaths()
      const { doctor, review, llm } = await loadPluginViews()
      const [doctorExternal, reviewExternal, llmExternal] = await Promise.all([
        doctor.loadFrameworkExpertPlugins(pluginPaths),
        review.loadReviewCheckPlugins(pluginPaths),
        llm.loadLLMProviderPlugins(pluginPaths),
      ])
      const plugins = [
        ...doctor.listDoctorPlugins(),
        ...review.listReviewPlugins(),
        ...llm.listLLMPlugins(),
        ...doctorExternal,
        ...reviewExternal,
        ...llmExternal,
      ]
      const plugin = plugins.find((candidate) => candidate.manifest.name === subject)
      if (!plugin) {
        throw new Error(`Plugin not found: ${subject}`)
      }
      printOutput(io, jsonMode, plugin.manifest, `Plugin ${plugin.manifest.name} loaded.`)
      return 0
    }

    if (group === 'loop' && action === 'inspect' && subject) {
      const rounds = Number(parseFlag(rest, '--rounds', '1'))
      const provider = parseFlag(rest, '--provider')
      const model = parseFlag(rest, '--model')
      const summary = await runKarpathyLoop({
        projectPath: resolve(subject),
        rounds,
        dryRun: true,
        verbose: false,
        mode: provider === 'null' ? 'deterministic' : provider === 'ollama' ? 'ollama' : 'auto',
        model: model ?? 'qwen3-coder:30b',
        ollamaUrl: 'http://127.0.0.1:11434',
      })
      printOutput(
        io,
        jsonMode,
        summary,
        `Loop inspect completed with ${summary.results.length} proposed experiments.`,
      )
      return 0
    }

    if (group === 'review' && action === 'run' && subject) {
      const path = resolve(subject)
      const gate = new ReviewGate({ pluginPaths: getPluginPaths() })
      const report = await gate.run({
        projectPath: path,
        patchApplied: false,
      })
      printOutput(io, jsonMode, report, `Review completed with outcome ${report.outcome}.`)
      return 0
    }

    if (group === 'jobs' && action === 'list') {
      const response = await daemonRequest('/jobs')
      if (!response?.ok) {
        throw new Error('jobs list requires the daemon to be running.')
      }
      const jobs = (await response.json()) as unknown
      printOutput(io, jsonMode, jobs, 'Listed daemon jobs.')
      return 0
    }

    if (group === 'jobs' && action === 'inspect' && subject) {
      const response = await daemonRequest(`/jobs/${subject}`)
      if (!response?.ok) {
        throw new Error(`Job not found: ${subject}`)
      }
      const job = (await response.json()) as unknown
      printOutput(io, jsonMode, job, `Loaded job ${subject}.`)
      return 0
    }

    io.write(renderUsage())
    return 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.error(message)
    return 1
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false
}

if (isDirectExecution()) {
  void runCLI(process.argv.slice(2)).then((code) => {
    if (code !== 0) {
      process.exit(code)
    }
  })
}
