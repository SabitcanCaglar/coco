import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { RepoRef, SessionInfo, Task, TaskCreateInput, TaskMode, WorkerInfo } from '@coco/core'

export interface SupervisorSession {
  activeRepoId?: string
  activeRepoPath?: string
  provider?: string
  model?: string
  activeTaskId?: string
  lastMode?: TaskMode
}

export type SupervisorSessionState = Record<string, SupervisorSession>

export interface SupervisorConfig {
  daemonUrl?: string
}

export interface SupervisorReply {
  reply: string
  updatedSessions?: SupervisorSessionState
  task?: Task
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

function parseProvider(text: string): string | undefined {
  return ['null', 'ollama', 'openrouter', 'openclaw'].find((provider) => text.includes(provider))
}

function parseModel(text: string): string | undefined {
  return text.match(/\b[a-z0-9._:-]+\/[a-z0-9._:-]+\b/i)?.[0]
}

function inferMode(text: string): TaskMode {
  if (
    includesAny(text, ['bitene kadar', 'devam et', 'plani birakma', 'planı bırakma', 'saatlerce'])
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

function listDesktopProjects(): Array<{ name: string; path: string }> {
  const root = desktopRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(root, entry.name),
    }))
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
    const rootPath = normalize(repo.rootPath)
    const name = normalize(repo.rootPath.split('/').at(-1) ?? '')
    return normalized.includes(rootPath) || normalized.includes(name)
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

function renderRepoSelectionHelp(repos: RepoRef[]): string {
  if (repos.length > 0) {
    return [
      'Hangi repoda calisacagimi once netlestirmem gerekiyor.',
      ...repos.slice(0, 10).map((repo) => `- ${repo.rootPath}`),
      '',
      'Ornek: "cognify-subs-api reposuna gec"',
    ].join('\n')
  }
  const desktopProjects = listDesktopProjects()
  if (desktopProjects.length > 0) {
    return [
      'Hangi repoda calisacagimi once netlestirmem gerekiyor.',
      ...desktopProjects.slice(0, 10).map((project) => `- ${project.name} -> ${project.path}`),
      '',
      'Ornek: "Desktoptaki projeleri listele" ya da "subs-api reposuna gec"',
    ].join('\n')
  }
  return 'Hangi repoda calisacagimi once netlestirmem gerekiyor.'
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

      if (includesAny(normalized, ['yardim', 'help', 'ne yapabiliyorsun'])) {
        return { reply: renderSupervisorHelp(), updatedSessions: nextSessions }
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

      if (
        includesAny(normalized, [
          'desktoptaki projeleri listele',
          'desktoptaki projeleri goster',
          'desktop projelerini listele',
        ])
      ) {
        const projects = listDesktopProjects()
        return {
          reply:
            projects.length === 0
              ? 'Desktop altinda gorunur bir proje bulamadim.'
              : [
                  'Desktop projelerini listeliyorum.',
                  '',
                  ...projects.map((project) => `- ${project.name} -> ${project.path}`),
                ].join('\n'),
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
          activeRepoPath: repo.rootPath,
        }
        return {
          reply: `${repo.rootPath} artik aktif repo. Bundan sonra burada calisacagim.`,
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

      const activeRepoId = nextSessions[sessionId]?.activeRepoId
      const repo = activeRepoId
        ? repos.find((entry) => entry.id === activeRepoId)
        : resolveRepoFromText(repos, normalized)
      if (repo) {
        nextSessions[sessionId] = {
          ...nextSessions[sessionId],
          activeRepoId: repo.id,
          activeRepoPath: repo.rootPath,
        }
      }

      if (!nextSessions[sessionId]?.activeRepoId) {
        return {
          reply: renderRepoSelectionHelp(repos),
          updatedSessions: nextSessions,
        }
      }

      const mode = inferMode(normalized)
      const task = await createTask(config, {
        goal: trimmed,
        mode,
        sessionId,
        repoId: nextSessions[sessionId].activeRepoId,
        ...(nextSessions[sessionId].provider ? { provider: nextSessions[sessionId].provider } : {}),
        ...(nextSessions[sessionId].model ? { model: nextSessions[sessionId].model } : {}),
        successCriteria: inferSuccessCriteria(mode, trimmed),
        maxCycles: mode === 'autopilot' ? 8 : 1,
      })

      nextSessions[sessionId] = {
        ...nextSessions[sessionId],
        activeTaskId: task.id,
        lastMode: mode,
      }

      const repoName = nextSessions[sessionId].activeRepoPath ?? 'aktif repo'
      const reply =
        mode === 'analyze'
          ? `${repoName} uzerinde read-only analiz baslatiyorum. Loop calistirmadan repo yapisi, git durumu ve riskleri cikaracagim.`
          : mode === 'fix'
            ? `${repoName} icin fix akisini baslatiyorum. Once durumu okuyup en guvenli degisiklik yolunu sececegim.`
            : `${repoName} icin uzun kosu autopilot baslatiyorum. Hedefi plana baglayip checkpoint alarak ilerleyecegim.`

      return {
        reply,
        task,
        updatedSessions: nextSessions,
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
