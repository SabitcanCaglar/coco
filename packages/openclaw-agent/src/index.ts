import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { LLMRegistry } from '@coco/llm'

export interface ChatSession {
  activeRepoId?: string
  activeRepoPath?: string
  provider?: string
  model?: string
  pendingJobs?: {
    id: string
    type: 'doctor' | 'loop'
    repoPath?: string
    userIntent?: string
    notified?: boolean
  }[]
  autopilot?: {
    enabled: boolean
    goal: string
    taskScope?: 'short' | 'long'
    plan?: string[]
    successCriteria?: string
    roundsPerJob: number
    maxCycles: number
    completedCycles: number
    currentJobId?: string
    lastNotifiedJobId?: string
    lastSummary?: string
    usePlanMd?: boolean
  }
}

export type SessionState = Record<string, ChatSession>

export interface OpenClawAgentConfig {
  daemonUrl?: string
  planner?: (inputText: string, session: ChatSession) => Promise<PlannerDecision | undefined>
}

export interface PlannerDecision {
  reply: string
  provider?: string
  model?: string
  selectRepoHint?: string
  registerPath?: string
  queue?:
    | 'none'
    | 'doctor'
    | 'loop'
    | 'fanout'
    | 'repos'
    | 'jobs'
    | 'session'
    | 'docker'
    | 'desktop'
  fanoutRepoHints?: string[]
  dockerAction?: 'list' | 'start' | 'stop' | 'restart' | 'remove'
  dockerTargetHint?: string
  taskScope?: 'short' | 'long'
  plan?: string[]
  successCriteria?: string
  autopilot?: {
    enabled: boolean
    goal: string
    taskScope?: 'short' | 'long'
    plan?: string[]
    successCriteria?: string
    roundsPerJob?: number
    maxCycles?: number
    usePlanMd?: boolean
  }
}

interface RepoRecord {
  id: string
  rootPath: string
}

interface JobListEntry {
  job: {
    id: string
    type: string
    status: string
    repoId: string
  }
}

interface JobRecord {
  job?: {
    id?: string
    type?: string
    status?: string
    repoId?: string
  }
  result?: {
    success?: boolean
    summary?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface DockerContainerRecord {
  id: string
  name: string
  image: string
  state: string
  status: string
}

interface DesktopProjectRecord {
  name: string
  path: string
  hints: string[]
}

export function renderOpenClawHelp(): string {
  return [
    'OpenClaw remote mode',
    'Transport surfaces only forward messages. OpenClaw is the first agent that reads and acts.',
    '',
    'Fallback slash commands:',
    '/help - show this help',
    '/repos - list registered repos',
    '/repoadd <absolute-path> - register a repo on this machine',
    '/use <repo-id-or-name> - set the active repo for this session',
    '/doctor [repo-id-or-name] - queue a doctor job',
    '/loop [repo-id-or-name] - queue a loop job for the active repo',
    '/fanout <repo-id-or-name> <repo-id-or-name> ... - queue loop jobs across multiple repos',
    '/provider <null|ollama|openrouter|openclaw> - set the default provider for this session',
    '/model <model-slug> - set the default model for this session',
    '/jobs - list recent jobs',
    '/job <job-id> - inspect one job',
    '/session - show this session state',
    '',
    'Natural prompts:',
    'api reposuna gec',
    'aktif repoda loop baslat',
    'plan md uzerinden saatlerce calis',
  ].join('\n')
}

function getDaemonUrl(config: OpenClawAgentConfig): string {
  return config.daemonUrl ?? process.env.COCO_DAEMON_URL ?? 'http://127.0.0.1:3000'
}

async function daemonRequest(
  config: OpenClawAgentConfig,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const daemonUrl = getDaemonUrl(config)
  try {
    return await fetch(`${daemonUrl}${path}`, init)
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.cause instanceof Error
          ? `${error.message}: ${error.cause.message}`
          : error.message
        : String(error)
    throw new Error(`coco daemon ulasilamadi (${daemonUrl}${path}): ${detail}`)
  }
}

function normalizeRepoKey(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeMessage(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[“”"]/g, '').replaceAll(/[']/g, '')
}

function getRepoDisplayName(rootPath: string): string {
  return rootPath.split('/').at(-1) ?? rootPath
}

function sanitizePlannerReply(reply: string | undefined): string | undefined {
  if (!reply) return undefined

  const internalPatterns = [
    'json',
    'taskscope',
    'queue',
    'selectrepohint',
    'autopilot',
    'schema',
    'parse edip',
    'alanlar oluyor',
    '"reply"',
    '"queue"',
  ]

  const cleaned = reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      const normalized = normalizeMessage(line)
      return !internalPatterns.some((pattern) => normalized.includes(pattern))
    })
    .join('\n')
    .trim()

  return cleaned || undefined
}

function composeActionReply(options: {
  queue: 'doctor' | 'loop' | 'fanout'
  repoPath?: string
  plannerReply?: string
  autopilotEnabled?: boolean
  fanoutCount?: number
}): string {
  const repoName = options.repoPath ? getRepoDisplayName(options.repoPath) : 'aktif repo'
  const intro = sanitizePlannerReply(options.plannerReply)

  if (options.queue === 'doctor') {
    return [
      intro ?? `${repoName} uzerinde ilk incelemeyi baslatiyorum.`,
      'Repo yapisini, riskleri ve hizli kazanımlari tarayip sana net bir ozet cikaracagim.',
    ].join('\n\n')
  }

  if (options.queue === 'fanout') {
    return [
      intro ?? 'Paralel calisma turunu baslatiyorum.',
      `${options.fanoutCount ?? 0} repo icin ayri akislari yurutup sonucu tek yerde toplayacagim.`,
    ].join('\n\n')
  }

  return [
    intro ?? `${repoName} uzerinde calismaya basliyorum.`,
    options.autopilotEnabled
      ? 'Plani birakmadan tur tur ilerleyecegim; her turun sonunda yeniden degerlendirip devam edecegim.'
      : 'Ilk turda repo yapisini okuyup en mantikli denemeyi cikaracagim.',
  ].join('\n\n')
}

function appendPendingJob(
  session: ChatSession,
  job: { id: string; type: 'doctor' | 'loop'; repoPath?: string; userIntent?: string },
): ChatSession {
  return {
    ...session,
    pendingJobs: [...(session.pendingJobs ?? []), job],
  }
}

function summarizeBackgroundJob(job: {
  type: 'doctor' | 'loop'
  repoPath?: string
  status?: string
  summary?: string
  success?: boolean
}): string {
  const repoName = job.repoPath ? getRepoDisplayName(job.repoPath) : 'aktif repo'

  if (job.status === 'failed' || job.success === false) {
    return [
      `${repoName} icin baslattigim ${job.type === 'doctor' ? 'inceleme' : 'calisma'} tamamlanamadi.`,
      job.summary ?? 'Ayrintili hatayi inceleyip tekrar denememiz gerekecek.',
    ].join('\n\n')
  }

  if (job.type === 'doctor') {
    return [
      `${repoName} icin ilk inceleme tamamlandi.`,
      job.summary ??
        'Temel bulgulari ve riskleri hazir; istersen bir sonraki adimda duzeltme turuna geceyim.',
    ].join('\n\n')
  }

  return [
    `${repoName} uzerindeki calisma turu tamamlandi.`,
    job.summary ?? 'Istersen sonucu derinlestirip yeni bir tur daha acabilirim.',
  ].join('\n\n')
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern))
}

