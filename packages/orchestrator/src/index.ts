import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { type IncomingMessage, createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  DoctorJobPayload,
  Job,
  JobEvent,
  JobPayload,
  JobResult,
  LoopJobPayload,
  MonitorEvent,
  ManagedRepoState,
  ApprovalQueueItem,
  Mission,
  MissionEvent,
  RepoExecutionProfile,
  RepoRef,
  SessionInfo,
  Task,
  TaskCreateInput,
  TaskMemory,
  TaskPlan,
  TaskStatus,
  TaskStep,
  TaskStepStatus,
  WorkspaceSession,
  WorkerInfo,
  WorkerKind,
} from '@coco/core'
import { runJob } from '@coco/worker'
import { simpleGit } from 'simple-git'

const DEFAULT_PORT = Number(process.env.PORT ?? 3000)

function getDefaultHost(): string {
  const configured = process.env.COCO_BIND_HOST?.trim()
  if (configured && configured !== 'undefined') {
    return configured
  }
  return existsSync('/.dockerenv') ? '0.0.0.0' : '127.0.0.1'
}
type DatabaseSyncConstructor = new (
  path: string,
) => {
  exec(sql: string): void
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
}

function loadDatabaseSync(): DatabaseSyncConstructor {
  const require = createRequire(import.meta.url)
  const sqlite = require('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor }
  return sqlite.DatabaseSync
}

export interface DaemonConfig {
  host?: string
  port?: number
  dataDir?: string
  embeddedWorker?: boolean
  pluginPaths?: string[]
  maxConcurrentJobs?: number
  workerRunner?: typeof runJob
  dockerExec?: (args: string[], cwd?: string) => Promise<string>
  controlPlaneUrl?: string
  chatGatewayUrl?: string
  fetchImpl?: typeof fetch
}

interface DockerContainerInfo {
  id: string
  name: string
  image: string
  state: string
  status: string
}

function getDefaultDataDir(): string {
  return process.env.COCO_HOME ?? join(homedir(), '.local', 'share', 'coco')
}

function now(): string {
  return new Date().toISOString()
}

function runCommand(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      resolvePromise(stdout)
    })
  })
}

function ensureDataDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

function parseJSON<T>(value: string | null): T | undefined {
  return value ? (JSON.parse(value) as T) : undefined
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

async function listDockerContainers(
  dockerExec = (args: string[], cwd?: string) => runCommand('docker', args, cwd),
): Promise<DockerContainerInfo[]> {
  const output = await dockerExec(['ps', '-a', '--format', '{{json .}}'])
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>)
    .map((row) => ({
      id: row.ID ?? '',
      name: row.Names ?? '',
      image: row.Image ?? '',
      state: row.State ?? '',
      status: row.Status ?? '',
    }))
}

async function runDockerContainerAction(
  action: 'start' | 'stop' | 'restart' | 'remove',
  idOrName: string,
  dockerExec = (args: string[], cwd?: string) => runCommand('docker', args, cwd),
): Promise<{ ok: true; action: string; target: string }> {
  const args = action === 'remove' ? ['rm', '-f', idOrName] : [action, idOrName]
  await dockerExec(args, '/workspace')
  return {
    ok: true,
    action,
    target: idOrName,
  }
}

