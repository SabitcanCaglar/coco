import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function run(command, args) {
  return execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`)
  }
  return response.json()
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function runBehaviorSmoke() {
  const stateDir = await mkdtemp(join(tmpdir(), 'coco-runtime-smoke-state-'))
  const hostHome = await mkdtemp(join(tmpdir(), 'coco-runtime-smoke-home-'))
  const previousHostHome = process.env.COCO_HOST_HOME
  process.env.COCO_HOST_HOME = hostHome

  try {
    const repoPath = join(hostHome, 'Desktop', 'Subs-api')
    await mkdir(join(repoPath, '.git'), { recursive: true })
    await writeFile(join(repoPath, 'Subs-api.sln'), '')

    const { createTelegramBot } = await import('../packages/telegram/dist/index.js')
    const bot = createTelegramBot({
      token: 'telegram-test-token',
      daemonUrl: 'http://127.0.0.1:3000',
      stateDir,
      allowedChatIds: [123],
      planner: async () => ({
        reply: 'Desktop projelerini listeliyorum.',
        queue: 'desktop',
        taskScope: 'short',
      }),
    })

    const reply = await bot.handleText(123, "Desktop'taki projeleri listele")
    assert(reply.includes('Desktop projelerini listeliyorum.'), 'planner reply missing')
    assert(reply.includes('Subs-api'), 'desktop project missing from reply')
    assert(!reply.includes('"queue"'), 'planner JSON leaked queue field')
    assert(!reply.includes('"reply"'), 'planner JSON leaked reply field')
    assert(!reply.includes('fetch failed'), 'transport failure leaked to user reply')

    return {
      ok: true,
      reply,
    }
  } finally {
    if (previousHostHome === undefined) {
      process.env.COCO_HOST_HOME = undefined
    } else {
      process.env.COCO_HOST_HOME = previousHostHome
    }
    await rm(hostHome, { recursive: true, force: true })
    await rm(stateDir, { recursive: true, force: true })
  }
}

async function main() {
  const health = await fetchJson('http://127.0.0.1:3000/health')
  const repos = await fetchJson('http://127.0.0.1:3000/repos')
  const jobs = await fetchJson('http://127.0.0.1:3000/jobs')
  const inNetworkHealth = run('docker', [
    'compose',
    'exec',
    '-T',
    'telegram-bot',
    'node',
    '--input-type=module',
    '-e',
    "const res = await fetch('http://orchestrator:3000/health'); if (!res.ok) process.exit(1); console.log(await res.text())",
  ])
  const behaviorSmoke = await runBehaviorSmoke()

  console.log(
    JSON.stringify(
      {
        health,
        reposCount: Array.isArray(repos) ? repos.length : null,
        jobsCount: Array.isArray(jobs) ? jobs.length : null,
        inNetworkHealth: JSON.parse(inNetworkHealth),
        behaviorSmoke,
        composePs: run('docker', ['compose', 'ps']),
      },
      null,
      2,
    ),
  )
}

void main()
