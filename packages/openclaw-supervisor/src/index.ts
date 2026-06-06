import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type {
  RepoRef,
  SessionInfo,
  Task,
  TaskCreateInput,
  TaskMode,
  WorkerInfo,
  WorkspaceSession,
} from '@coco/core'

export interface SupervisorSession {
  workspaceSessionId?: string
  activeRepoId?: string
  activeRepoPath?: string
  provider?: string
  model?: string
  activeTaskId?: string
  lastMode?: TaskMode
  workerSurface?: 'aider' | 'roo' | 'openclaw'
}

export type SupervisorSessionState = Record<string, SupervisorSession>

export interface SupervisorConfig {
  daemonUrl?: string
}

export interface SupervisorReply {
  reply: string
  updatedSessions?: SupervisorSessionState
  task?: Task
  tasks?: Task[]
}

function localizeHostPath(path: string): string {
  const home = process.env.HOME
  const hostHome = process.env.COCO_HOST_HOME ?? '/host-home'
  if (home && path.startsWith(`${hostHome}/`)) {
    return join(home, path.slice(hostHome.length + 1))
  }
  if (home && path.startsWith('/host-home/')) {
    return join(home, path.slice('/host-home/'.length))
  }
  return path
}

function displayRepoPath(path: string): string {
  const localized = localizeHostPath(path)
  return localized !== path && existsSync(localized) ? localized : path
}

function getDaemonUrl(config: SupervisorConfig): string {
  return config.daemonUrl ?? process.env.COCO_DAEMON_URL ?? 'http://127.0.0.1:3000'
}