function parseAbsolutePath(text: string): string | undefined {
  const match = text.match(/(\/[^\s]+(?:\s+[^\s]+)*)/)
  return match?.[1]?.trim()
}

function parseProvider(text: string): string | undefined {
  const providers = ['null', 'ollama', 'openrouter', 'openclaw']
  return providers.find((provider) => text.includes(provider))
}

function parseModel(text: string): string | undefined {
  const explicitModel = text.match(/model(?:ini)?\s+([a-z0-9._:/-]+)/i)?.[1]
  if (explicitModel) {
    return explicitModel
  }

  const slashModel = text.match(/\b[a-z0-9._:-]+\/[a-z0-9._:-]+\b/i)?.[0]
  return slashModel
}

function parseDockerAction(
  text: string,
): 'list' | 'start' | 'stop' | 'restart' | 'remove' | undefined {
  if (includesAny(text, ['liste', 'list', 'goster', 'göster', 'durum'])) return 'list'
  if (includesAny(text, ['restart', 'yeniden baslat', 'yeniden başlat'])) return 'restart'
  if (includesAny(text, ['start', 'baslat', 'başlat', 'ayaga kaldir', 'ayağa kaldır'])) {
    return 'start'
  }
  if (includesAny(text, ['stop', 'durdur'])) return 'stop'
  if (includesAny(text, ['remove', 'sil', 'kaldir', 'kaldır', 'rm'])) return 'remove'
  return undefined
}

function findDesktopRepoPath(input: string): string | undefined {
  const hostHomeRoot = process.env.COCO_HOST_HOME ?? '/host-home'
  const desktopRoot = join(hostHomeRoot, 'Desktop')
  if (!existsSync(desktopRoot)) {
    return undefined
  }
  const normalized = normalizeRepoKey(input)
  for (const entry of readdirSync(desktopRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const fullPath = join(desktopRoot, entry.name)
    const name = normalizeRepoKey(entry.name)
    if (!normalized.includes(name) && !name.includes(normalized)) continue
    try {
      if (existsSync(join(fullPath, '.git')) || statSync(fullPath).isDirectory()) {
        return fullPath
      }
    } catch {}
  }
  return undefined
}

function detectDesktopProjectHints(rootPath: string): string[] {
  const hints = new Set<string>()
  let entries: string[] = []
  try {
    entries = readdirSync(rootPath)
  } catch {
    return []
  }
  if (existsSync(join(rootPath, '.git'))) hints.add('git')
  if (existsSync(join(rootPath, 'package.json'))) hints.add('node')
  if (existsSync(join(rootPath, 'tsconfig.json'))) hints.add('ts')
  if (entries.some((entry) => entry.endsWith('.sln') || entry.endsWith('.csproj')))
    hints.add('dotnet')
  if (
    existsSync(join(rootPath, 'pyproject.toml')) ||
    existsSync(join(rootPath, 'requirements.txt'))
  ) {
    hints.add('python')
  }
  if (existsSync(join(rootPath, 'go.mod'))) hints.add('go')
  if (existsSync(join(rootPath, 'Cargo.toml'))) hints.add('rust')
  if (
    existsSync(join(rootPath, 'Dockerfile')) ||
    existsSync(join(rootPath, 'docker-compose.yml'))
  ) {
    hints.add('docker')
  }
  return [...hints]
}

function listDesktopProjects(): DesktopProjectRecord[] {
  const hostHomeRoot = process.env.COCO_HOST_HOME ?? '/host-home'
  const desktopRoot = join(hostHomeRoot, 'Desktop')
  if (!existsSync(desktopRoot)) {
    return []
  }

  return readdirSync(desktopRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(desktopRoot, entry.name)
      return {
        name: entry.name,
        path,
        hints: detectDesktopProjectHints(path),
      }
    })
    .filter((project) => project.hints.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name))
}

