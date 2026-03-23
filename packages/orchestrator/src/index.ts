import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
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
  RepoRef,
} from '@coco/core'
import { runJob } from '@coco/worker'
import { simpleGit } from 'simple-git'

const DEFAULT_PORT = Number(process.env.PORT ?? 3000)
const DEFAULT_HOST = '127.0.0.1'
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
}

function getDefaultDataDir(): string {
  return process.env.COCO_HOME ?? join(homedir(), '.local', 'share', 'coco')
}

function now(): string {
  return new Date().toISOString()
}

function ensureDataDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

function parseJSON<T>(value: string | null): T | undefined {
  return value ? (JSON.parse(value) as T) : undefined
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
    UPDATE jobs SET status = 'retryable' WHERE status = 'running';
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
  }

  let processing = false

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
    return repo
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
    if (processing || config.embeddedWorker === false) return
    const next = statements.nextJob.get() as Record<string, unknown> | undefined
    if (!next) return

    processing = true
    const job = toJob(next)
    statements.updateJobStart.run(now(), job.id)
    try {
      const result = await runJob(job, {
        getRepo: async (repoId) => {
          const row = statements.getRepoById.get(repoId) as Record<string, unknown> | undefined
          if (!row) throw new Error(`Repo ${repoId} not found.`)
          return toRepo(row)
        },
        appendEvent,
        pluginPaths,
      })
      const status = result.success ? 'completed' : 'failed'
      statements.updateJobFinish.run(status, now(), JSON.stringify(result), job.id)
      await appendEvent({
        jobId: job.id,
        phase: 'worker',
        level: result.success ? 'info' : 'error',
        message: result.summary,
      })
    } catch (error) {
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
    } finally {
      processing = false
      void processNextJob()
    }
  }

  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8')

    const send = (statusCode: number, payload: unknown) => {
      response.writeHead(statusCode)
      response.end(JSON.stringify(payload))
    }

    if (request.method === 'GET' && request.url === '/health') {
      const queued = statements.countQueuedJobs.get() as { count: number }
      send(200, {
        status: 'ok',
        package: orchestratorPackage.name,
        mode: orchestratorPackage.status,
        queuedJobs: queued.count,
      })
      return
    }

    if (request.method === 'GET' && request.url === '/repos') {
      send(200, listRepos())
      return
    }

    if (request.method === 'POST' && request.url === '/repos') {
      const body = await readJSONBody(request)
      const repo = await detectRepo(String(body.path))
      send(201, repo)
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
      const job = await enqueueJob('loop', String(body.repoId), payload)
      send(202, job)
      return
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

    send(404, { error: 'Not found.' })
  })

  return {
    config: {
      host: config.host ?? DEFAULT_HOST,
      port: config.port ?? DEFAULT_PORT,
      dataDir,
      embeddedWorker: config.embeddedWorker ?? true,
      pluginPaths,
    },
    server,
    start(): Promise<void> {
      return new Promise((resolvePromise) => {
        server.listen(this.config.port, this.config.host, () => resolvePromise())
      })
    },
    stop(): Promise<void> {
      return new Promise((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolvePromise()
        })
      })
    },
    url(): string {
      return `http://${this.config.host}:${this.config.port}`
    },
    registerRepo: detectRepo,
    listRepos,
    enqueueJob,
    getJobRecord,
    processNextJob,
  }
}

export function startOrchestratorStub(port = DEFAULT_PORT) {
  const daemon = createDaemon({ port })
  void daemon.start().then(() => {
    console.log(`${orchestratorPackage.message} Listening on ${daemon.url()}`)
  })
  return daemon.server
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