async function daemonRequest(
  config: SupervisorConfig,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${getDaemonUrl(config)}${path}`, init)
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[“”"']/g, '')
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern))
}

function isHelpIntent(text: string): boolean {
  return includesAny(text, [
    'yard',
    'yardim',
    'yardım',
    'yardim et',
    'yardım et',
    'help',
    'imdat',
    'ne yapabiliyorsun',
    'nasil kullan',
    'nasil kullan',
  ])
}

function isFrustrationWithoutTask(text: string): boolean {
  return includesAny(text, [
    'hep ayni cevap',
    'hep aynı cevap',
    'niye ayni cevap',
    'niye aynı cevap',
    'sacma cevap',
    'saçma cevap',
    'bir sey demiyor',
    'bir şey demiyor',
  ])
}

function hasTaskIntent(text: string): boolean {
  return includesAny(text, [
    'analiz',
    'incele',
    'bak',
    'duzelt',
    'düzelt',
    'fix',
    'iyilestir',
    'iyileştir',
    'refactor',
    'bitene kadar',
    'devam et',
    'plani birakma',
    'planı bırakma',
    'gelistir',
    'geliştir',
    'build et',
    'olustur',
    'oluştur',
    'repo',
    'workspace',
    'session',
    'goster',
    'göster',
    'listele',
    'kesfet',
    'keşfet',
    'review',
    'task',
    'worker',
    'durum',
    'gec',
    'geç',
    'kullan',
    'model',
    'provider',
  ])
}

function renderClarificationHelp(activeRepoPath?: string): string {
  return [
    activeRepoPath ? `Aktif repo: ${activeRepoPath}` : 'Hangi repoda ne yapmam gerektigini netlestirelim.',
    'Ne yapmami istedigini daha acik yaz.',
    'Ornekler:',
    '- repo yapisini analiz et',
    '- bos catch bloklarini duzelt',
    '- bitene kadar devam et',
    '- yardim',
  ].join('\n')
}

function parseProvider(text: string): string | undefined {
  return ['null', 'ollama', 'openrouter', 'openclaw'].find((provider) => text.includes(provider))
}

function parseModel(text: string): string | undefined {
  return text.match(/\b[a-z0-9._:-]+\/[a-z0-9._:-]+\b/i)?.[0]
}

function inferMode(text: string): TaskMode {
  if (
    includesAny(text, [
      'bitene kadar',
      'devam et',
      'plani birakma',
      'planı bırakma',
      'saatlerce',
      'yonetecegiz',
      'yöneteceğiz',
      'olusturucaz',
      'oluşturucaz',
      'build et',
      'gelistir',
      'geliştir',
    ])
  ) {
    return 'autopilot'
  }
  if (
    includesAny(text, [
      'analiz et',
      'incele',
      'bak',
      'repo yapisini cikar',
      'repo yapısını çıkar',
      'durumu ozetle',
      'durumu özetle',
    ])
  ) {
    return 'analyze'
  }
  if (includesAny(text, ['duzelt', 'düzelt', 'fix', 'iyilestir', 'iyileştir', 'refactor'])) {
    return 'fix'
  }
  return 'analyze'
}

function parseRepoMentions(workspace: WorkspaceSession, prompt: string) {
  const normalized = normalize(prompt)
  const promptTokens = normalized.split(/\s+/).filter((token) => token.length >= 2)
  const matches = workspace.managedRepos.filter((repo) => {
    const repoPath = displayRepoPath(repo.rootPath)
    const repoName = normalize(repoPath.split('/').at(-1) ?? repoPath)
    const compactRepoName = repoName.replaceAll(' ', '')
    const compactPrompt = normalized.replaceAll(' ', '')
    const repoTokens = repoName.split(/\s+/).filter((token) => token.length >= 2)
    const overlap = repoTokens.filter((token) => promptTokens.includes(token)).length
    return (
      normalized.includes(repoName) ||
      compactPrompt.includes(compactRepoName) ||
      overlap >= Math.min(2, repoTokens.length) ||
      repoName
        .split(' ')
        .filter((token) => token.length >= 3)
        .every((token) => normalized.includes(token))
    )
  })
  return matches.sort((left, right) => right.priority - left.priority)
}


function extractBackendRequirement(prompt: string): string | undefined {
  const normalized = normalize(prompt)
  const match = normalized.match(/backend[^\n]*?([a-z0-9-]+subs[a-z0-9-]*)/)
  return match?.[1]
}

function inferSuccessCriteria(mode: TaskMode, goal: string): string {
  if (mode === 'analyze') {
    return 'Repo ozeti, riskler ve bir sonraki mantikli adimlar hazir olsun.'
  }
  if (mode === 'fix') {
    return 'En guvenli degisiklik stratejisi secilip review ile sonuc raporlansin.'
  }
  return `Hedef adim adim ilerlesin ve gorev su kadar tamamlandiginda dursun: ${goal}`
}

function desktopRoot(): string {
  return join(process.env.COCO_HOST_HOME ?? '/host-home', 'Desktop')
}

function candidateSearchRoots(): string[] {
  const roots = new Set<string>()
  const hostHome = process.env.COCO_HOST_HOME
  const home = process.env.HOME

  roots.add(desktopRoot())
  if (hostHome) {
    roots.add(hostHome)
    roots.add(join(hostHome, 'Desktop'))
    roots.add(join(hostHome, 'Projects'))
    roots.add(join(hostHome, 'Code'))
  }
  if (home) {
    roots.add(join(home, 'Desktop'))
    roots.add(join(home, 'Projects'))
    roots.add(join(home, 'Code'))
    roots.add(home)
  }

  return [...roots].filter((root, index, all) => root && all.indexOf(root) === index)
}

function looksLikeProject(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    if (!statSync(path).isDirectory()) return false
    const entries = new Set(readdirSync(path))
    const exactMarkers = new Set([
      '.git',
      'package.json',
      'pnpm-workspace.yaml',
      'turbo.json',
      'Cargo.toml',
      'go.mod',
      'pyproject.toml',
      'requirements.txt',
    ])
    const suffixMarkers = ['.sln', '.xcodeproj', '.xcworkspace']
    return (
      [...exactMarkers].some((marker) => entries.has(marker)) ||
      [...entries].some((entry) => suffixMarkers.some((marker) => entry.endsWith(marker)))
    )
  } catch {
    return false
  }
}

function listDiscoveredProjects(): Array<{ name: string; path: string; sourceRoot: string }> {
  const projects = new Map<string, { name: string; path: string; sourceRoot: string }>()

  for (const root of candidateSearchRoots()) {
    if (!existsSync(root)) continue

    let entries: Array<{ isDirectory(): boolean; name: string }>
    try {
      entries = readdirSync(root, { withFileTypes: true }) as Array<{
        isDirectory(): boolean
        name: string
      }>
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectPath = join(root, entry.name)
      if (!looksLikeProject(projectPath)) continue
      projects.set(projectPath, {
        name: entry.name,
        path: projectPath,
        sourceRoot: root,
      })
    }
  }

  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function listDesktopProjects(): Array<{ name: string; path: string }> {
  const root = desktopRoot()
  if (!existsSync(root)) return []
  return listDiscoveredProjects()
    .filter((project) => project.path.startsWith(`${root}/`) || project.path === root)
    .map(({ name, path }) => ({ name, path }))
}

async function listRepos(config: SupervisorConfig): Promise<RepoRef[]> {
  const response = await daemonRequest(config, '/repos')
  if (!response.ok) return []
  return (await response.json()) as RepoRef[]
}

function resolveRepoFromText(repos: RepoRef[], text: string): RepoRef | undefined {
  const normalized = normalize(text)
  const tokens = normalized.split(/[\s,]+/).filter((token) => token.length >= 2)
  return repos.find((repo) => {
    const displayPath = displayRepoPath(repo.rootPath)
    const rootPath = normalize(repo.rootPath)
    const localPath = normalize(displayPath)
    const name = normalize(displayPath.split('/').at(-1) ?? '')
    return normalized.includes(rootPath) || normalized.includes(localPath) || normalized.includes(name)
      ? true
      : tokens.some((token) => name.includes(token))
  })
}

async function createTask(config: SupervisorConfig, input: TaskCreateInput): Promise<Task> {
  const response = await daemonRequest(config, '/tasks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error('Task olusturulamadi.')
  }
  return (await response.json()) as Task
}

async function getTask(config: SupervisorConfig, taskId: string): Promise<Task | undefined> {
  const response = await daemonRequest(config, `/tasks/${taskId}`)
  if (!response.ok) return undefined
  return ((await response.json()) as { task: Task }).task
}

async function controlTask(
  config: SupervisorConfig,
  taskId: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<Task | undefined> {
  const response = await daemonRequest(config, `/tasks/${taskId}/${action}`, {
    method: 'POST',
  })
  if (!response.ok) return undefined
  return (await response.json()) as Task
}

async function listTasks(config: SupervisorConfig): Promise<Task[]> {
  const response = await daemonRequest(config, '/tasks')
  if (!response.ok) return []
  return (await response.json()) as Task[]
}

async function listWorkers(config: SupervisorConfig): Promise<WorkerInfo[]> {
  const response = await daemonRequest(config, '/workers')
  if (!response.ok) return []
  return (await response.json()) as WorkerInfo[]
}

async function listSessions(config: SupervisorConfig): Promise<SessionInfo[]> {
  const response = await daemonRequest(config, '/sessions')
  if (!response.ok) return []
  return (await response.json()) as SessionInfo[]
}

async function createWorkspaceSession(
  config: SupervisorConfig,
  input: {
    id?: string
    goal: string
    workerSurface?: 'aider' | 'roo' | 'openclaw'
    controlSurfaces?: Array<'terminal' | 'ide' | 'telegram'>
    successCriteria?: string
    repoRoots?: string[]
  },
): Promise<WorkspaceSession> {
  const response = await daemonRequest(config, '/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error('Workspace session olusturulamadi.')
  }
  return (await response.json()) as WorkspaceSession
}

async function getWorkspaceSession(
  config: SupervisorConfig,
  sessionId: string,
): Promise<WorkspaceSession | undefined> {
  const response = await daemonRequest(config, `/sessions/${sessionId}`)
  if (!response.ok) return undefined
  return (await response.json()) as WorkspaceSession
}

async function postSessionAction(
  config: SupervisorConfig,
  sessionId: string,
  action: 'discover' | 'autopilot' | 'review' | 'control',
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await daemonRequest(config, `/sessions/${sessionId}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`Session action failed: ${action}`)
  }
  return (await response.json()) as Record<string, unknown>
}