async function renderRepoSelectionHelp(config: OpenClawAgentConfig): Promise<string> {
  const registeredRepos = await listRepos(config).catch(() => [])
  const desktopProjects = listDesktopProjects()

  if (registeredRepos.length > 0) {
    return [
      'Hangi repoda calisacagimi once secmem gerekiyor.',
      'Kayitli repolar:',
      ...registeredRepos
        .slice(0, 12)
        .map((repo) => `- ${getRepoDisplayName(repo.rootPath)} -> ${repo.rootPath}`),
      '',
      'Ornek: "subs-api reposuna gec"',
    ].join('\n')
  }

  if (desktopProjects.length > 0) {
    return [
      'Hangi repoda calisacagimi once secmem gerekiyor.',
      'Desktop altinda buldugum projeler:',
      ...desktopProjects
        .slice(0, 12)
        .map((project) => `- ${project.name} [${project.hints.join(', ')}] -> ${project.path}`),
      '',
      'Ornek: "subs-api reposuna gec" ya da "Desktop’taki projeleri listele"',
    ].join('\n')
  }

  return 'Hangi repoda calisacagimi once secmem gerekiyor. Ornek: "subs-api reposuna gec"'
}

async function findRepo(
  config: OpenClawAgentConfig,
  input: string,
): Promise<RepoRecord | undefined> {
  const response = await daemonRequest(config, '/repos')
  if (!response.ok) {
    return undefined
  }
  const repos = (await response.json()) as RepoRecord[]
  const key = normalizeRepoKey(input)
  return repos.find(
    (repo) =>
      normalizeRepoKey(repo.id) === key ||
      normalizeRepoKey(repo.rootPath) === key ||
      normalizeRepoKey(repo.rootPath.split('/').at(-1) ?? '') === key,
  )
}

async function listRepos(config: OpenClawAgentConfig): Promise<RepoRecord[]> {
  const response = await daemonRequest(config, '/repos')
  if (!response.ok) {
    throw new Error('Daemon is unavailable.')
  }
  return (await response.json()) as RepoRecord[]
}

async function resolveRepoFromText(
  config: OpenClawAgentConfig,
  text: string,
): Promise<RepoRecord | undefined> {
  const response = await daemonRequest(config, '/repos')
  if (!response.ok) {
    return undefined
  }
  const repos = (await response.json()) as RepoRecord[]
  const normalized = normalizeMessage(text)
  const tokens = normalized.split(/[\s,]+/).filter((token) => token.length >= 2)

  return repos.find((repo) => {
    const id = normalizeRepoKey(repo.id)
    const rootPath = normalizeRepoKey(repo.rootPath)
    const name = normalizeRepoKey(getRepoDisplayName(repo.rootPath))
    if (normalized.includes(id) || normalized.includes(rootPath) || normalized.includes(name)) {
      return true
    }
    return tokens.some((token) => name.includes(token) || id.includes(token))
  })
}

async function queueJob(
  config: OpenClawAgentConfig,
  type: 'doctor' | 'loop',
  repoId: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await daemonRequest(config, `/jobs/${type}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      repoId,
      ...payload,
    }),
  })
  if (!response.ok) {
    throw new Error(`Unable to queue ${type} job.`)
  }
  return (await response.json()) as { id: string }
}

async function listJobs(config: OpenClawAgentConfig): Promise<JobListEntry[]> {
  const response = await daemonRequest(config, '/jobs')
  if (!response.ok) {
    throw new Error('Daemon is unavailable.')
  }
  return (await response.json()) as JobListEntry[]
}

async function inspectJob(
  config: OpenClawAgentConfig,
  jobId: string,
): Promise<Record<string, unknown>> {
  const response = await daemonRequest(config, `/jobs/${jobId}`)
  if (!response.ok) {
    throw new Error(`Job not found: ${jobId}`)
  }
  return (await response.json()) as Record<string, unknown>
}

async function registerRepo(
  config: OpenClawAgentConfig,
  path: string,
): Promise<{ id: string; rootPath: string }> {
  const response = await daemonRequest(config, '/repos', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ path }),
  })
  if (!response.ok) {
    throw new Error(`Unable to register repo: ${path}`)
  }
  return (await response.json()) as { id: string; rootPath: string }
}

async function listDockerContainers(config: OpenClawAgentConfig): Promise<DockerContainerRecord[]> {
  const response = await daemonRequest(config, '/docker/containers')
  if (!response.ok) {
    throw new Error('Docker container list is unavailable.')
  }
  return (await response.json()) as DockerContainerRecord[]
}

async function performDockerAction(
  config: OpenClawAgentConfig,
  action: 'start' | 'stop' | 'restart' | 'remove',
  idOrName: string,
): Promise<{ ok: true; action: string; target: string }> {
  const response = await daemonRequest(config, `/docker/containers/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ idOrName }),
  })
  if (!response.ok) {
    throw new Error(`Docker action failed: ${action} ${idOrName}`)
  }
  return (await response.json()) as { ok: true; action: string; target: string }
}

function getPlanExcerpt(repoPath?: string): string | undefined {
  if (!repoPath) return undefined
  for (const candidate of ['PLAN.md', 'plan.md']) {
    const path = join(repoPath, candidate)
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8')
      return content.slice(0, 5000)
    }
  }
  return undefined
}