function toRepo(row: Record<string, unknown>): RepoRef {
  return {
    id: String(row.id),
    rootPath: String(row.root_path),
    defaultBranch: String(row.default_branch),
    languageHints: parseJSON<string[]>(String(row.language_hints)) ?? [],
    status: row.status as RepoRef['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function stackFamilyFromHints(hints: string[]): RepoExecutionProfile['stackFamily'] {
  const normalized = new Set(hints.map((hint) => hint.toLowerCase()))
  if (normalized.has('cs') || normalized.has('csharp') || normalized.has('dotnet')) {
    return 'csharp'
  }
  if (normalized.has('cpp-unreal') || normalized.has('unreal') || normalized.has('c++')) {
    return 'cpp-unreal'
  }
  if (normalized.has('ts') || normalized.has('js') || normalized.has('node')) {
    return 'ts'
  }
  return 'mixed'
}

function buildRepoExecutionProfile(repo: RepoRef): RepoExecutionProfile {
  const stackFamily = stackFamilyFromHints(repo.languageHints)
  const runnerType =
    stackFamily === 'csharp'
      ? 'csharp-worker'
      : stackFamily === 'cpp-unreal'
        ? 'unreal-cpp-worker'
        : stackFamily === 'ts'
          ? 'ts-worker'
          : 'mixed-worker'
  return {
    repoId: repo.id,
    rootPath: repo.rootPath,
    stackFamily,
    runnerType,
    buildCommands:
      stackFamily === 'csharp'
        ? ['dotnet build']
        : stackFamily === 'cpp-unreal'
          ? ['Engine/Build/BatchFiles/Build.sh']
          : ['pnpm build'],
    testCommands:
      stackFamily === 'csharp'
        ? ['dotnet test']
        : stackFamily === 'cpp-unreal'
          ? ['Engine/Build/BatchFiles/RunUAT.sh BuildCookRun']
          : ['pnpm test'],
    lintCommands: stackFamily === 'ts' ? ['pnpm lint'] : [],
    artifactPaths: [],
    sandboxClass: stackFamily === 'cpp-unreal' ? 'elevated-build' : 'default',
    timeoutProfile: {
      buildSeconds: stackFamily === 'cpp-unreal' ? 3600 : 900,
      testSeconds: stackFamily === 'cpp-unreal' ? 5400 : 900,
    },
    allowedTools: ['shell', 'git', 'search'],
    workerCapabilities: {
      canEditCode: true,
      canRunTests: true,
      canBuild: true,
      canUseBrowser: false,
      canSearchWeb: true,
      canRunShell: true,
      canOpenIde: false,
      artifactPaths: [],
      timeoutLimits: {
        buildSeconds: stackFamily === 'cpp-unreal' ? 3600 : 900,
        testSeconds: stackFamily === 'cpp-unreal' ? 5400 : 900,
      },
      sandboxClass: stackFamily === 'cpp-unreal' ? 'elevated-build' : 'default',
    },
  }
}

function toJob(row: Record<string, unknown>): Job {
  const job: Job = {
    id: String(row.id),
    type: row.type as Job['type'],
    repoId: String(row.repo_id),
    requestedAt: String(row.requested_at),
    status: row.status as Job['status'],
    payload: parseJSON<JobPayload>(String(row.payload_json)) ?? {},
  }
  if (row.started_at) {
    job.startedAt = String(row.started_at)
  }
  if (row.finished_at) {
    job.finishedAt = String(row.finished_at)
  }
  return job
}

function toEvent(row: Record<string, unknown>): JobEvent {
  const event: JobEvent = {
    id: String(row.id),
    jobId: String(row.job_id),
    timestamp: String(row.timestamp),
    phase: String(row.phase),
    level: row.level as JobEvent['level'],
    message: String(row.message),
  }
  const data = parseJSON<Record<string, unknown>>(row.data_json ? String(row.data_json) : null)
  if (data) {
    event.data = data
  }
  return event
}

function toTask(row: Record<string, unknown>): Task {
  const task: Task = {
    id: String(row.id),
    goal: String(row.goal),
    mode: row.mode as Task['mode'],
    status: row.status as TaskStatus,
    sessionId: String(row.session_id),
    plan: parseJSON<TaskPlan>(String(row.plan_json)) ?? { steps: [] },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
  if (row.repo_id) task.repoId = String(row.repo_id)
  const memory = parseJSON<TaskMemory>(row.memory_json ? String(row.memory_json) : null)
  if (memory) task.memory = memory
  const checkpoint = parseJSON<Task['checkpoint']>(
    row.checkpoint_json ? String(row.checkpoint_json) : null,
  )
  if (checkpoint) task.checkpoint = checkpoint
  if (row.latest_summary) task.latestSummary = String(row.latest_summary)
  if (row.blocked_reason) task.blockedReason = String(row.blocked_reason)
  if (row.active_worker_id) task.activeWorkerId = String(row.active_worker_id)
  const artifacts = parseJSON<Task['artifacts']>(
    row.artifacts_json ? String(row.artifacts_json) : null,
  )
  if (artifacts) task.artifacts = artifacts
  return task
}

function toTaskStep(row: Record<string, unknown>): TaskStep {
  const step: TaskStep = {
    id: String(row.id),
    taskId: String(row.task_id),
    order: Number(row.step_order),
    tool: String(row.tool),
    title: String(row.title),
    status: row.status as TaskStepStatus,
  }
  const input = parseJSON<Record<string, unknown>>(row.input_json ? String(row.input_json) : null)
  if (input) step.input = input
  if (row.output_summary) step.outputSummary = String(row.output_summary)
  if (row.started_at) step.startedAt = String(row.started_at)
  if (row.finished_at) step.finishedAt = String(row.finished_at)
  return step
}

function toWorkspaceSession(row: Record<string, unknown>): WorkspaceSession {
  return {
    id: String(row.id),
    goal: String(row.goal),
    status: String(row.status) as WorkspaceSession['status'],
    workerSurface: String(row.worker_surface) as WorkspaceSession['workerSurface'],
    controlSurfaces: parseJSON<WorkspaceSession['controlSurfaces']>(
      String(row.control_surfaces_json),
    ) ?? ['terminal'],
    repoRoots: parseJSON<string[]>(String(row.repo_roots_json)) ?? [],
    managedRepos: parseJSON<ManagedRepoState[]>(String(row.managed_repos_json)) ?? [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.success_criteria ? { successCriteria: String(row.success_criteria) } : {}),
    ...(row.focus_repo_id ? { focusRepoId: String(row.focus_repo_id) } : {}),
    ...(row.active_task_id ? { activeTaskId: String(row.active_task_id) } : {}),
    ...(row.active_worker_id ? { activeWorkerId: String(row.active_worker_id) } : {}),
    ...(row.latest_summary ? { latestSummary: String(row.latest_summary) } : {}),
    ...(row.last_review_decision
      ? { lastReviewDecision: String(row.last_review_decision) as WorkspaceSession['lastReviewDecision'] }
      : {}),
  }
}

function toMonitorEvent(row: Record<string, unknown>): MonitorEvent {
  const event: MonitorEvent = {
    id: String(row.id),
    taskId: String(row.task_id),
    timestamp: String(row.timestamp),
    phase: String(row.phase),
    level: row.level as MonitorEvent['level'],
    message: String(row.message),
  }
  const data = parseJSON<Record<string, unknown>>(row.data_json ? String(row.data_json) : null)
  if (data) event.data = data
  return event
}

function workerKindForMode(mode: Task['mode']): WorkerKind {
  switch (mode) {
    case 'analyze':
      return 'analysis-worker'
    case 'fix':
      return 'fix-worker'
    default:
      return 'background-worker'
  }
}

export const orchestratorPackage = {
  name: '@coco/orchestrator',
  status: 'ready',
  message: 'Local-first daemon with SQLite persistence and embedded worker execution.',
  defaultPort: DEFAULT_PORT,
} as const

export function createDaemon(config: DaemonConfig = {}) {
  const dataDir = ensureDataDir(config.dataDir ?? getDefaultDataDir())
  const dbPath = join(dataDir, 'coco.sqlite')
  const DatabaseSync = loadDatabaseSync()
  const db = new DatabaseSync(dbPath)
  const pluginPaths =
    config.pluginPaths ??
    (process.env.COCO_PLUGIN_PATHS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  const maxConcurrentJobs = Math.max(
    1,
    config.maxConcurrentJobs ?? Number(process.env.COCO_MAX_CONCURRENCY ?? 2),
  )
  const workerRunner = config.workerRunner ?? runJob
  const dockerExec =
    config.dockerExec ?? ((args: string[], cwd?: string) => runCommand('docker', args, cwd))
  const controlPlaneUrl =
    config.controlPlaneUrl ?? process.env.COCO_LANGGRAPH_URL ?? 'http://127.0.0.1:4100'
  const chatGatewayUrl = config.chatGatewayUrl ?? process.env.COCO_CHAT_GATEWAY_URL
  const fetchImpl = config.fetchImpl ?? fetch
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL,
      language_hints TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      result_json TEXT
    );
    CREATE TABLE IF NOT EXISTS job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      phase TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      repo_id TEXT,
      goal TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      memory_json TEXT,
      checkpoint_json TEXT,
      latest_summary TEXT,
      blocked_reason TEXT,
      active_worker_id TEXT,
      artifacts_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_sessions (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      worker_surface TEXT NOT NULL,
      control_surfaces_json TEXT NOT NULL,
      success_criteria TEXT,
      repo_roots_json TEXT NOT NULL,
      managed_repos_json TEXT NOT NULL,
      focus_repo_id TEXT,
      active_task_id TEXT,
      active_worker_id TEXT,
      latest_summary TEXT,
      last_review_decision TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_steps (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      tool TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT,
      output_summary TEXT,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      phase TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT
    );
    UPDATE jobs SET status = 'retryable' WHERE status = 'running';
    UPDATE tasks SET status = 'blocked', blocked_reason = 'Daemon restarted during task execution.', updated_at = '${now()}'
    WHERE status = 'running';
    UPDATE task_steps SET status = 'blocked', finished_at = '${now()}'
    WHERE status = 'running';
  `)

  const statements = {
    insertRepo: db.prepare(`
      INSERT INTO repos (id, root_path, default_branch, language_hints, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    listRepos: db.prepare('SELECT * FROM repos ORDER BY created_at ASC'),
    getRepoById: db.prepare('SELECT * FROM repos WHERE id = ?'),
    getRepoByPath: db.prepare('SELECT * FROM repos WHERE root_path = ?'),
    insertJob: db.prepare(`
      INSERT INTO jobs (id, type, repo_id, requested_at, status, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    listJobs: db.prepare('SELECT * FROM jobs ORDER BY requested_at DESC LIMIT 100'),
    nextJob: db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('queued', 'retryable')
      ORDER BY requested_at ASC
      LIMIT 1
    `),
    updateJobStart: db.prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`),
    updateJobFinish: db.prepare(`
      UPDATE jobs
      SET status = ?, finished_at = ?, result_json = ?
      WHERE id = ?
    `),
    insertEvent: db.prepare(`
      INSERT INTO job_events (id, job_id, timestamp, phase, level, message, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    listEvents: db.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY timestamp ASC'),
    countQueuedJobs: db.prepare(
      `SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'retryable', 'running')`,
    ),
    insertTask: db.prepare(`
      INSERT INTO tasks (
        id, session_id, repo_id, goal, mode, status, plan_json, memory_json,
        checkpoint_json, latest_summary, blocked_reason, active_worker_id,
        artifacts_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    listTasks: db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100'),
    nextTask: db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `),
    updateTaskState: db.prepare(`
      UPDATE tasks
      SET status = ?, plan_json = ?, memory_json = ?, checkpoint_json = ?,
          latest_summary = ?, blocked_reason = ?, active_worker_id = ?, artifacts_json = ?, updated_at = ?
      WHERE id = ?
    `),
    insertTaskStep: db.prepare(`
      INSERT INTO task_steps (
        id, task_id, step_order, tool, title, status, input_json, output_summary, started_at, finished_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listTaskSteps: db.prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_order ASC'),
    getTaskStep: db.prepare('SELECT * FROM task_steps WHERE id = ?'),
    updateTaskStep: db.prepare(`
      UPDATE task_steps
      SET status = ?, output_summary = ?, started_at = ?, finished_at = ?
      WHERE id = ?
    `),
    insertTaskEvent: db.prepare(`
      INSERT INTO task_events (id, task_id, timestamp, phase, level, message, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    listTaskEvents: db.prepare(
      'SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp ASC',
    ),
    insertWorkspaceSession: db.prepare(`
      INSERT INTO workspace_sessions (
        id, goal, status, worker_surface, control_surfaces_json, success_criteria,
        repo_roots_json, managed_repos_json, focus_repo_id, active_task_id, active_worker_id,
        latest_summary, last_review_decision, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getWorkspaceSession: db.prepare('SELECT * FROM workspace_sessions WHERE id = ?'),
    listWorkspaceSessions: db.prepare(
      'SELECT * FROM workspace_sessions ORDER BY updated_at DESC LIMIT 100',
    ),
    updateWorkspaceSession: db.prepare(`
      UPDATE workspace_sessions
      SET goal = ?, status = ?, worker_surface = ?, control_surfaces_json = ?, success_criteria = ?,
          repo_roots_json = ?, managed_repos_json = ?, focus_repo_id = ?, active_task_id = ?,
          active_worker_id = ?, latest_summary = ?, last_review_decision = ?, updated_at = ?
      WHERE id = ?
    `),
    listSessions: db.prepare(`
      SELECT session_id, COUNT(*) AS task_count, MAX(updated_at) AS updated_at
      FROM tasks
      GROUP BY session_id
      ORDER BY updated_at DESC
    `),
    countQueuedTasks: db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE status = 'queued'`),
  }

  let draining = false
  let activeJobs = 0
  let drainingTasks = false
  const workers = Array.from(
    { length: maxConcurrentJobs },
    (_, index): WorkerInfo => ({
      id: `worker-${index + 1}`,
      kind: 'background-worker',
      status: 'idle',
      lastHeartbeat: now(),
    }),
  )

  async function detectRepo(rootPath: string): Promise<RepoRef> {
    const existing = statements.getRepoByPath.get(rootPath) as Record<string, unknown> | undefined
    if (existing) {
      return toRepo(existing)
    }

    const git = simpleGit(rootPath)
    const branch =
      (await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => 'main')).trim() || 'main'
    const languageHints = detectLanguageHints(rootPath)
    const repo: RepoRef = {
      id: randomUUID(),
      rootPath,
      defaultBranch: branch,
      languageHints,
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    }
    statements.insertRepo.run(
      repo.id,
      repo.rootPath,
      repo.defaultBranch,
      JSON.stringify(repo.languageHints),
      repo.status,
      repo.createdAt,
      repo.updatedAt,
    )
    void syncRepoExecutionProfile(repo)
    return repo
  }

  async function syncRepoExecutionProfile(repo: RepoRef): Promise<void> {
    await proxyJson<RepoExecutionProfile>(controlPlaneUrl, `/repo-profiles/${repo.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        root_path: repo.rootPath,
        stack_family: buildRepoExecutionProfile(repo).stackFamily,
        runner_type: buildRepoExecutionProfile(repo).runnerType,
        build_commands: buildRepoExecutionProfile(repo).buildCommands,
        test_commands: buildRepoExecutionProfile(repo).testCommands,
        lint_commands: buildRepoExecutionProfile(repo).lintCommands,
        artifact_paths: buildRepoExecutionProfile(repo).artifactPaths,
        sandbox_class: buildRepoExecutionProfile(repo).sandboxClass,
        timeout_profile: buildRepoExecutionProfile(repo).timeoutProfile,
        allowed_tools: buildRepoExecutionProfile(repo).allowedTools,
        worker_capabilities: {
          can_edit_code: buildRepoExecutionProfile(repo).workerCapabilities.canEditCode,
          can_run_tests: buildRepoExecutionProfile(repo).workerCapabilities.canRunTests,
          can_build: buildRepoExecutionProfile(repo).workerCapabilities.canBuild,
          can_use_browser: buildRepoExecutionProfile(repo).workerCapabilities.canUseBrowser,
          can_search_web: buildRepoExecutionProfile(repo).workerCapabilities.canSearchWeb,
          can_run_shell: buildRepoExecutionProfile(repo).workerCapabilities.canRunShell,
          can_open_ide: buildRepoExecutionProfile(repo).workerCapabilities.canOpenIde,
          artifact_paths: buildRepoExecutionProfile(repo).workerCapabilities.artifactPaths,
          timeout_limits: buildRepoExecutionProfile(repo).workerCapabilities.timeoutLimits,
          sandbox_class: buildRepoExecutionProfile(repo).workerCapabilities.sandboxClass,
        },
      }),
    }).catch(() => undefined)
  }

  function listRepos(): RepoRef[] {
    return (statements.listRepos.all() as Record<string, unknown>[]).map(toRepo)
  }

  async function appendEvent(event: Omit<JobEvent, 'id' | 'timestamp'>): Promise<void> {
    statements.insertEvent.run(
      randomUUID(),
      event.jobId,
      now(),
      event.phase,
      event.level,
      event.message,
      event.data ? JSON.stringify(event.data) : null,
    )
  }

  function getJobRecord(
    jobId: string,
  ): { job: Job; events: JobEvent[]; result?: JobResult } | undefined {
    const row = statements.getJob.get(jobId) as Record<string, unknown> | undefined
    if (!row) return undefined
    const events = (statements.listEvents.all(jobId) as Record<string, unknown>[]).map(toEvent)
    const record: { job: Job; events: JobEvent[]; result?: JobResult } = {
      job: toJob(row),
      events,
    }
    const result = parseJSON<JobResult>(row.result_json ? String(row.result_json) : null)
    if (result) {
      record.result = result
    }
    return record
  }

  function listJobs(): Array<{ job: Job; result?: JobResult }> {
    return (statements.listJobs.all() as Record<string, unknown>[]).map((row) => {
      const record: { job: Job; result?: JobResult } = {
        job: toJob(row),
      }
      const result = parseJSON<JobResult>(row.result_json ? String(row.result_json) : null)
      if (result) {
        record.result = result
      }
      return record
    })
  }

  function getTaskRecord(
    taskId: string,
  ): { task: Task; steps: TaskStep[]; events: MonitorEvent[] } | undefined {
    const row = statements.getTask.get(taskId) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      task: toTask(row),
      steps: (statements.listTaskSteps.all(taskId) as Record<string, unknown>[]).map(toTaskStep),
      events: (statements.listTaskEvents.all(taskId) as Record<string, unknown>[]).map(
        toMonitorEvent,
      ),
    }
  }

  function listTasks(): Task[] {
    return (statements.listTasks.all() as Record<string, unknown>[]).map(toTask)
  }

  function listWorkers(): WorkerInfo[] {
    return workers.map((worker) => ({ ...worker }))
  }

  function getWorkspaceSession(sessionId: string): WorkspaceSession | undefined {
    const row = statements.getWorkspaceSession.get(sessionId) as Record<string, unknown> | undefined
    return row ? toWorkspaceSession(row) : undefined
  }

  function persistWorkspaceSession(session: WorkspaceSession): void {
    statements.updateWorkspaceSession.run(
      session.goal,
      session.status,
      session.workerSurface,
      JSON.stringify(session.controlSurfaces),
      session.successCriteria ?? null,
      JSON.stringify(session.repoRoots),
      JSON.stringify(session.managedRepos),
      session.focusRepoId ?? null,
      session.activeTaskId ?? null,
      session.activeWorkerId ?? null,
      session.latestSummary ?? null,
      session.lastReviewDecision ?? null,
      session.updatedAt,
      session.id,
    )
  }

  function listWorkspaceSessions(): WorkspaceSession[] {
    return (statements.listWorkspaceSessions.all() as Record<string, unknown>[]).map(toWorkspaceSession)
  }

  function listSessions(): SessionInfo[] {
    const tasks = listTasks()
    const taskBacked = (statements.listSessions.all() as Record<string, unknown>[]).map((row) => {
      const sessionId = String(row.session_id)
      const activeTask = tasks.find(
        (task) =>
          task.sessionId === sessionId &&
          ['queued', 'running', 'blocked', 'paused'].includes(task.status),
      )
      return {
        id: sessionId,
        ...(activeTask?.repoId ? { activeRepoId: activeTask.repoId } : {}),
        ...(activeTask?.id ? { activeTaskId: activeTask.id } : {}),
        updatedAt: String(row.updated_at),
        taskCount: Number(row.task_count),
      }
    })
    const workspace = new Map<string, SessionInfo>(
      listWorkspaceSessions().map((session) => [
        session.id,
        {
          id: session.id,
          goal: session.goal,
          status: session.status,
          workerSurface: session.workerSurface,
          controlSurfaces: session.controlSurfaces,
          managedRepos: session.managedRepos,
          latestSummary: session.latestSummary,
          lastReviewDecision: session.lastReviewDecision,
          focusRepoId: session.focusRepoId,
          activeRepoId: session.focusRepoId,
          activeTaskId: session.activeTaskId,
          updatedAt: session.updatedAt,
          taskCount: tasks.filter((task) => task.sessionId === session.id).length,
        } satisfies SessionInfo,
      ]),
    )
    for (const session of taskBacked) {
      const existing = workspace.get(session.id)
      workspace.set(session.id, {
        id: session.id,
        taskCount: Math.max(existing?.taskCount ?? 0, session.taskCount),
        activeTaskId: existing?.activeTaskId ?? session.activeTaskId,
        activeRepoId: existing?.activeRepoId ?? session.activeRepoId,
        updatedAt: existing?.updatedAt ?? session.updatedAt,
        ...(existing?.goal ? { goal: existing.goal } : {}),
        ...(existing?.status ? { status: existing.status } : {}),
        ...(existing?.workerSurface ? { workerSurface: existing.workerSurface } : {}),
        ...(existing?.controlSurfaces ? { controlSurfaces: existing.controlSurfaces } : {}),
        ...(existing?.managedRepos ? { managedRepos: existing.managedRepos } : {}),
        ...(existing?.latestSummary ? { latestSummary: existing.latestSummary } : {}),
        ...(existing?.lastReviewDecision
          ? { lastReviewDecision: existing.lastReviewDecision }
          : {}),
        ...(existing?.focusRepoId ? { focusRepoId: existing.focusRepoId } : {}),
      })
    }
    return [...workspace.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async function createWorkspaceSession(input: {
    id?: string
    goal: string
    workerSurface?: WorkspaceSession['workerSurface']
    controlSurfaces?: WorkspaceSession['controlSurfaces']
    successCriteria?: string
    repoRoots?: string[]
  }): Promise<WorkspaceSession> {
    const createdAt = now()
    const session: WorkspaceSession = {
      id: input.id ?? randomUUID(),
      goal: input.goal,
      status: 'active',
      workerSurface: input.workerSurface ?? 'aider',
      controlSurfaces: input.controlSurfaces ?? ['terminal'],
      successCriteria: input.successCriteria,
      repoRoots: input.repoRoots ?? [],
      managedRepos: [],
      createdAt,
      updatedAt: createdAt,
    }
    statements.insertWorkspaceSession.run(
      session.id,
      session.goal,
      session.status,
      session.workerSurface,
      JSON.stringify(session.controlSurfaces),
      session.successCriteria ?? null,
      JSON.stringify(session.repoRoots),
      JSON.stringify(session.managedRepos),
      null,
      null,
      null,
      null,
      null,
      session.createdAt,
      session.updatedAt,
    )
    return session
  }

  function detectRepoHints(rootPath: string): string[] {
    const hints = new Set<string>()
    if (existsSync(join(rootPath, 'package.json'))) hints.add('node')
    if (existsSync(join(rootPath, 'tsconfig.json'))) hints.add('ts')
    if (existsSync(join(rootPath, 'pyproject.toml')) || existsSync(join(rootPath, 'requirements.txt'))) hints.add('python')
    if (existsSync(join(rootPath, 'Cargo.toml'))) hints.add('rust')
    if (existsSync(join(rootPath, 'go.mod'))) hints.add('go')
    if (existsSync(join(rootPath, '.git'))) hints.add('git')
    return [...hints]
  }

  function computeGoalRelevance(goal: string, rootPath: string, hints: string[]): number {
    const normalizedGoal = normalizeText(goal)
    const name = normalizeText(rootPath.split('/').at(-1) ?? rootPath)
    let score = normalizedGoal.includes(name) ? 1 : 0
    for (const hint of hints) {
      if (normalizedGoal.includes(hint)) score += 0.25
    }
    return Math.min(1, score)
  }

  async function discoverReposForSession(session: WorkspaceSession): Promise<WorkspaceSession> {
    const candidateRoots = new Set<string>(session.repoRoots)
    const desktopRoot = join(process.env.COCO_HOST_HOME ?? homedir(), 'Desktop')
    candidateRoots.add(desktopRoot)
    const managed = new Map(session.managedRepos.map((repo) => [repo.repoId, repo]))

    for (const root of candidateRoots) {
      if (!existsSync(root)) continue
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.coco')) continue
        if (entry.name.startsWith('coco-exp-')) continue
        const fullPath = join(root, entry.name)
        if (!existsSync(join(fullPath, '.git'))) continue
        let repo = statements.getRepoByPath.get(fullPath) as Record<string, unknown> | undefined
        if (!repo) {
          await detectRepo(fullPath)
          repo = statements.getRepoByPath.get(fullPath) as Record<string, unknown> | undefined
        }
        if (!repo) continue
        const repoRef = toRepo(repo)
        const hints = detectRepoHints(fullPath)
        managed.set(repoRef.id, {
          repoId: repoRef.id,
          rootPath: repoRef.rootPath,
          priority: Math.max(1, Math.round(computeGoalRelevance(session.goal, repoRef.rootPath, hints) * 100)),
          status: 'idle',
          workerSurface: session.workerSurface,
          goalRelevance: computeGoalRelevance(session.goal, repoRef.rootPath, hints),
          hints,
          updatedAt: now(),
        })
      }
    }

    const managedRepos = [...managed.values()].sort((left, right) => right.priority - left.priority)
    const nextSession: WorkspaceSession = {
      ...session,
      managedRepos,
      focusRepoId: session.focusRepoId ?? managedRepos[0]?.repoId,
      latestSummary: managedRepos.length
        ? `${managedRepos.length} repos discovered and prioritized.`
        : 'No repositories discovered.',
      updatedAt: now(),
    }
    persistWorkspaceSession(nextSession)
    return nextSession
  }

  async function appendTaskEvent(event: Omit<MonitorEvent, 'id' | 'timestamp'>): Promise<void> {
    statements.insertTaskEvent.run(
      randomUUID(),
      event.taskId,
      now(),
      event.phase,
      event.level,
      event.message,
      event.data ? JSON.stringify(event.data) : null,
    )
  }

  function planForTask(
    taskId: string,
    mode: Task['mode'],
    successCriteria?: string,
    milestoneTarget?: string,
  ): TaskPlan {
    const steps: TaskStep[] = [
      {
        id: randomUUID(),
        taskId,
        order: 0,
        tool: 'inspect_git_state',
        title: 'Inspect git state and safe remote status',
        status: 'pending',
      },
      {
        id: randomUUID(),
        taskId,
        order: 1,
        tool: 'doctor_inspect',
        title: 'Run structured repo inspection',
        status: 'pending',
      },
    ]
    if (mode !== 'analyze') {
      steps.push({
        id: randomUUID(),
        taskId,
        order: 2,
        tool: 'run_loop_fix',
        title: mode === 'fix' ? 'Run safe fix strategy' : 'Run autopilot improvement cycle',
        status: 'pending',
        ...(milestoneTarget ? { input: { milestoneTarget } } : {}),
      })
    }
    return {
      steps,
      currentStepId: steps[0]?.id,
      ...(successCriteria ? { successCriteria } : {}),
      ...(mode === 'autopilot'
        ? { stopCriteria: 'Stop on success criteria, blocked state, or cycle cap.' }
        : {}),
    }
  }

  function persistTask(task: Task): void {
    statements.updateTaskState.run(
      task.status,
      JSON.stringify(task.plan),
      task.memory ? JSON.stringify(task.memory) : null,
      task.checkpoint ? JSON.stringify(task.checkpoint) : null,
      task.latestSummary ?? null,
      task.blockedReason ?? null,
      task.activeWorkerId ?? null,
      task.artifacts ? JSON.stringify(task.artifacts) : null,
      task.updatedAt,
      task.id,
    )
  }

  async function createTask(input: TaskCreateInput): Promise<Task> {
    const taskId = randomUUID()
    const plan = planForTask(taskId, input.mode, input.successCriteria, input.milestoneTarget)
    const task: Task = {
      id: taskId,
      goal: input.goal,
      mode: input.mode,
      status: 'queued',
      sessionId: input.sessionId,
      plan,
      createdAt: now(),
      updatedAt: now(),
      ...(input.repoId ? { repoId: input.repoId } : {}),
      ...(input.workerSurface || input.managedRepoId || input.milestoneTarget
        ? {
            artifacts: {
              ...(input.workerSurface ? { executionSurface: input.workerSurface } : {}),
              ...(input.milestoneTarget ? { milestoneTarget: input.milestoneTarget } : {}),
            },
          }
        : {}),
      ...(input.successCriteria
        ? {
            checkpoint: {
              currentPhase: 'queued',
              cycleCount: 0,
              updatedAt: now(),
            },
          }
        : {}),
    }
    statements.insertTask.run(
      task.id,
      task.sessionId,
      task.repoId ?? null,
      task.goal,
      task.mode,
      task.status,
      JSON.stringify(task.plan),
      null,
      task.checkpoint ? JSON.stringify(task.checkpoint) : null,
      null,
      null,
      null,
      task.artifacts ? JSON.stringify(task.artifacts) : null,
      task.createdAt,
      task.updatedAt,
    )
    for (const step of task.plan.steps) {
      statements.insertTaskStep.run(
        step.id,
        step.taskId,
        step.order,
        step.tool,
        step.title,
        step.status,
        step.input ? JSON.stringify(step.input) : null,
        null,
        null,
        null,
      )
    }
    await appendTaskEvent({
      taskId: task.id,
      phase: 'task',
      level: 'info',
      message: `Task created in ${task.mode} mode.`,
      data: { goal: task.goal },
    })
    const workspaceSession = getWorkspaceSession(task.sessionId)
    if (workspaceSession) {
      persistWorkspaceSession({
        ...workspaceSession,
        activeTaskId: task.id,
        focusRepoId: task.repoId ?? workspaceSession.focusRepoId,
        latestSummary: `Task queued in ${task.mode} mode.`,
        updatedAt: now(),
      })
    }
    void processNextTask()
    return task
  }

  async function enqueueJob(type: Job['type'], repoId: string, payload: JobPayload): Promise<Job> {
    const job: Job = {
      id: randomUUID(),
      type,
      repoId,
      requestedAt: now(),
      status: 'queued',
      payload,
    }
    statements.insertJob.run(
      job.id,
      job.type,
      job.repoId,
      job.requestedAt,
      job.status,
      JSON.stringify(job.payload),
    )
    await appendEvent({
      jobId: job.id,
      phase: 'queue',
      level: 'info',
      message: `Queued ${job.type} job.`,
    })
    void processNextJob()
    return job
  }

  async function processNextJob(): Promise<void> {
    if (draining || config.embeddedWorker === false) return

    draining = true
    try {
      while (activeJobs < maxConcurrentJobs) {
        const next = statements.nextJob.get() as Record<string, unknown> | undefined
        if (!next) return

        const job = toJob(next)
        statements.updateJobStart.run(now(), job.id)
        activeJobs += 1

        void workerRunner(job, {
          getRepo: async (repoId) => {
            const row = statements.getRepoById.get(repoId) as Record<string, unknown> | undefined
            if (!row) throw new Error(`Repo ${repoId} not found.`)
            return toRepo(row)
          },
          appendEvent,
          pluginPaths,
        })
          .then(async (result) => {
            const status = result.success ? 'completed' : 'failed'
            statements.updateJobFinish.run(status, now(), JSON.stringify(result), job.id)
            await appendEvent({
              jobId: job.id,
              phase: 'worker',
              level: result.success ? 'info' : 'error',
              message: result.summary,
            })
          })
          .catch(async (error) => {
            const message = error instanceof Error ? error.message : String(error)
            statements.updateJobFinish.run(
              'failed',
              now(),
              JSON.stringify({
                jobId: job.id,
                repoId: job.repoId,
                type: job.type,
                success: false,
                summary: message,
              } satisfies JobResult),
              job.id,
            )
            await appendEvent({
              jobId: job.id,
              phase: 'worker',
              level: 'error',
              message,
            })
          })
          .finally(() => {
            activeJobs = Math.max(0, activeJobs - 1)
            void processNextJob()
          })
      }
    } finally {
      draining = false
    }
  }

  async function waitForJobCompletion(jobId: string): Promise<{ job: Job; result?: JobResult }> {
    for (;;) {
      const record = getJobRecord(jobId)
      if (!record) {
        throw new Error(`Job ${jobId} not found.`)
      }
      if (['completed', 'failed'].includes(record.job.status)) {
        return {
          job: record.job,
          ...(record.result ? { result: record.result } : {}),
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  }

  async function inspectGitState(repo: RepoRef): Promise<{
    summary: string
    state: Record<string, unknown>
    blockedReason?: string
  }> {
    const git = simpleGit(repo.rootPath)
    await git.fetch(['origin', repo.defaultBranch]).catch(() => undefined)
    const status = await git.status().catch(() => undefined)
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => repo.defaultBranch)
    const upstream = await git
      .revparse(['--abbrev-ref', '--symbolic-full-name', '@{u}'])
      .catch(() => undefined)
    const userName = await git.raw(['config', '--get', 'user.name']).catch(() => '')
    const userEmail = await git.raw(['config', '--get', 'user.email']).catch(() => '')
    const blockedReason =
      !userName.trim() || !userEmail.trim()
        ? 'Git commit identity eksik. Fix veya autopilot icin user.name ve user.email ayarlanmis olmali.'
        : undefined

    return {
      summary: [
        `Branch: ${branch.trim()}`,
        `Dirty: ${status ? String(!status.isClean()) : 'unknown'}`,
        `Upstream: ${upstream?.trim() || 'none'}`,
        blockedReason ?? 'Git durumu guvenli sekilde incelendi ve fetch denemesi yapildi.',
      ].join(' | '),
      state: {
        branch: branch.trim(),
        dirty: status ? !status.isClean() : undefined,
        upstream: upstream?.trim() || null,
        hasCommitIdentity: Boolean(userName.trim() && userEmail.trim()),
      },
      ...(blockedReason ? { blockedReason } : {}),
    }
  }

  function reserveWorker(mode: Task['mode']): WorkerInfo | undefined {
    const worker = workers.find((candidate) => candidate.status === 'idle')
    if (!worker) return undefined
    worker.status = 'busy'
    worker.kind = workerKindForMode(mode)
    worker.lastHeartbeat = now()
    worker.lastError = undefined
    return worker
  }

  function releaseWorker(workerId: string, lastError?: string): void {
    const worker = workers.find((candidate) => candidate.id === workerId)
    if (!worker) return
    worker.status = 'idle'
    worker.currentTaskId = undefined
    worker.currentStepId = undefined
    worker.repoId = undefined
    worker.lastHeartbeat = now()
    worker.kind = 'background-worker'
    worker.lastError = lastError
  }

  async function runTaskStep(task: Task, step: TaskStep, worker: WorkerInfo): Promise<Task> {
    const repoRow = task.repoId
      ? (statements.getRepoById.get(task.repoId) as Record<string, unknown> | undefined)
      : undefined
    const repo = repoRow ? toRepo(repoRow) : undefined
    const taskRecord = getTaskRecord(task.id)
    const liveTask = taskRecord?.task ?? task
    const startedAt = now()
    worker.currentTaskId = liveTask.id
    worker.currentStepId = step.id
    worker.repoId = liveTask.repoId
    worker.lastHeartbeat = startedAt
    statements.updateTaskStep.run('running', null, startedAt, null, step.id)
    liveTask.status = 'running'
    liveTask.activeWorkerId = worker.id
    liveTask.plan.currentStepId = step.id
    liveTask.updatedAt = startedAt
    persistTask(liveTask)
    await appendTaskEvent({
      taskId: liveTask.id,
      phase: step.tool,
      level: 'info',
      message: step.title,
    })

    let outputSummary = ''
    if (!repo) {
      throw new Error(`Task ${liveTask.id} is missing repo binding.`)
    }

    if (step.tool === 'inspect_git_state') {
      const gitState = await inspectGitState(repo)
      liveTask.memory = {
        ...(liveTask.memory ?? { lastUpdatedAt: now() }),
        gitState: gitState.state,
        lastUpdatedAt: now(),
      }
      liveTask.latestSummary = gitState.summary
      if (gitState.blockedReason && liveTask.mode !== 'analyze') {
        liveTask.status = 'blocked'
        liveTask.blockedReason = gitState.blockedReason
      }
      outputSummary = gitState.summary
    } else if (step.tool === 'doctor_inspect') {
      const job = await enqueueJob('doctor', repo.id, {})
      const completed = await waitForJobCompletion(job.id)
      const report = completed.result?.report
      outputSummary =
        completed.result?.summary ?? `Doctor inspection finished for ${repo.rootPath}.`
      liveTask.memory = {
        ...(liveTask.memory ?? { lastUpdatedAt: now() }),
        doctorSummary: outputSummary,
        repoSummary:
          report && 'summary' in report.observation
            ? JSON.stringify(report.observation.summary)
            : liveTask.memory?.repoSummary,
        lastUpdatedAt: now(),
      }
      liveTask.latestSummary = outputSummary
      if (completed.job.status === 'failed') {
        liveTask.status = 'failed'
      }
    } else if (step.tool === 'run_loop_fix') {
      const workspaceSession = getWorkspaceSession(liveTask.sessionId)
      const job = await enqueueJob('loop', repo.id, {
        rounds: liveTask.mode === 'autopilot' ? 2 : 1,
        ...(workspaceSession?.workerSurface
          ? { executionSurface: workspaceSession.workerSurface }
          : liveTask.artifacts?.executionSurface
            ? { executionSurface: liveTask.artifacts.executionSurface }
            : {}),
        ...(workspaceSession?.id ? { sessionId: workspaceSession.id } : {}),
        ...(step.input && typeof step.input.milestoneTarget === 'string'
          ? { milestoneTarget: step.input.milestoneTarget }
          : liveTask.artifacts?.milestoneTarget
            ? { milestoneTarget: liveTask.artifacts.milestoneTarget }
            : {}),
        ...(liveTask.goal ? { goal: liveTask.goal } : {}),
        ...(liveTask.plan.successCriteria
          ? { successCriteria: liveTask.plan.successCriteria }
          : {}),
      })
      const completed = await waitForJobCompletion(job.id)
      outputSummary = completed.result?.summary ?? 'Loop fix cycle finished.'
      liveTask.memory = {
        ...(liveTask.memory ?? { lastUpdatedAt: now() }),
        loopSummary: outputSummary,
        lastUpdatedAt: now(),
      }
      liveTask.latestSummary = outputSummary
      if (completed.result?.experiment) {
        liveTask.artifacts = {
          ...(completed.result.review?.decision
            ? { reviewDecision: completed.result.review.decision }
            : {}),
          ...(completed.result.review?.outcome
            ? { reviewOutcome: completed.result.review.outcome }
            : {}),
          ...(liveTask.artifacts?.executionSurface
            ? { executionSurface: liveTask.artifacts.executionSurface }
            : workspaceSession?.workerSurface
              ? { executionSurface: workspaceSession.workerSurface }
              : {}),
          ...(completed.result.review?.milestone
            ? { milestoneTarget: completed.result.review.milestone }
            : liveTask.artifacts?.milestoneTarget
              ? { milestoneTarget: liveTask.artifacts.milestoneTarget }
              : {}),
          ...(completed.result.experiment.patchArtifactPath
            ? { patchArtifactPath: completed.result.experiment.patchArtifactPath }
            : {}),
          ...(completed.result.experiment.worktreePath
            ? { worktreePath: completed.result.experiment.worktreePath }
            : {}),
          ...(completed.result.experiment.branchName
            ? { branchName: completed.result.experiment.branchName }
            : {}),
          ...(completed.result.experiment.commitHash
            ? { commitHash: completed.result.experiment.commitHash }
            : {}),
        }
      }
      if (completed.job.status === 'failed') {
        liveTask.status = 'failed'
      }
      if (workspaceSession) {
        const managedRepos = workspaceSession.managedRepos.map((managedRepo) =>
          managedRepo.repoId === repo.id
            ? {
                ...managedRepo,
                status: (
                  completed.result?.review?.decision === 'needs-human-approval'
                    ? 'reviewing'
                    : completed.result?.review?.decision === 'revise'
                      ? 'active'
                      : completed.job.status === 'failed'
                        ? 'blocked'
                        : 'idle'
                ) as ManagedRepoState['status'],
                lastMilestone: completed.result?.review?.milestone ?? managedRepo.lastMilestone,
                lastReviewOutcome:
                  completed.result?.review?.outcome ?? managedRepo.lastReviewOutcome,
                lastReviewDecision:
                  completed.result?.review?.decision ?? managedRepo.lastReviewDecision,
                updatedAt: now(),
              }
            : managedRepo,
        )
        persistWorkspaceSession({
          ...workspaceSession,
          managedRepos,
          activeTaskId: liveTask.id,
          activeWorkerId: worker.id,
          focusRepoId: repo.id,
          latestSummary: outputSummary,
          lastReviewDecision:
            completed.result?.review?.decision ?? workspaceSession.lastReviewDecision,
          updatedAt: now(),
        })
      }
    }

    const finishedAt = now()
    statements.updateTaskStep.run(
      liveTask.status === 'blocked'
        ? 'blocked'
        : liveTask.status === 'failed'
          ? 'failed'
          : 'completed',
      outputSummary || null,
      startedAt,
      finishedAt,
      step.id,
    )
    liveTask.checkpoint = {
      currentPhase: step.tool,
      cycleCount: liveTask.checkpoint?.cycleCount ?? 0,
      lastCompletedStepId: step.id,
      summary: outputSummary,
      updatedAt: finishedAt,
    }
    liveTask.updatedAt = finishedAt
    persistTask(liveTask)
    await appendTaskEvent({
      taskId: liveTask.id,
      phase: 'replanned',
      level: 'info',
      message:
        liveTask.mode === 'autopilot'
          ? 'Autopilot adimi tamamlandi, bir sonraki adim icin plan tazelendi.'
          : `Adim tamamlandi: ${step.tool}.`,
      data: { stepId: step.id },
    })
    return liveTask
  }

  async function processNextTask(): Promise<void> {
    if (config.embeddedWorker === false) return
    if (drainingTasks) return
    drainingTasks = true
    try {
      while (workers.some((worker) => worker.status === 'idle')) {
        const next = statements.nextTask.get() as Record<string, unknown> | undefined
        if (!next) return
        const task = toTask(next)
        const worker = reserveWorker(task.mode)
        if (!worker) return

        try {
          const steps = (statements.listTaskSteps.all(task.id) as Record<string, unknown>[]).map(
            toTaskStep,
          )
          let liveTask = task
          for (const step of steps) {
            if (step.status !== 'pending') continue
            if (['failed', 'blocked', 'canceled'].includes(liveTask.status)) break
            liveTask = await runTaskStep(liveTask, step, worker)
          }
          if (!['failed', 'blocked', 'canceled'].includes(liveTask.status)) {
            liveTask.status = 'completed'
            liveTask.updatedAt = now()
            persistTask(liveTask)
            await appendTaskEvent({
              taskId: liveTask.id,
              phase: 'task',
              level: 'info',
              message: liveTask.latestSummary ?? `${liveTask.mode} task completed.`,
            })
          }
          const workspaceSession = getWorkspaceSession(liveTask.sessionId)
          if (workspaceSession) {
            persistWorkspaceSession({
              ...workspaceSession,
              activeTaskId: ['completed', 'failed', 'blocked', 'canceled'].includes(liveTask.status)
                ? undefined
                : liveTask.id,
              activeWorkerId: undefined,
              latestSummary: liveTask.latestSummary ?? workspaceSession.latestSummary,
              updatedAt: now(),
            })
          }
          releaseWorker(worker.id)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const liveTask = getTaskRecord(task.id)?.task ?? task
          liveTask.status = 'failed'
          liveTask.latestSummary = message
          liveTask.updatedAt = now()
          persistTask(liveTask)
          await appendTaskEvent({
            taskId: liveTask.id,
            phase: 'task',
            level: 'error',
            message,
          })
          const workspaceSession = getWorkspaceSession(liveTask.sessionId)
          if (workspaceSession) {
            persistWorkspaceSession({
              ...workspaceSession,
              activeTaskId: undefined,
              activeWorkerId: undefined,
              latestSummary: message,
              updatedAt: now(),
            })
          }
          releaseWorker(worker.id, message)
        }
      }
    } finally {
      drainingTasks = false
    }
  }

  async function waitForIdle(timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now()
    for (;;) {
      const queued = statements.countQueuedJobs.get() as { count: number }
      const queuedTasks = statements.countQueuedTasks.get() as { count: number }
      if (
        queued.count === 0 &&
        activeJobs === 0 &&
        queuedTasks.count === 0 &&
        workers.every((worker) => worker.status === 'idle')
      ) {
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
  }

  async function proxyJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, init)
    if (!response.ok) {
      const body = (await response.text().catch(() => '')) || response.statusText
      throw new Error(body)
    }
    return (await response.json()) as T
  }

  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8')

    const send = (statusCode: number, payload: unknown) => {
      response.writeHead(statusCode)
      response.end(JSON.stringify(payload))
    }

    if (request.method === 'GET' && request.url === '/health') {
      const queued = statements.countQueuedJobs.get() as { count: number }
      const queuedTasks = statements.countQueuedTasks.get() as { count: number }
      send(200, {
        status: 'ok',
        package: orchestratorPackage.name,
        mode: orchestratorPackage.status,
        queuedJobs: queued.count,
        queuedTasks: queuedTasks.count,
        activeJobs,
        maxConcurrentJobs,
      })
      return
    }

    if (request.method === 'GET' && request.url === '/repos') {
      send(200, listRepos())
      return
    }

    if (request.method === 'GET' && request.url === '/jobs') {
      send(200, listJobs())
      return
    }

    if (request.method === 'GET' && request.url === '/tasks') {
      send(200, listTasks())
      return
    }

    if (request.method === 'GET' && request.url === '/missions') {
      try {
        send(200, await proxyJson<Mission[]>(controlPlaneUrl, '/missions'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (request.method === 'GET' && request.url === '/approvals') {
      try {
        send(200, await proxyJson<ApprovalQueueItem[]>(controlPlaneUrl, '/approvals'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (request.method === 'GET' && request.url === '/repo-profiles') {
      try {
        send(200, await proxyJson<RepoExecutionProfile[]>(controlPlaneUrl, '/repo-profiles'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (request.method === 'GET' && request.url === '/workers') {
      send(200, listWorkers())
      return
    }

    if (request.method === 'GET' && request.url === '/sessions') {
      send(200, listSessions())
      return
    }

    if (request.method === 'GET' && request.url?.startsWith('/sessions/')) {
      const parts = request.url.split('/').filter(Boolean)
      if (parts.length === 2) {
        const session = getWorkspaceSession(parts[1] ?? '')
        if (!session) {
          send(404, { error: 'Session not found.' })
          return
        }
        send(200, session)
        return
      }
    }

    if (request.method === 'GET' && request.url === '/dashboard') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(renderDashboardHtml())
      return
    }

    if (request.method === 'GET' && request.url === '/docker/containers') {
      try {
        send(200, await listDockerContainers(dockerExec))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(500, { error: message })
      }
      return
    }

    if (request.method === 'POST' && request.url === '/repos') {
      const body = await readJSONBody(request)
      const repo = await detectRepo(String(body.path))
      send(201, repo)
      return
    }

    if (request.method === 'POST' && /^\/threads\/[^/]+\/messages$/.test(request.url ?? '')) {
      if (!chatGatewayUrl) {
        send(503, { error: 'Chat gateway is not configured.' })
        return
      }
      try {
        const body = await readJSONBody(request)
        const threadId = decodeURIComponent(request.url?.split('/')[2] ?? '')
        const result = await proxyJson<{ reply: string; mission?: Mission | undefined }>(
          chatGatewayUrl,
          `/threads/${encodeURIComponent(threadId)}/messages`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        )
        send(200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (request.method === 'GET' && /^\/threads\/[^/]+$/.test(request.url ?? '')) {
      if (!chatGatewayUrl) {
        send(503, { error: 'Chat gateway is not configured.' })
        return
      }
      try {
        const threadId = decodeURIComponent(request.url?.split('/')[2] ?? '')
        const result = await proxyJson<{ threadId: string; messages: unknown[] }>(
          chatGatewayUrl,
          `/threads/${encodeURIComponent(threadId)}`,
        )
        send(200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (request.method === 'POST' && request.url === '/jobs/doctor') {
      const body = await readJSONBody(request)
      const payload: DoctorJobPayload = {}
      if (body.provider) payload.provider = String(body.provider)
      if (body.model) payload.model = String(body.model)
      const job = await enqueueJob('doctor', String(body.repoId), payload)
      send(202, job)
      return
    }

    if (request.method === 'POST' && request.url === '/jobs/loop') {
      const body = await readJSONBody(request)
      const payload: LoopJobPayload = {
        rounds: body.rounds ? Number(body.rounds) : 1,
      }
      if (body.provider) payload.provider = String(body.provider)
      if (body.model) payload.model = String(body.model)
      if (body.dryRun) payload.dryRun = Boolean(body.dryRun)
      if (body.goal) payload.goal = String(body.goal)
      if (body.planExcerpt) payload.planExcerpt = String(body.planExcerpt)
      if (body.sessionId) payload.sessionId = String(body.sessionId)
      if (body.managedRepoId) payload.managedRepoId = String(body.managedRepoId)
      if (body.milestoneTarget) payload.milestoneTarget = String(body.milestoneTarget)
      if (
        body.executionSurface === 'aider' ||
        body.executionSurface === 'roo' ||
        body.executionSurface === 'openclaw'
      ) {
        const executionSurface = body.executionSurface as LoopJobPayload['executionSurface']
        if (executionSurface) {
          payload.executionSurface = executionSurface
        }
      }
      if (body.successCriteria) payload.successCriteria = String(body.successCriteria)
      const job = await enqueueJob('loop', String(body.repoId), payload)
      send(202, job)
      return
    }

    if (request.method === 'POST' && request.url === '/tasks') {
      const body = await readJSONBody(request)
      const task = await createTask({
        goal: String(body.goal ?? ''),
        mode: (body.mode as Task['mode']) ?? 'analyze',
        sessionId: String(body.sessionId ?? 'local'),
        ...(body.repoId ? { repoId: String(body.repoId) } : {}),
        ...(body.provider ? { provider: String(body.provider) } : {}),
        ...(body.model ? { model: String(body.model) } : {}),
        ...(body.workerSurface ? { workerSurface: body.workerSurface as TaskCreateInput['workerSurface'] } : {}),
        ...(body.managedRepoId ? { managedRepoId: String(body.managedRepoId) } : {}),
        ...(body.milestoneTarget ? { milestoneTarget: String(body.milestoneTarget) } : {}),
        ...(body.successCriteria ? { successCriteria: String(body.successCriteria) } : {}),
        ...(body.maxCycles ? { maxCycles: Number(body.maxCycles) } : {}),
      })
      send(202, task)
      return
    }

    if (request.method === 'POST' && request.url === '/missions') {
      try {
        const body = await readJSONBody(request)
        send(
          201,
          await proxyJson<Mission>(controlPlaneUrl, '/missions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (request.method === 'POST' && request.url?.startsWith('/repo-profiles/')) {
      const repoId = request.url.split('/')[2] ?? ''
      try {
        const body = await readJSONBody(request)
        send(
          200,
          await proxyJson<RepoExecutionProfile>(controlPlaneUrl, `/repo-profiles/${repoId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (request.method === 'POST' && request.url === '/sessions') {
      const body = await readJSONBody(request)
      const session = await createWorkspaceSession({
        ...(body.id ? { id: String(body.id) } : {}),
        goal: String(body.goal ?? 'Workspace autopilot'),
        ...(body.workerSurface ? { workerSurface: body.workerSurface as WorkspaceSession['workerSurface'] } : {}),
        ...(Array.isArray(body.controlSurfaces)
          ? { controlSurfaces: body.controlSurfaces as WorkspaceSession['controlSurfaces'] }
          : {}),
        ...(body.successCriteria ? { successCriteria: String(body.successCriteria) } : {}),
        ...(Array.isArray(body.repoRoots)
          ? { repoRoots: body.repoRoots.map((value) => String(value)) }
          : {}),
      })
      send(201, session)
      return
    }

    if (request.method === 'POST' && request.url?.startsWith('/sessions/')) {
      const parts = request.url.split('/').filter(Boolean)
      const sessionId = parts[1] ?? ''
      const action = parts[2] ?? ''
      const session = getWorkspaceSession(sessionId)
      if (!session) {
        send(404, { error: 'Session not found.' })
        return
      }

      if (action === 'discover') {
        const updated = await discoverReposForSession(session)
        send(200, updated)
        return
      }

      if (action === 'autopilot') {
        const body = await readJSONBody(request)
        const chosenRepo =
          session.managedRepos.find((repo) => repo.repoId === session.focusRepoId) ??
          session.managedRepos[0]
        if (!chosenRepo) {
          send(409, { error: 'No managed repo is available. Discover repos first.' })
          return
        }
        const task = await createTask({
          goal: String(body.goal ?? session.goal),
          mode: 'autopilot',
          sessionId: session.id,
          repoId: chosenRepo.repoId,
          workerSurface: session.workerSurface,
          managedRepoId: chosenRepo.repoId,
          milestoneTarget: String(body.milestoneTarget ?? 'review-required'),
          successCriteria: String(body.successCriteria ?? session.successCriteria ?? session.goal),
          maxCycles: body.maxCycles ? Number(body.maxCycles) : 8,
        })
        persistWorkspaceSession({
          ...session,
          activeTaskId: task.id,
          focusRepoId: chosenRepo.repoId,
          latestSummary: `Autopilot queued for ${chosenRepo.rootPath}.`,
          updatedAt: now(),
        })
        send(202, task)
        return
      }

      if (action === 'review') {
        const body = await readJSONBody(request)
        const chosenRepo =
          session.managedRepos.find((repo) => repo.repoId === session.focusRepoId) ??
          session.managedRepos[0]
        if (!chosenRepo) {
          send(409, { error: 'No managed repo is available. Discover repos first.' })
          return
        }
        const job = await enqueueJob('loop', chosenRepo.repoId, {
          rounds: 1,
          sessionId: session.id,
          managedRepoId: chosenRepo.repoId,
          executionSurface: session.workerSurface,
          goal: body.goal ? String(body.goal) : session.goal,
          milestoneTarget: String(body.milestoneTarget ?? 'review-required'),
          ...(body.successCriteria
            ? { successCriteria: String(body.successCriteria) }
            : session.successCriteria
              ? { successCriteria: session.successCriteria }
              : {}),
        })
        send(202, job)
        return
      }

      if (action === 'control') {
        const body = await readJSONBody(request)
        const command = String(body.action ?? '')
        const nextSession: WorkspaceSession = {
          ...session,
          status:
            command === 'pause'
              ? 'paused'
              : command === 'resume'
                ? 'active'
                : command === 'complete'
                  ? 'completed'
                  : session.status,
          focusRepoId: body.focusRepoId ? String(body.focusRepoId) : session.focusRepoId,
          latestSummary: body.summary ? String(body.summary) : session.latestSummary,
          updatedAt: now(),
        }
        persistWorkspaceSession(nextSession)
        send(200, nextSession)
        return
      }
    }

    if (request.method === 'GET' && request.url?.startsWith('/jobs/')) {
      const jobId = request.url.slice('/jobs/'.length)
      const job = getJobRecord(jobId)
      if (!job) {
        send(404, { error: 'Job not found.' })
        return
      }
      send(200, job)
      return
    }

    if (request.method === 'GET' && request.url?.startsWith('/missions/')) {
      const missionPath = request.url.slice('/missions/'.length)
      try {
        if (missionPath.endsWith('/events')) {
          const missionId = missionPath.slice(0, -'/events'.length)
          send(
            200,
            await proxyJson<MissionEvent[]>(controlPlaneUrl, `/missions/${missionId}/events`),
          )
          return
        }
        if (missionPath.endsWith('/steps')) {
          const missionId = missionPath.slice(0, -'/steps'.length)
          send(200, await proxyJson<Record<string, unknown>[]>(controlPlaneUrl, `/missions/${missionId}/steps`))
          return
        }
        if (missionPath.endsWith('/checkpoints')) {
          const missionId = missionPath.slice(0, -'/checkpoints'.length)
          send(
            200,
            await proxyJson<Record<string, unknown>[]>(
              controlPlaneUrl,
              `/missions/${missionId}/checkpoints`,
            ),
          )
          return
        }
        send(200, await proxyJson<Mission>(controlPlaneUrl, `/missions/${missionPath}/state`))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (request.method === 'GET' && request.url?.startsWith('/repo-profiles/')) {
      const repoId = request.url.split('/')[2] ?? ''
      try {
        send(
          200,
          await proxyJson<RepoExecutionProfile>(controlPlaneUrl, `/repo-profiles/${repoId}`),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (request.method === 'GET' && request.url?.startsWith('/tasks/')) {
      const taskPath = request.url.slice('/tasks/'.length)
      if (taskPath.endsWith('/events')) {
        const taskId = taskPath.slice(0, -'/events'.length)
        const task = getTaskRecord(taskId)
        if (!task) {
          send(404, { error: 'Task not found.' })
          return
        }
        send(200, task.events)
        return
      }
      const task = getTaskRecord(taskPath)
      if (!task) {
        send(404, { error: 'Task not found.' })
        return
      }
      send(200, task)
      return
    }

    if (
      request.method === 'POST' &&
      request.url?.startsWith('/missions/') &&
      request.url.endsWith('/control')
    ) {
      const missionId = request.url.split('/')[2] ?? ''
      try {
        const body = await readJSONBody(request)
        send(
          200,
          await proxyJson<Mission>(controlPlaneUrl, `/missions/${missionId}/commands`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (
      request.method === 'POST' &&
      request.url?.startsWith('/approvals/') &&
      request.url.endsWith('/approve')
    ) {
      const missionId = request.url.split('/')[2] ?? ''
      try {
        const body = await readJSONBody(request)
        send(
          200,
          await proxyJson<Mission>(controlPlaneUrl, `/approvals/${missionId}/approve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(502, { error: message })
      }
      return
    }

    if (
      request.method === 'POST' &&
      request.url?.startsWith('/tasks/') &&
      ['/pause', '/resume', '/cancel'].some((suffix) => request.url?.endsWith(suffix))
    ) {
      const action = request.url.split('/').at(-1)
      const taskId = request.url.split('/')[2] ?? ''
      const taskRecord = getTaskRecord(taskId)
      if (!taskRecord) {
        send(404, { error: 'Task not found.' })
        return
      }
      const task = taskRecord.task
      if (action === 'pause' && task.status === 'running') {
        task.status = 'paused'
      } else if (action === 'resume' && ['paused', 'blocked'].includes(task.status)) {
        task.status = 'queued'
        task.blockedReason = undefined
      } else if (action === 'cancel') {
        task.status = 'canceled'
      }
      task.updatedAt = now()
      persistTask(task)
      await appendTaskEvent({
        taskId: task.id,
        phase: 'task',
        level: 'info',
        message: `Task ${action} requested.`,
      })
      if (task.status === 'queued') {
        void processNextTask()
      }
      send(202, task)
      return
    }

    if (
      request.method === 'POST' &&
      [
        '/docker/containers/start',
        '/docker/containers/stop',
        '/docker/containers/restart',
        '/docker/containers/remove',
      ].includes(request.url ?? '')
    ) {
      const body = await readJSONBody(request)
      const idOrName = String(body.idOrName ?? '').trim()
      if (!idOrName) {
        send(400, { error: 'Missing idOrName.' })
        return
      }
      const action = request.url?.split('/').at(-1)
      if (action !== 'start' && action !== 'stop' && action !== 'restart' && action !== 'remove') {
        send(400, { error: 'Unsupported docker action.' })
        return
      }
      try {
        send(202, await runDockerContainerAction(action, idOrName, dockerExec))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(500, { error: message })
      }
      return
    }

    send(404, { error: 'Not found.' })
  })

  return {
    config: {
      host: config.host ?? getDefaultHost(),
      port: config.port ?? DEFAULT_PORT,
      dataDir,
      embeddedWorker: config.embeddedWorker ?? true,
      pluginPaths,
      maxConcurrentJobs,
    },
    server,
    start(): Promise<void> {
      return new Promise((resolvePromise) => {
        server.listen(this.config.port, this.config.host, () => resolvePromise())
      })
    },
    stop(): Promise<void> {
      return waitForIdle().then(
        () =>
          new Promise((resolvePromise, reject) => {
            server.close((error) => {
              if (error) {
                reject(error)
                return
              }
              resolvePromise()
            })
          }),
      )
    },
    url(): string {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : this.config.port
      return `http://${this.config.host}:${port}`
    },
    registerRepo: detectRepo,
    listRepos,
    listJobs,
    listTasks,
    listWorkers,
    listSessions,
    enqueueJob,
    createTask,
    getJobRecord,
    getTaskRecord,
    processNextJob,
    processNextTask,
    waitForIdle,
  }
}

export function startOrchestratorStub(port = DEFAULT_PORT) {
  const daemon = createDaemon({ port })
  void daemon.start().then(() => {
    console.log(`${orchestratorPackage.message} Listening on ${daemon.url()}`)
  })
  return daemon.server
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>coco monitor</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1311;
        --panel: #12201c;
        --line: #27453b;
        --fg: #e8fff4;
        --muted: #8bb5a5;
        --accent: #67f7b1;
      }
      body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: radial-gradient(circle at top, #163126, var(--bg)); color: var(--fg); }
      main { max-width: 1200px; margin: 0 auto; padding: 24px; }
      h1 { margin: 0 0 20px; font-size: 28px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(280px,1fr)); gap: 16px; }
      .panel { background: rgba(18,32,28,.92); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
      .muted { color: var(--muted); }
      ul { padding-left: 18px; }
      code { color: var(--accent); }
    </style>
  </head>
  <body>
    <main>
      <h1>coco monitor</h1>
      <div class="grid">
        <section class="panel"><h2>Tasks</h2><ul id="tasks"></ul></section>
        <section class="panel"><h2>Workers</h2><ul id="workers"></ul></section>
        <section class="panel"><h2>Sessions</h2><ul id="sessions"></ul></section>
      </div>
      <p class="muted">Auto-refreshes every 3 seconds.</p>
    </main>
    <script>
      const renderList = (id, rows) => {
        const node = document.getElementById(id)
        node.innerHTML = rows.length ? rows.map((row) => '<li>' + row + '</li>').join('') : '<li class="muted">No data</li>'
      }
      async function refresh() {
        const [tasks, workers, sessions] = await Promise.all([
          fetch('/tasks').then((res) => res.json()),
          fetch('/workers').then((res) => res.json()),
          fetch('/sessions').then((res) => res.json()),
        ])
        renderList('tasks', tasks.map((task) => '<code>' + task.mode + '</code> · ' + task.status + ' · ' + (task.latestSummary || task.goal)))
        renderList('workers', workers.map((worker) => '<code>' + worker.kind + '</code> · ' + worker.status + (worker.currentTaskId ? ' · task ' + worker.currentTaskId : '')))
        renderList('sessions', sessions.map((session) => '<code>' + session.id + '</code> · tasks: ' + session.taskCount + (session.activeTaskId ? ' · active ' + session.activeTaskId : '')))
      }
      refresh()
      setInterval(refresh, 3000)
    </script>
  </body>
</html>`
}

function detectLanguageHints(rootPath: string): string[] {
  const hints = new Set<string>()
  for (const candidate of ['package.json', 'tsconfig.json', 'Dockerfile', 'docker']) {
    const path = join(rootPath, candidate)
    if (!candidate.includes('.') && !path.endsWith('Dockerfile')) {
      if (candidate === 'docker') {
        if (existsDir(path)) hints.add('docker')
      }
      continue
    }
    if (existsSync(path)) {
      if (candidate === 'Dockerfile') hints.add('docker')
      if (candidate === 'package.json') hints.add('js')
      if (candidate === 'tsconfig.json') hints.add('ts')
    }
  }
  return [...hints]
}

function existsDir(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

async function readJSONBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false
}

if (isDirectExecution()) {
  const daemon = createDaemon()
  void daemon.start().then(() => {
    console.log(`${orchestratorPackage.message} Listening on ${daemon.url()}`)
  })
  const shutdown = () => {
    void daemon.stop().then(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