function renderRepoSelectionHelp(repos: RepoRef[]): string {
  if (repos.length > 0) {
    return [
      'Hangi repoda calisacagimi once netlestirmem gerekiyor.',
      ...repos.slice(0, 10).map((repo) => `- ${displayRepoPath(repo.rootPath)}`),
      '',
      'Ornek: "cognify-subs-api reposuna gec"',
    ].join('\n')
  }
  const discoveredProjects = listDiscoveredProjects()
  if (discoveredProjects.length > 0) {
    return [
      'Hangi repoda calisacagimi once netlestirmem gerekiyor.',
      ...discoveredProjects
        .slice(0, 10)
        .map((project) => `- ${project.name} -> ${project.path}`),
      '',
      'Ornek: "projeleri listele", "cognify-subs-api reposuna gec" ya da tam path ver',
    ].join('\n')
  }
  return 'Hangi repoda calisacagimi once netlestirmem gerekiyor.'
}

function chooseManagedRepo(workspace: WorkspaceSession, prompt: string) {
  const normalized = normalize(prompt)
  const mentioned =
    workspace.managedRepos.find((repo) =>
      normalized.includes(normalize(displayRepoPath(repo.rootPath))),
    ) ??
    workspace.managedRepos.find((repo) => normalized.includes(normalize(repo.rootPath))) ??
    workspace.managedRepos.find((repo) =>
      normalized.includes(normalize(displayRepoPath(repo.rootPath).split('/').at(-1) ?? '')),
    )
  if (mentioned) return mentioned
  return (
    workspace.managedRepos.find((repo) => repo.repoId === workspace.focusRepoId) ??
    [...workspace.managedRepos].sort((left, right) => right.priority - left.priority)[0]
  )
}