function parseJsonObject<T>(raw: string): T | undefined {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed) as T
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

async function runAutopilotReplanner(
  config: OpenClawAgentConfig,
  session: ChatSession,
  summary: string,
): Promise<PlannerDecision | undefined> {
  const goal = session.autopilot?.goal
  if (!goal) {
    return undefined
  }

  const prompt = [
    'AUTOPILOT_REPLAN',
    `GOAL:\n${goal}`,
    `TASK_SCOPE:\n${session.autopilot?.taskScope ?? 'long'}`,
    `CURRENT_PLAN:\n${session.autopilot?.plan?.join('\n') ?? 'none'}`,
    `SUCCESS_CRITERIA:\n${session.autopilot?.successCriteria ?? 'none'}`,
    `LAST_SUMMARY:\n${summary}`,
    'Decide whether the task is done or another loop cycle is needed.',
  ].join('\n\n')

  return runOpenClawPlanner(config, prompt, session)
}

async function runOpenClawPlanner(
  config: OpenClawAgentConfig,
  inputText: string,
  session: ChatSession,
): Promise<PlannerDecision | undefined> {
  if (config.planner) {
    return config.planner(inputText, session)
  }

  const shouldUsePlanner =
    session.provider === 'openclaw' ||
    session.provider === 'openrouter' ||
    session.provider === 'ollama' ||
    Boolean(process.env.OPENROUTER_API_KEY)

  if (!shouldUsePlanner) {
    return undefined
  }

  const registry = new LLMRegistry()
  const repos = await listRepos(config).catch(() => [])
  const desktopProjects = listDesktopProjects()
  const planExcerpt = getPlanExcerpt(session.activeRepoPath)
  const repoSummary =
    repos.length === 0
      ? 'No registered repos.'
      : repos
          .map((repo) => `${repo.id} :: ${getRepoDisplayName(repo.rootPath)} :: ${repo.rootPath}`)
          .join('\n')
  const desktopSummary =
    desktopProjects.length === 0
      ? 'No Desktop projects detected.'
      : desktopProjects
          .map((project) => `${project.name} :: ${project.hints.join(', ')} :: ${project.path}`)
          .join('\n')
  const selection = {
    ...((session.provider ?? process.env.OPENROUTER_API_KEY)
      ? { provider: session.provider ?? 'openclaw' }
      : {}),
    ...(session.model ? { model: session.model } : {}),
  }
  const response = await registry.generate(
    {
      systemPrompt: [
        'You are OpenClaw, the first-contact planning agent for coco.',
        'Interpret the user message and return strict JSON only.',
        'Prefer taking action over asking the user to type commands.',
        'If the message asks to keep working for a long time, enable autopilot.',
        'If a repo can be inferred from the repo list, set selectRepoHint.',
        'If a repo can be inferred from Desktop projects, set selectRepoHint to its name.',
        'Use queue="loop" for coding/fixing work, queue="doctor" for diagnosis, queue="jobs" for status.',
        'If the user asks about docker containers, use queue="docker".',
        'If the user asks to list Desktop or local projects, use queue="desktop".',
        'Do not claim work has started if no repo is selected yet.',
        'Never mention JSON, schema fields, queue names, taskScope, selectRepoHint, or autopilot internals in reply.',
        'reply must be natural Turkish assistant text, not a protocol explanation.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            `USER MESSAGE:\n${inputText}`,
            `ACTIVE SESSION:\n${JSON.stringify(session, null, 2)}`,
            `REGISTERED REPOS:\n${repoSummary}`,
            `DESKTOP_PROJECTS:\n${desktopSummary}`,
            `PLAN_MD_EXCERPT:\n${planExcerpt ?? 'none'}`,
            `Return JSON with this schema:
{
  "reply": "short assistant reply in Turkish",
  "provider": "optional provider",
  "model": "optional model",
  "selectRepoHint": "optional repo id, path, or name hint",
  "registerPath": "optional absolute path",
  "taskScope": "short|long",
  "plan": ["optional ordered plan step", "optional next step"],
  "successCriteria": "optional done definition",
  "queue": "none|doctor|loop|fanout|repos|jobs|session|docker|desktop",
  "fanoutRepoHints": ["optional", "repo", "hints"],
  "dockerAction": "list|start|stop|restart|remove",
  "dockerTargetHint": "optional docker container id or name",
  "autopilot": {
    "enabled": true,
    "goal": "optional long-running goal",
    "taskScope": "short|long",
    "plan": ["optional step 1", "optional step 2"],
    "successCriteria": "optional done definition",
    "roundsPerJob": 1,
    "maxCycles": 12,
    "usePlanMd": true
  }
}`,
          ].join('\n\n'),
        },
      ],
      temperature: 0.2,
      maxOutputTokens: 500,
      responseFormat: 'json',
    },
    selection,
  )

  if (response.finishReason === 'error') {
    return undefined
  }

  return parseJsonObject<PlannerDecision>(response.content)
}

