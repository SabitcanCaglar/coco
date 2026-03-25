import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  type SupervisorSessionState,
  createSupervisor,
  renderSupervisorHelp,
} from '@coco/openclaw-supervisor'

export interface TelegramBotConfig {
  token?: string
  daemonUrl?: string
  allowedChatIds?: number[]
  stateDir?: string
  pollingTimeoutSeconds?: number
  fetchImpl?: typeof fetch
  planner?: unknown
}

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: {
      id: number
      type: string
    }
    text?: string
  }
}

interface TelegramResponse<T> {
  ok: boolean
  result: T
}

function nowPath(config?: TelegramBotConfig): string {
  const root =
    config?.stateDir ?? process.env.COCO_HOME ?? join(homedir(), '.local', 'share', 'coco')
  return join(root, 'telegram')
}

export function loadEnvFile(): void {
  const envPath = resolve(process.env.COCO_ENV_FILE ?? '.env')
  if (!existsSync(envPath)) return
  const content = readFileSync(envPath, 'utf-8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line
      .slice(index + 1)
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

function parseAllowedChats(raw: string | undefined): number[] {
  return (raw ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value))
}

function loadSessions(stateDir: string): SupervisorSessionState {
  const filePath = join(stateDir, 'sessions.json')
  if (!existsSync(filePath)) {
    return {}
  }
  return JSON.parse(readFileSync(filePath, 'utf-8')) as SupervisorSessionState
}

function saveSessions(stateDir: string, sessions: SupervisorSessionState): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify(sessions, null, 2), 'utf-8')
}

async function telegramRequest<T>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const body = (await response.json()) as TelegramResponse<T>
  if (!body.ok) {
    throw new Error(`Telegram API call failed for ${method}.`)
  }
  return body.result
}

async function sendMessage(
  fetchImpl: typeof fetch,
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  await telegramRequest(fetchImpl, token, 'sendMessage', {
    chat_id: chatId,
    text,
  })
}

export function createTelegramBot(config: TelegramBotConfig = {}) {
  loadEnvFile()
  const token = config.token ?? process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN.')
  }
  const botToken = token
  const daemonUrl = config.daemonUrl ?? process.env.COCO_DAEMON_URL ?? 'http://127.0.0.1:3000'
  const allowedChatIds =
    config.allowedChatIds ?? parseAllowedChats(process.env.TELEGRAM_ALLOWED_CHAT_IDS)
  const stateDir = nowPath(config)
  const pollingTimeoutSeconds =
    config.pollingTimeoutSeconds ?? Number(process.env.TELEGRAM_POLL_TIMEOUT ?? 20)
  const fetchImpl = config.fetchImpl ?? fetch
  const supervisor = createSupervisor({
    daemonUrl,
  })
  let offset = 0
  let running = false
  let autopilotTimer: NodeJS.Timeout | undefined

  async function handleText(chatId: number, text: string): Promise<string> {
    if (allowedChatIds.length > 0 && !allowedChatIds.includes(chatId)) {
      return 'unauthorized chat'
    }

    const sessions = loadSessions(stateDir)
    const result = await supervisor.handleMessage(text, String(chatId), sessions)
    if (result.updatedSessions) {
      saveSessions(stateDir, result.updatedSessions)
    }
    return result.reply
  }

  async function probeDaemon(): Promise<{
    daemonUrl: string
    health: Record<string, unknown>
    repos: unknown[]
    jobs: unknown[]
  }> {
    const [healthResponse, reposResponse, jobsResponse] = await Promise.all([
      fetchImpl(`${daemonUrl}/health`),
      fetchImpl(`${daemonUrl}/repos`),
      fetchImpl(`${daemonUrl}/jobs`),
    ])

    if (!healthResponse.ok) {
      throw new Error(`daemon health probe failed: ${healthResponse.status}`)
    }
    if (!reposResponse.ok) {
      throw new Error(`daemon repos probe failed: ${reposResponse.status}`)
    }
    if (!jobsResponse.ok) {
      throw new Error(`daemon jobs probe failed: ${jobsResponse.status}`)
    }

    return {
      daemonUrl,
      health: (await healthResponse.json()) as Record<string, unknown>,
      repos: (await reposResponse.json()) as unknown[],
      jobs: (await jobsResponse.json()) as unknown[],
    }
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    offset = update.update_id + 1
    const message = update.message
    if (!message?.text) return
    if (allowedChatIds.length > 0 && !allowedChatIds.includes(message.chat.id)) {
      await sendMessage(fetchImpl, botToken, message.chat.id, 'unauthorized chat')
      return
    }

    try {
      const reply = await handleText(message.chat.id, message.text)
      await sendMessage(fetchImpl, botToken, message.chat.id, reply)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      await sendMessage(fetchImpl, botToken, message.chat.id, `error: ${messageText}`)
    }
  }

  async function pollOnce(): Promise<void> {
    const updates = await telegramRequest<TelegramUpdate[]>(fetchImpl, botToken, 'getUpdates', {
      offset,
      timeout: pollingTimeoutSeconds,
      allowed_updates: ['message'],
    })
    for (const update of updates) {
      await handleUpdate(update)
    }
  }

  return {
    config: {
      daemonUrl,
      stateDir,
      pollingTimeoutSeconds,
      allowedChatIds,
    },
    renderHelp(): string {
      return renderSupervisorHelp()
    },
    handleText,
    probeDaemon,
    async start(): Promise<void> {
      running = true
      autopilotTimer = setInterval(() => {
        const sessions = loadSessions(stateDir)
        void supervisor
          .probeMonitoring()
          .then((probe) => {
            saveSessions(stateDir, sessions)
            return probe
          })
          .catch((error) => {
            console.error(error)
          })
      }, 15_000)

      while (running) {
        await pollOnce().catch((error) => {
          console.error(error)
        })
      }
    },
    stop(): void {
      running = false
      if (autopilotTimer) {
        clearInterval(autopilotTimer)
      }
    },
  }
}

export const telegramPackage = {
  name: '@coco/telegram',
  status: 'ready',
  message: 'Telegram transport for the shared OpenClaw agent runtime.',
} as const

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false
}

if (isDirectExecution()) {
  const bot = createTelegramBot()
  void bot.start()
}