async function ensureWorkspaceReady(
  config: SupervisorConfig,
  sessionId: string,
  sessions: SupervisorSessionState,
  prompt: string,
): Promise<{ workspace?: WorkspaceSession; updatedSessions: SupervisorSessionState }> {
  const nextSessions: SupervisorSessionState = {
    ...sessions,
    [sessionId]: { ...(sessions[sessionId] ?? {}) },
  }
  const workspaceSessionId = nextSessions[sessionId]?.workspaceSessionId ?? sessionId
  let workspace = await getWorkspaceSession(config, workspaceSessionId)
  if (!workspace) {
    workspace = await createWorkspaceSession(config, {
      id: workspaceSessionId,
      goal: prompt,
      workerSurface: nextSessions[sessionId]?.workerSurface ?? 'aider',
      controlSurfaces: ['terminal', 'telegram', 'ide'],
      successCriteria: inferSuccessCriteria(inferMode(normalize(prompt)), prompt),
    })
  }
  if (workspace.managedRepos.length === 0) {
    workspace = (await postSessionAction(
      config,
      workspaceSessionId,
      'discover',
    )) as unknown as WorkspaceSession
  }
  const chosenRepo = chooseManagedRepo(workspace, prompt)
  nextSessions[sessionId] = {
    ...nextSessions[sessionId],
    workspaceSessionId,
    workerSurface: workspace.workerSurface,
    ...(chosenRepo?.repoId ? { activeRepoId: chosenRepo.repoId } : {}),
    ...(chosenRepo?.rootPath ? { activeRepoPath: displayRepoPath(chosenRepo.rootPath) } : {}),
  }
  if (chosenRepo?.repoId) {
    await postSessionAction(config, workspaceSessionId, 'control', {
      action: 'focus',
      focusRepoId: chosenRepo.repoId,
      summary: `${displayRepoPath(chosenRepo.rootPath)} auto-selected from prompt.`,
    }).catch(() => undefined)
  }
  return { workspace, updatedSessions: nextSessions }
}

export function renderSupervisorHelp(): string {
  return [
    'OpenClaw supervisor mode',
    'Dogal dil ile gorev ver; supervisor analyze, fix veya autopilot akisini secsin.',
    '',
    'Ornekler:',
    '- subs-api reposuna gec',
    '- subs-api repo yapisini analiz et',
    '- bos catch bloklarini duzelt',
    '- plani birakmadan bitene kadar devam et',
    '- workspace olustur ve projeleri kesfet',
    '- workspace durumunu goster',
    '- review yap ve sonraki milestonea gec',
    '- hangi tasklar calisiyor',
    '- worker durumlarini goster',
  ].join('\n')
}