async function handleCommand(
  config: OpenClawAgentConfig,
  commandText: string,
  sessionId: string,
  sessions: SessionState,
): Promise<{ reply: string; updatedSessions?: SessionState }> {
  const [command, ...args] = commandText.trim().split(/\s+/)
  const session = sessions[sessionId] ?? {}

  if (command === '/start' || command === '/help') {
    return { reply: renderOpenClawHelp() }
  }

  if (command === '/repos') {
    const repos = await listRepos(config)
    return {
      reply:
        repos.length === 0
          ? 'No repos registered yet.'
          : repos.map((repo) => `${repo.id}  ${repo.rootPath}`).join('\n'),
    }
  }

  if (command === '/repoadd') {
    const path = args.join(' ')
    if (!path) {
      return { reply: 'Usage: /repoadd <absolute-path>' }
    }
    const repo = await registerRepo(config, path)
    return {
      reply: `Registered ${repo.rootPath}\nActive repo set to ${repo.id}`,
      updatedSessions: {
        ...sessions,
        [sessionId]: {
          ...session,
          activeRepoId: repo.id,
          activeRepoPath: repo.rootPath,
        },
      },
    }
  }

  if (command === '/use') {
    const target = args.join(' ')
    if (!target) {
      return { reply: 'Usage: /use <repo-id-or-name>' }
    }
    const repo = await findRepo(config, target)
    if (!repo) {
      return { reply: `Repo not found: ${target}` }
    }
    return {
      reply: `Active repo set to ${repo.rootPath}`,
      updatedSessions: {
        ...sessions,
        [sessionId]: {
          ...session,
          activeRepoId: repo.id,
          activeRepoPath: repo.rootPath,
        },
      },
    }
  }

  if (command === '/provider') {
    const provider = args[0]
    if (!provider) {
      return { reply: 'Usage: /provider <null|ollama|openrouter|openclaw>' }
    }
    return {
      reply: `Default provider set to ${provider}`,
      updatedSessions: {
        ...sessions,
        [sessionId]: {
          ...session,
          provider,
        },
      },
    }
  }

  if (command === '/model') {
    const model = args.join(' ')
    if (!model) {
      return { reply: 'Usage: /model <model-slug>' }
    }
    return {
      reply: `Default model set to ${model}`,
      updatedSessions: {
        ...sessions,
        [sessionId]: {
          ...session,
          model,
        },
      },
    }
  }

  if (command === '/session') {
    return {
      reply: JSON.stringify(
        {
          activeRepoId: session.activeRepoId ?? null,
          activeRepoPath: session.activeRepoPath ?? null,
          provider: session.provider ?? null,
          model: session.model ?? null,
          autopilot: session.autopilot ?? null,
        },
        null,
        2,
      ),
    }
  }

  if (command === '/doctor' || command === '/loop') {
    const target = args.join(' ')
    const repo =
      (target ? await findRepo(config, target) : undefined) ??
      (session.activeRepoId
        ? { id: session.activeRepoId, rootPath: session.activeRepoPath ?? session.activeRepoId }
        : undefined)
    if (!repo) {
      return { reply: 'No active repo set. Use /repos and /use first.' }
    }
    const queued = await queueJob(
      config,
      command === '/doctor' ? 'doctor' : 'loop',
      repo.id,
      command === '/loop'
        ? {
            rounds: 1,
            ...(session.provider ? { provider: session.provider } : {}),
            ...(session.model ? { model: session.model } : {}),
            ...(session.autopilot?.goal ? { goal: session.autopilot.goal } : {}),
            ...(session.autopilot?.usePlanMd ? { planExcerpt: getPlanExcerpt(repo.rootPath) } : {}),
          }
        : {},
    )
    return {
      reply: `Queued ${command === '/doctor' ? 'doctor' : 'loop'} job ${queued.id} for ${repo.rootPath}`,
    }
  }

  if (command === '/fanout') {
    if (args.length === 0) {
      return { reply: 'Usage: /fanout <repo-id-or-name> <repo-id-or-name> ...' }
    }
    const resolved = (await Promise.all(args.map((arg) => findRepo(config, arg)))).filter(
      (repo): repo is RepoRecord => Boolean(repo),
    )
    if (resolved.length === 0) {
      return { reply: 'No matching repos found.' }
    }
    const jobs = await Promise.all(
      resolved.map((repo) =>
        queueJob(config, 'loop', repo.id, {
          rounds: 1,
          ...(session.provider ? { provider: session.provider } : {}),
          ...(session.model ? { model: session.model } : {}),
          ...(session.autopilot?.goal ? { goal: session.autopilot.goal } : {}),
          ...(session.autopilot?.usePlanMd ? { planExcerpt: getPlanExcerpt(repo.rootPath) } : {}),
        }),
      ),
    )
    return {
      reply: jobs.map((job, index) => `${resolved[index]?.rootPath} -> ${job.id}`).join('\n'),
    }
  }

  if (command === '/jobs') {
    const jobs = await listJobs(config)
    return {
      reply:
        jobs.length === 0
          ? 'No jobs found.'
          : jobs
              .slice(0, 10)
              .map(
                (entry) =>
                  `${entry.job.id}  ${entry.job.type}  ${entry.job.status}  ${entry.job.repoId}`,
              )
              .join('\n'),
    }
  }

  if (command === '/job') {
    const jobId = args[0]
    if (!jobId) {
      return { reply: 'Usage: /job <job-id>' }
    }
    const job = await inspectJob(config, jobId)
    return { reply: JSON.stringify(job, null, 2).slice(0, 3900) }
  }

  return { reply: 'Unknown command. Use /help.' }
}

