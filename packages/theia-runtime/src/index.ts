import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn } from 'node:child_process'

import type { TheiaRuntimeConfig, TheiaRuntimeStatus } from '@coco/core'

export interface TheiaSidecarOptions {
  workspaceRoot?: string
  host?: string
  port?: number
  nodeCommand?: string
  nodeArgs?: string[]
  appPath?: string
  backendMainPath?: string
  logDir?: string
  env?: NodeJS.ProcessEnv
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
  bundleCommand?: string
  bundleArgs?: string[]
}

export interface TheiaSidecarController {
  getConfig(): TheiaRuntimeConfig
  getStatus(): TheiaRuntimeStatus
  start(): Promise<TheiaRuntimeStatus>
  stop(): Promise<void>
  probe(): Promise<TheiaRuntimeStatus>
}

function now(): string {
  return new Date().toISOString()
}

function workspacePackagesRoot(): string {
  return resolve(import.meta.dirname, '..', '..')
}

function defaultBrowserAppPath(): string {
  return resolve(workspacePackagesRoot(), 'theia-browser-app')
}

function defaultFrontendBundlePath(): string {
  return resolve(defaultBrowserAppPath(), 'lib', 'frontend', 'bundle.js')
}

function defaultBackendMainPath(): string {
  return resolve(defaultBrowserAppPath(), 'src-gen', 'backend', 'main.js')
}

function createShimFile(targetDir: string): string {
  mkdirSync(targetDir, { recursive: true })
  const shimPath = join(targetDir, 'native-shims.cjs')
  writeFileSync(
    shimPath,
    [
      "const Module = require('module')",
      'const originalLoad = Module._load',
      'Module._load = function(request, parent, isMain) {',
      "  if (request === 'drivelist' || request === 'drivelist/js/index.js') return { list: async () => [] }",
      "  if (request === '@parcel/watcher') return { subscribe: async () => ({ unsubscribe() {} }), writeSnapshot: async () => {}, getEventsSince: async () => [] }",
      "  if (request === 'bindings' && parent && parent.filename && parent.filename.includes('/drivelist/')) return () => ({ list: async () => [] })",
      '  return originalLoad.apply(this, arguments)',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  return shimPath
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

export function createTheiaRuntimeConfig(options: TheiaSidecarOptions = {}): TheiaRuntimeConfig {
  const logDir = options.logDir ?? join(tmpdir(), 'coco-theia-runtime')
  const logFilePath = join(logDir, 'theia-runtime.log')
  mkdirSync(dirname(logFilePath), { recursive: true })
  return {
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 3011,
    workspaceRoots: options.workspaceRoot ? [options.workspaceRoot] : [],
    logFilePath,
    nodeCommand: options.nodeCommand ?? 'npx',
    nodeArgs: options.nodeArgs ?? ['-y', 'node@20'],
  }
}

export function createTheiaSidecar(options: TheiaSidecarOptions = {}): TheiaSidecarController {
  const config = createTheiaRuntimeConfig(options)
  const appPath = options.appPath ?? defaultBrowserAppPath()
  const backendMainPath = options.backendMainPath ?? defaultBackendMainPath()
  const frontendBundlePath = defaultFrontendBundlePath()
  const spawnImpl = options.spawnImpl ?? spawn
  const fetchImpl = options.fetchImpl ?? fetch
  const shimPath = createShimFile(join(tmpdir(), `coco-theia-${randomUUID()}`))

  let child: ChildProcess | undefined
  let status: TheiaRuntimeStatus = {
    state: 'stopped',
    url: `http://${config.host}:${config.port}`,
    host: config.host,
    port: config.port,
    logFilePath: config.logFilePath,
  }

  async function probe(): Promise<TheiaRuntimeStatus> {
    try {
      const response = await fetchImpl(`${status.url}`)
      if (!response.ok) {
        status = {
          ...status,
          state: 'error',
          lastError: `Theia probe failed with ${response.status}.`,
        }
        return status
      }
      status = {
        ...status,
        state: 'ready',
        lastError: undefined,
      }
      return status
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      status = {
        ...status,
        state: 'error',
        lastError: message,
      }
      return status
    }
  }

  async function ensureFrontendBundle(): Promise<void> {
    if (existsSync(frontendBundlePath)) {
      return
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const bundler = spawnImpl(options.bundleCommand ?? 'pnpm', options.bundleArgs ?? ['bundle'], {
        cwd: appPath,
        env: {
          ...process.env,
          ...options.env,
        },
        stdio: ['ignore', openSync(config.logFilePath, 'a'), openSync(config.logFilePath, 'a')],
      })
      bundler.once('error', rejectPromise)
      bundler.once('exit', (code) => {
        if (code === 0 && existsSync(frontendBundlePath)) {
          resolvePromise()
          return
        }
        rejectPromise(new Error(`Theia bundle build failed with exit code ${code ?? 'unknown'}.`))
      })
    })
  }

  return {
    getConfig(): TheiaRuntimeConfig {
      return config
    },
    getStatus(): TheiaRuntimeStatus {
      return status
    },
    async start(): Promise<TheiaRuntimeStatus> {
      if (child && !child.killed) {
        return probe()
      }

      await ensureFrontendBundle()

      const args = [
        ...config.nodeArgs,
        '-r',
        shimPath,
        backendMainPath,
        '--hostname',
        config.host,
        '--port',
        String(config.port),
        ...config.workspaceRoots,
      ]
      const spawnOptions: SpawnOptions = {
        cwd: appPath,
        env: {
          ...process.env,
          ...options.env,
          COCO_THEIA_ORCHESTRATOR_URL:
            options.env?.COCO_THEIA_ORCHESTRATOR_URL ?? process.env.COCO_THEIA_ORCHESTRATOR_URL,
        },
        stdio: ['ignore', openSync(config.logFilePath, 'a'), openSync(config.logFilePath, 'a')],
      }
      child = spawnImpl(config.nodeCommand, args, spawnOptions)
      status = {
        ...status,
        state: 'starting',
        pid: child.pid ?? undefined,
        startedAt: now(),
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(500)
        const probed = await probe()
        if (probed.state === 'ready') {
          return probed
        }
      }
      return status
    },
    async stop(): Promise<void> {
      if (child && !child.killed) {
        child.kill()
      }
      child = undefined
      status = {
        ...status,
        state: 'stopped',
        pid: undefined,
      }
    },
    probe,
  }
}