export function createSupervisor(config: SupervisorConfig = {}) {
  return {
    config,
    renderHelp(): string {
      return renderSupervisorHelp()
    },
    async handleMessage(
      inputText: string,
      sessionId: string,
      sessions: SupervisorSessionState,
    ): Promise<SupervisorReply> {
      const trimmed = inputText.trim()
      if (!trimmed) {
        return { reply: 'Bir hedef yaz; analyze, fix veya autopilot akisini ben seceyim.' }
      }

      const currentSession = sessions[sessionId] ?? {}
      const nextSessions: SupervisorSessionState = {
        ...sessions,
        [sessionId]: { ...currentSession },
      }
      const normalized = normalize(trimmed)

      if (isHelpIntent(normalized)) {
        return { reply: renderSupervisorHelp(), updatedSessions: nextSessions }
      }

      if (includesAny(normalized, ['workspace olustur', 'workspace oluştur', 'session olustur'])) {
        const workspaceSession = await createWorkspaceSession(config, {
          id: sessionId,
          goal: trimmed,
          workerSurface: nextSessions[sessionId]?.workerSurface ?? 'aider',
          controlSurfaces: ['terminal', 'telegram', 'ide'],
        })
        nextSessions[sessionId] = {
          ...nextSessions[sessionId],
          workspaceSessionId: workspaceSession.id,
          workerSurface: workspaceSession.workerSurface,
        }
        return {
          reply: `Workspace session hazir. Varsayilan worker ${workspaceSession.workerSurface}. Simdi proje kesfi baslatabilirim.`,
          updatedSessions: nextSessions,
        }
      }

      if (includesAny(normalized, ['workspace durum', 'session durum', 'workspace status'])) {
        const workspaceSessionId = nextSessions[sessionId]?.workspaceSessionId ?? sessionId
        const workspace = await getWorkspaceSession(config, workspaceSessionId)
        if (!workspace) {
          return {
            reply: 'Bu session icin henuz workspace kaydi yok.',
            updatedSessions: nextSessions,
          }
        }
        return {
          reply: [
            `Workspace: ${workspace.status} · worker ${workspace.workerSurface}`,
            `Goal: ${workspace.goal}`,
            `Repos: ${workspace.managedRepos.length}`,
            workspace.latestSummary ?? 'Ozet yok.',
          ].join('\n'),
          updatedSessions: nextSessions,
        }
      }

      if (includesAny(normalized, ['repo kesfet', 'projeleri kesfet', 'discover repos'])) {
        const workspaceSessionId = nextSessions[sessionId]?.workspaceSessionId ?? sessionId
        const exists = await getWorkspaceSession(config, workspaceSessionId)
        if (!exists) {
          await createWorkspaceSession(config, {
            id: workspaceSessionId,
            goal: trimmed,
            workerSurface: nextSessions[sessionId]?.workerSurface ?? 'aider',
            controlSurfaces: ['terminal', 'telegram', 'ide'],
          })
        }
        const workspace = (await postSessionAction(
          config,
          workspaceSessionId,
          'discover',
        )) as unknown as WorkspaceSession
        const focusedRepoPath = workspace.managedRepos.find(
          (repo) => repo.repoId === workspace.focusRepoId,
        )?.rootPath
        nextSessions[sessionId] = {
          ...nextSessions[sessionId],
          workspaceSessionId,
          ...(workspace.focusRepoId ? { activeRepoId: workspace.focusRepoId } : {}),
          ...(focusedRepoPath ? { activeRepoPath: displayRepoPath(focusedRepoPath) } : {}),
          workerSurface: workspace.workerSurface,
        }
        return {
          reply: workspace.latestSummary ?? `${workspace.managedRepos.length} repo bulundu.`,
          updatedSessions: nextSessions,
        }
      }

      const provider = parseProvider(normalized)
      if (provider && includesAny(normalized, ['kullan', 'olsun', 'gec'])) {
        nextSessions[sessionId] = {
          ...nextSessions[sessionId],
          provider,
        }
        return {
          reply: `Varsayilan provider artik ${provider}.`,
          updatedSessions: nextSessions,
        }
      }

      const model = parseModel(normalized)
      if (model && includesAny(normalized, ['model', 'olsun', 'kullan'])) {
        nextSessions[sessionId] = {
          ...nextSessions[sessionId],
          model,
        }
        return {
          reply: `Varsayilan model artik ${model}.`,
          updatedSessions: nextSessions,
        }
      }

      if (includesAny(normalized, ['aider kullan', 'aider olsun'])) {
        nextSessions[sessionId] = { ...nextSessions[sessionId], workerSurface: 'aider' }
        return { reply: 'Varsayilan worker surface artik aider.', updatedSessions: nextSessions }
      }
      if (includesAny(normalized, ['roo kullan', 'roo olsun'])) {
        nextSessions[sessionId] = { ...nextSessions[sessionId], workerSurface: 'roo' }
        return { reply: 'Varsayilan worker surface artik roo.', updatedSessions: nextSessions }
      }
      if (includesAny(normalized, ['openclaw kullan', 'openclaw worker'])) {
        nextSessions[sessionId] = { ...nextSessions[sessionId], workerSurface: 'openclaw' }
        return {
          reply: 'Varsayilan worker surface artik openclaw.',
          updatedSessions: nextSessions,
        }
      }

      if (
        includesAny(normalized, [
          'desktoptaki projeleri listele',
          'desktoptaki projeleri goster',
          'desktop projelerini listele',
          'projeleri listele',
          'projeleri goster',
          'proje kesfi yap',
        ])
      ) {
        const projects = listDiscoveredProjects()
        return {
          reply:
            projects.length === 0
              ? 'Gorunur bir proje bulamadim.'
              : [
                  'Buldugum proje adaylarini listeliyorum.',
                  '',
                  ...projects.map((project) => `- ${project.name} -> ${project.path}`),
                ].join('\n'),
          updatedSessions: nextSessions,
        }
      }

      if (isFrustrationWithoutTask(normalized) || !hasTaskIntent(normalized)) {
        return {
          reply: renderClarificationHelp(nextSessions[sessionId]?.activeRepoPath),
          updatedSessions: nextSessions,
        }
      }

      const repos = await listRepos(config)

      if (includesAny(normalized, ['reposuna gec', 'repoya gec', 'repoya gec', 'repo sec'])) {
        const repo = resolveRepoFromText(repos, normalized)
        if (!repo) {
          return {
            reply: renderRepoSelectionHelp(repos),
            updatedSessions: nextSessions,
          }
        }
        nextSessions[sessionId] = {
          ...nextSessions[sessionId],
          activeRepoId: repo.id,
          activeRepoPath: displayRepoPath(repo.rootPath),
        }
        const workspaceSessionId = nextSessions[sessionId]?.workspaceSessionId
        if (workspaceSessionId) {
          await postSessionAction(config, workspaceSessionId, 'control', {
            action: 'focus',
            focusRepoId: repo.id,
            summary: `${displayRepoPath(repo.rootPath)} focused from supervisor.`,
          }).catch(() => undefined)
        }
        return {
          reply: `${displayRepoPath(repo.rootPath)} artik aktif repo. Bundan sonra burada calisacagim.`,
          updatedSessions: nextSessions,
        }
      }

      if (includesAny(normalized, ['review yap', 'review now', 'inceleme yap'])) {
        const { updatedSessions } = await ensureWorkspaceReady(config, sessionId, nextSessions, trimmed)
        const workspaceSessionId = updatedSessions[sessionId]?.workspaceSessionId ?? sessionId
        const job = await postSessionAction(config, workspaceSessionId, 'review', {})
        return {
          reply: `Review turu kuyruga alindi. Job: ${String(job.id ?? 'queued')}`,
          updatedSessions,
        }
      }

      if (
        includesAny(normalized, [
          'kill tum agent',
          'kill tum worker',
          'kill all agents',
          'tum agentlari durdur',
          'tum ajanlari durdur',
          'hepsini durdur',
          'dur dur',
          'once dur',
          'önce dur',
          'iptal et',
          'cancel current',
          'mevcut gorevi iptal et',
          'mevcut görevi iptal et',
        ])
      ) {
        const taskId = nextSessions[sessionId]?.activeTaskId
        const workspaceSessionId = nextSessions[sessionId]?.workspaceSessionId
        if (taskId) {
          await controlTask(config, taskId, 'cancel').catch(() => undefined)
        }
        if (workspaceSessionId) {
          await postSessionAction(config, workspaceSessionId, 'control', {
            action: 'pause',
            summary: 'Paused from supervisor command.',
          }).catch(() => undefined)
        }
        return {
          reply: 'Aktif gorevleri durdurdum. Yeni komutu hazirim.',
          updatedSessions: nextSessions,
        }
      }

      if (includesAny(normalized, ['hangi task', 'tasklar', 'ne yapiyorsun', 'ne yapıyorsun'])) {
        const tasks = await listTasks(config)
        const visible = tasks.filter((task) => task.sessionId === sessionId).slice(0, 5)
        if (visible.length === 0) {
          return {
            reply: 'Bu session icin aktif task yok.',
            updatedSessions: nextSessions,
          }
        }
        return {
          reply: [
            'Su an gordugum tasklar:',
            ...visible.map(
              (task) => `- ${task.mode} · ${task.status} · ${task.latestSummary ?? task.goal}`,
            ),
          ].join('\n'),
          updatedSessions: nextSessions,
        }
      }

      if (includesAny(normalized, ['worker durum', 'workerlari goster', 'workerları göster'])) {
        const workers = await listWorkers(config)
        return {
          reply:
            workers.length === 0
              ? 'Su an gorunen worker yok.'
              : [
                  'Worker durumu:',
                  ...workers.map((worker) => `- ${worker.kind} · ${worker.status}`),
                ].join('\n'),
          updatedSessions: nextSessions,
        }
      }

      if (includesAny(normalized, ['neden durdu', 'devam plani ne', 'devam plani ne'])) {
        const taskId = nextSessions[sessionId]?.activeTaskId
        const task = taskId ? await getTask(config, taskId) : undefined
        if (!task) {
          return {
            reply: 'Bu session icin aktif task bulamadim.',
            updatedSessions: nextSessions,
          }
        }
        return {
          reply: [
            `${task.mode} gorevi su an ${task.status}.`,
            task.blockedReason ?? task.latestSummary ?? 'Ek detay yok.',
          ].join('\n\n'),
          updatedSessions: nextSessions,
        }
      }

      let routedSessions = nextSessions
      if (!routedSessions[sessionId]?.activeRepoId) {
        const ensured = await ensureWorkspaceReady(config, sessionId, routedSessions, trimmed)
        routedSessions = ensured.updatedSessions
      }

      const activeRepoId = routedSessions[sessionId]?.activeRepoId
      const repo = activeRepoId
        ? repos.find((entry) => entry.id === activeRepoId)
        : resolveRepoFromText(repos, normalized)
      if (repo) {
        routedSessions[sessionId] = {
          ...routedSessions[sessionId],
          activeRepoId: repo.id,
          activeRepoPath: displayRepoPath(repo.rootPath),
        }
      }

      if (!routedSessions[sessionId]?.activeRepoId) {
        return {
          reply: renderRepoSelectionHelp(repos),
          updatedSessions: routedSessions,
        }
      }

      const mode = inferMode(normalized)
      const workspaceSessionId = routedSessions[sessionId]?.workspaceSessionId ?? sessionId
      const workspace =
        routedSessions[sessionId]?.workspaceSessionId
          ? await getWorkspaceSession(config, workspaceSessionId)
          : undefined
      const requestedRepos = workspace ? parseRepoMentions(workspace, trimmed) : []
      const backendRequirement = extractBackendRequirement(trimmed)
      if (workspace && backendRequirement) {
        const backendRepo = workspace.managedRepos.find((repo) => {
          const repoPath = displayRepoPath(repo.rootPath)
          const repoName = normalize(repoPath.split('/').at(-1) ?? repoPath).replaceAll(' ', '')
          return repoName.includes(backendRequirement.replaceAll(' ', ''))
        })
        if (backendRepo && !requestedRepos.some((repo) => repo.repoId === backendRepo.repoId)) {
          requestedRepos.unshift(backendRepo)
        }
      }

      if (mode === 'autopilot' && workspace && requestedRepos.length >= 2) {
        const tasks: Task[] = []
        for (const managedRepo of requestedRepos) {
          const repoGoal = [
            trimmed,
            backendRequirement
              ? `Bu projenin backend baglantisi icin ana backend referansi ${backendRequirement}.`
              : null,
            managedRepo.rootPath.includes('subs-api') || managedRepo.rootPath.includes('subs_api')
              ? 'Bu repo backend omurgasi olarak once ele alinmali.'
              : null,
          ]
            .filter(Boolean)
            .join('\n\n')
          const task = await createTask(config, {
            goal: repoGoal,
            mode: 'autopilot',
            sessionId,
            repoId: managedRepo.repoId,
            workerSurface: routedSessions[sessionId].workerSurface ?? 'aider',
            successCriteria: backendRequirement
              ? `${displayRepoPath(managedRepo.rootPath)} icin gelistirme yapilirken backend entegrasyonu ${backendRequirement} ile uyumlu olsun.`
              : inferSuccessCriteria('autopilot', trimmed),
            maxCycles: 8,
          })
          tasks.push(task)
        }
        routedSessions[sessionId] = {
          ...routedSessions[sessionId],
          activeTaskId: tasks[0]?.id ?? '',
          lastMode: 'autopilot',
        }
        return {
          reply: `${requestedRepos.length} repo icin paralel autopilot akisini baslatiyorum. Backend omurgasi olarak ${backendRequirement ?? 'aktif backend'} baz alinacak.`,
          tasks,
          updatedSessions: routedSessions,
        }
      }

      if (mode === 'autopilot' && routedSessions[sessionId]?.workspaceSessionId) {
        const task = (await postSessionAction(config, workspaceSessionId, 'autopilot', {
          goal: trimmed,
        })) as unknown as Task
        routedSessions[sessionId] = {
          ...routedSessions[sessionId],
          activeTaskId: task.id,
          lastMode: mode,
        }
        return {
          reply: `${routedSessions[sessionId].activeRepoPath ?? 'Aktif repo'} icin session-aware autopilot baslatiyorum.`,
          task,
          updatedSessions: routedSessions,
        }
      }
      const task = await createTask(config, {
        goal: trimmed,
        mode,
        sessionId,
        repoId: routedSessions[sessionId].activeRepoId,
        ...(routedSessions[sessionId].provider ? { provider: routedSessions[sessionId].provider } : {}),
        ...(routedSessions[sessionId].model ? { model: routedSessions[sessionId].model } : {}),
        ...(routedSessions[sessionId].workerSurface
          ? { workerSurface: routedSessions[sessionId].workerSurface }
          : {}),
        successCriteria: inferSuccessCriteria(mode, trimmed),
        maxCycles: mode === 'autopilot' ? 8 : 1,
      })

      routedSessions[sessionId] = {
        ...routedSessions[sessionId],
        activeTaskId: task.id,
        lastMode: mode,
      }

      const repoName = routedSessions[sessionId].activeRepoPath ?? 'aktif repo'
      const reply =
        mode === 'analyze'
          ? `${repoName} uzerinde read-only analiz baslatiyorum. Loop calistirmadan repo yapisi, git durumu ve riskleri cikaracagim.`
          : mode === 'fix'
            ? `${repoName} icin fix akisini baslatiyorum. Once durumu okuyup en guvenli degisiklik yolunu sececegim.`
            : `${repoName} icin uzun kosu autopilot baslatiyorum. Hedefi plana baglayip checkpoint alarak ilerleyecegim.`

      return {
        reply,
        task,
        updatedSessions: routedSessions,
      }
    },
    async probeMonitoring(): Promise<{
      tasks: Task[]
      workers: WorkerInfo[]
      sessions: SessionInfo[]
    }> {
      const [tasks, workers, sessions] = await Promise.all([
        listTasks(config),
        listWorkers(config),
        listSessions(config),
      ])
      return { tasks, workers, sessions }
    },
  }
}

export const supervisorPackage = {
  name: '@coco/openclaw-supervisor',
  status: 'ready',
  message: 'Shared OpenClaw supervisor runtime for analyze, fix, autopilot, and monitoring.',
} as const