async function applyPlannerDecision(
  config: OpenClawAgentConfig,
  decision: PlannerDecision,
  sessionId: string,
  sessions: SessionState,
): Promise<{ reply: string; updatedSessions?: SessionState }> {
  const session = sessions[sessionId] ?? {}
  const workingSessions: SessionState = { ...sessions }
  const workingSession: ChatSession = { ...session }

  if (decision.provider) {
    workingSession.provider = decision.provider
  }
  if (decision.model) {
    workingSession.model = decision.model
  }
  if (decision.registerPath) {
    const repo = await registerRepo(config, decision.registerPath)
    workingSession.activeRepoId = repo.id
    workingSession.activeRepoPath = repo.rootPath
  }
  if (decision.selectRepoHint) {
    const repo = await findRepo(config, decision.selectRepoHint)
    if (repo) {
      workingSession.activeRepoId = repo.id
      workingSession.activeRepoPath = repo.rootPath
    } else {
      const desktopRepoPath = findDesktopRepoPath(decision.selectRepoHint)
      if (desktopRepoPath) {
        const registered = await registerRepo(config, desktopRepoPath)
        workingSession.activeRepoId = registered.id
        workingSession.activeRepoPath = registered.rootPath
      }
    }
  }
  if (decision.autopilot) {
    workingSession.autopilot = {
      enabled: decision.autopilot.enabled,
      goal: decision.autopilot.goal,
      taskScope: decision.autopilot.taskScope ?? decision.taskScope ?? 'long',
      roundsPerJob: decision.autopilot.roundsPerJob ?? 1,
      maxCycles: decision.autopilot.maxCycles ?? 12,
      completedCycles: workingSession.autopilot?.completedCycles ?? 0,
      usePlanMd: decision.autopilot.usePlanMd ?? true,
      ...((decision.autopilot.plan ?? decision.plan)
        ? { plan: decision.autopilot.plan ?? decision.plan }
        : {}),
      ...((decision.autopilot.successCriteria ?? decision.successCriteria)
        ? { successCriteria: decision.autopilot.successCriteria ?? decision.successCriteria }
        : {}),
      ...(workingSession.autopilot?.lastSummary
        ? { lastSummary: workingSession.autopilot.lastSummary }
        : {}),
      ...(workingSession.autopilot?.currentJobId
        ? { currentJobId: workingSession.autopilot.currentJobId }
        : {}),
      ...(workingSession.autopilot?.lastNotifiedJobId
        ? { lastNotifiedJobId: workingSession.autopilot.lastNotifiedJobId }
        : {}),
    }
  } else if (
    decision.taskScope === 'long' &&
    (decision.queue === 'loop' || decision.queue === 'fanout')
  ) {
    workingSession.autopilot = {
      enabled: true,
      goal: decision.successCriteria ?? decision.reply,
      taskScope: 'long',
      roundsPerJob: 1,
      maxCycles: 12,
      completedCycles: workingSession.autopilot?.completedCycles ?? 0,
      usePlanMd: true,
      ...(decision.plan ? { plan: decision.plan } : {}),
      ...(decision.successCriteria ? { successCriteria: decision.successCriteria } : {}),
      ...(workingSession.autopilot?.lastSummary
        ? { lastSummary: workingSession.autopilot.lastSummary }
        : {}),
      ...(workingSession.autopilot?.currentJobId
        ? { currentJobId: workingSession.autopilot.currentJobId }
        : {}),
      ...(workingSession.autopilot?.lastNotifiedJobId
        ? { lastNotifiedJobId: workingSession.autopilot.lastNotifiedJobId }
        : {}),
    }
  }
  workingSessions[sessionId] = workingSession
  const activeRepoNotice = workingSession.activeRepoPath
    ? `Active repo set to ${workingSession.activeRepoPath}`
    : undefined

  if (decision.queue === 'repos') {
    return handleCommand(config, '/repos', sessionId, workingSessions)
  }
  if (decision.queue === 'jobs') {
    return handleCommand(config, '/jobs', sessionId, workingSessions)
  }
  if (decision.queue === 'session') {
    return handleCommand(config, '/session', sessionId, workingSessions)
  }
  if (decision.queue === 'desktop') {
    const projects = listDesktopProjects()
    return {
      reply:
        projects.length === 0
          ? 'Desktop altında tespit edebildigim code projesi bulamadim.'
          : [
              decision.reply,
              '',
              ...projects
                .slice(0, 30)
                .map(
                  (project) => `- ${project.name} [${project.hints.join(', ')}] -> ${project.path}`,
                ),
            ].join('\n'),
      updatedSessions: workingSessions,
    }
  }
  if (decision.queue === 'docker') {
    if (decision.dockerAction === 'list') {
      const containers = await listDockerContainers(config)
      return {
        reply:
          containers.length === 0
            ? decision.reply
            : `${decision.reply}\n\n${containers
                .slice(0, 20)
                .map((container) => `${container.name}  ${container.state}  ${container.status}`)
                .join('\n')}`,
        updatedSessions: workingSessions,
      }
    }
    if (decision.dockerAction && decision.dockerTargetHint) {
      const containers = await listDockerContainers(config)
      const normalizedTarget = normalizeRepoKey(decision.dockerTargetHint)
      const target =
        containers.find(
          (container) =>
            normalizeRepoKey(container.id) === normalizedTarget ||
            normalizeRepoKey(container.name) === normalizedTarget ||
            normalizeRepoKey(container.name).includes(normalizedTarget),
        )?.name ?? decision.dockerTargetHint
      await performDockerAction(config, decision.dockerAction, target)
      return {
        reply: `${decision.reply}\n\nDocker ${decision.dockerAction} -> ${target}`,
        updatedSessions: workingSessions,
      }
    }
    return {
      reply: `${decision.reply}\n\nDocker hedefini veya aksiyonunu netlestiremedim.`,
      updatedSessions: workingSessions,
    }
  }
  if (decision.queue === 'doctor' || decision.queue === 'loop') {
    const repoId = workingSession.activeRepoId
    if (!repoId) {
      return {
        reply: await renderRepoSelectionHelp(config),
        updatedSessions: workingSessions,
      }
    }
    const repoPath = workingSession.activeRepoPath ?? repoId
    const queued = await queueJob(
      config,
      decision.queue,
      repoId,
      decision.queue === 'loop'
        ? {
            rounds: workingSession.autopilot?.roundsPerJob ?? 1,
            ...(workingSession.provider ? { provider: workingSession.provider } : {}),
            ...(workingSession.model ? { model: workingSession.model } : {}),
            ...(workingSession.autopilot?.goal ? { goal: workingSession.autopilot.goal } : {}),
            ...(workingSession.autopilot?.usePlanMd
              ? { planExcerpt: getPlanExcerpt(repoPath) }
              : {}),
          }
        : {},
    )
    if (decision.queue === 'loop' && workingSession.autopilot?.enabled) {
      workingSession.autopilot.currentJobId = queued.id
      workingSessions[sessionId] = workingSession
    } else {
      workingSessions[sessionId] = appendPendingJob(workingSession, {
        id: queued.id,
        type: decision.queue,
        repoPath,
        ...(decision.reply ? { userIntent: decision.reply } : {}),
      })
    }
    return {
      reply: composeActionReply({
        queue: decision.queue,
        repoPath,
        plannerReply: decision.reply,
        ...(workingSession.autopilot?.enabled !== undefined
          ? { autopilotEnabled: workingSession.autopilot.enabled }
          : {}),
      }),
      updatedSessions: workingSessions,
    }
  }
  if (
    decision.queue === 'fanout' &&
    decision.fanoutRepoHints &&
    decision.fanoutRepoHints.length > 0
  ) {
    const resolved = (
      await Promise.all(decision.fanoutRepoHints.map((hint) => findRepo(config, hint)))
    ).filter((repo): repo is RepoRecord => Boolean(repo))
    if (resolved.length > 0) {
      const jobs = await Promise.all(
        resolved.map((repo) =>
          queueJob(config, 'loop', repo.id, {
            rounds: workingSession.autopilot?.roundsPerJob ?? 1,
            ...(workingSession.provider ? { provider: workingSession.provider } : {}),
            ...(workingSession.model ? { model: workingSession.model } : {}),
            ...(workingSession.autopilot?.goal ? { goal: workingSession.autopilot.goal } : {}),
            ...(workingSession.autopilot?.usePlanMd
              ? { planExcerpt: getPlanExcerpt(repo.rootPath) }
              : {}),
          }),
        ),
      )
      workingSessions[sessionId] = {
        ...workingSession,
        pendingJobs: [
          ...(workingSession.pendingJobs ?? []),
          ...jobs.map((job, index) => ({
            id: job.id,
            type: 'loop' as const,
            ...(resolved[index]?.rootPath ? { repoPath: resolved[index].rootPath } : {}),
            ...(decision.reply ? { userIntent: decision.reply } : {}),
          })),
        ],
      }
      return {
        reply: composeActionReply({
          queue: 'fanout',
          plannerReply: decision.reply,
          fanoutCount: jobs.length,
        }),
        updatedSessions: workingSessions,
      }
    }
  }

  const sanitizedReply = sanitizePlannerReply(decision.reply)
  return {
    reply:
      activeRepoNotice && sanitizedReply
        ? `${sanitizedReply}\n\n${activeRepoNotice}`
        : (activeRepoNotice ?? sanitizedReply ?? 'OpenClaw hazir.'),
    updatedSessions: workingSessions,
  }
}

export function createOpenClawAgent(config: OpenClawAgentConfig = {}) {
  return {
    config,
    renderHelp(): string {
      return renderOpenClawHelp()
    },
    async handleMessage(
      inputText: string,
      sessionId: string,
      sessions: SessionState,
    ): Promise<{ reply: string; updatedSessions?: SessionState }> {
      const trimmed = inputText.trim()
      if (!trimmed) {
        return { reply: 'Bir şey yaz, OpenClaw planlayıp aksiyon alsın.' }
      }
      if (trimmed.startsWith('/')) {
        return handleCommand(config, trimmed, sessionId, sessions)
      }

      const session = sessions[sessionId] ?? {}
      const plan = await runOpenClawPlanner(config, trimmed, session).catch((error) => {
        if (error instanceof Error && error.message.includes('coco daemon ulasilamadi')) {
          return {
            reply: error.message,
            queue: 'none',
          } satisfies PlannerDecision
        }
        return undefined
      })
      if (plan?.reply) {
        return applyPlannerDecision(config, plan, sessionId, sessions)
      }

      return {
        reply:
          'OpenClaw planner su anda istegi isleyemedi. OPENROUTER_API_KEY ve model ayarini kontrol et, sonra yeniden dene.',
      }
    },
    async tickAutopilot(
      sessions: SessionState,
      notify: (sessionId: string, message: string) => Promise<void>,
    ): Promise<SessionState> {
      const nextSessions: SessionState = JSON.parse(JSON.stringify(sessions)) as SessionState
      const jobs = await listJobs(config).catch(() => [])

      for (const [sessionId, session] of Object.entries(nextSessions)) {
        if (session.pendingJobs?.length) {
          const remainingPendingJobs: NonNullable<ChatSession['pendingJobs']> = []

          for (const pendingJob of session.pendingJobs) {
            const job = jobs.find((entry) => entry.job.id === pendingJob.id)?.job
            if (
              job?.status === 'queued' ||
              job?.status === 'running' ||
              job?.status === 'retryable'
            ) {
              remainingPendingJobs.push(pendingJob)
              continue
            }

            const record = await inspectJob(config, pendingJob.id).catch(() => undefined)
            const typedRecord = record as JobRecord | undefined
            const summary =
              typeof typedRecord?.result?.summary === 'string'
                ? typedRecord.result.summary
                : undefined
            const success =
              typeof typedRecord?.result?.success === 'boolean'
                ? typedRecord.result.success
                : undefined
            const status =
              typeof typedRecord?.job?.status === 'string' ? typedRecord.job.status : job?.status

            await notify(
              sessionId,
              summarizeBackgroundJob({
                type: pendingJob.type,
                ...(pendingJob.repoPath ? { repoPath: pendingJob.repoPath } : {}),
                ...(status ? { status } : {}),
                ...(summary ? { summary } : {}),
                ...(success !== undefined ? { success } : {}),
              }),
            )
          }

          if (remainingPendingJobs.length > 0) {
            session.pendingJobs = remainingPendingJobs
          } else {
            session.pendingJobs = []
          }
        }

        const autopilot = session.autopilot
        if (!autopilot?.enabled || !session.activeRepoId) continue

        if (autopilot.completedCycles >= autopilot.maxCycles) {
          session.autopilot = { ...autopilot, enabled: false }
          await notify(
            sessionId,
            `Planlanan uzun calisma tamamlandi. ${autopilot.completedCycles}/${autopilot.maxCycles} tur bitti.`,
          )
          continue
        }

        if (autopilot.currentJobId) {
          const job = jobs.find((entry) => entry.job.id === autopilot.currentJobId)?.job
          if (
            job?.status === 'queued' ||
            job?.status === 'running' ||
            job?.status === 'retryable'
          ) {
            continue
          }
          if (autopilot.lastNotifiedJobId !== autopilot.currentJobId) {
            const record = await inspectJob(config, autopilot.currentJobId).catch(() => undefined)
            const summary =
              typeof record?.result === 'object' &&
              record.result &&
              'summary' in record.result &&
              typeof record.result.summary === 'string'
                ? record.result.summary
                : 'Bir calisma turu tamamlandi.'
            await notify(sessionId, summary)
            const replanned = await runAutopilotReplanner(config, session, summary).catch(
              () => undefined,
            )
            const { currentJobId: _currentJobId, ...restAutopilot } = autopilot
            const nextCompletedCycles = autopilot.completedCycles + 1

            if (replanned?.autopilot) {
              session.autopilot = {
                ...restAutopilot,
                enabled: replanned.autopilot.enabled,
                goal: replanned.autopilot.goal,
                roundsPerJob: replanned.autopilot.roundsPerJob ?? autopilot.roundsPerJob,
                maxCycles: replanned.autopilot.maxCycles ?? autopilot.maxCycles,
                completedCycles: nextCompletedCycles,
                lastNotifiedJobId: autopilot.currentJobId,
                lastSummary: summary,
                ...((replanned.autopilot.taskScope ?? replanned.taskScope ?? autopilot.taskScope)
                  ? {
                      taskScope:
                        replanned.autopilot.taskScope ?? replanned.taskScope ?? autopilot.taskScope,
                    }
                  : {}),
                ...((replanned.autopilot.plan ?? replanned.plan ?? autopilot.plan)
                  ? { plan: replanned.autopilot.plan ?? replanned.plan ?? autopilot.plan }
                  : {}),
                ...((replanned.autopilot.successCriteria ??
                replanned.successCriteria ??
                autopilot.successCriteria)
                  ? {
                      successCriteria:
                        replanned.autopilot.successCriteria ??
                        replanned.successCriteria ??
                        autopilot.successCriteria,
                    }
                  : {}),
                ...(replanned.autopilot.usePlanMd !== undefined || autopilot.usePlanMd !== undefined
                  ? { usePlanMd: replanned.autopilot.usePlanMd ?? autopilot.usePlanMd }
                  : {}),
              }
              if (replanned.reply) {
                await notify(
                  sessionId,
                  sanitizePlannerReply(replanned.reply) ??
                    'Bir tur tamamlandi; plana gore bir sonraki adima geciyorum.',
                )
              }
            } else {
              session.autopilot = {
                ...restAutopilot,
                completedCycles: nextCompletedCycles,
                lastNotifiedJobId: autopilot.currentJobId,
                lastSummary: summary,
              }
            }
          }
          continue
        }

        const queued = await queueJob(config, 'loop', session.activeRepoId, {
          rounds: autopilot.roundsPerJob,
          ...(session.provider ? { provider: session.provider } : {}),
          ...(session.model ? { model: session.model } : {}),
          goal: autopilot.goal,
          ...(autopilot.usePlanMd ? { planExcerpt: getPlanExcerpt(session.activeRepoPath) } : {}),
        })
        session.autopilot = {
          ...autopilot,
          currentJobId: queued.id,
        }
        await notify(
          sessionId,
          `${getRepoDisplayName(session.activeRepoPath ?? session.activeRepoId)} icin yeni bir calisma turu baslattim.`,
        )
      }

      return nextSessions
    },
  }
}

export const openClawAgentPackage = {
  name: '@coco/openclaw-agent',
  status: 'ready',
  message: 'Shared OpenClaw planning and execution runtime for Telegram, CLI, and future UIs.',
} as const
