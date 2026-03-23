#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { RepoRef } from '@coco/core'
import { DoctorRuntime } from '@coco/doctor'
import { runKarpathyLoop } from '@coco/loop'
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

function getPluginPaths(): string[] {
  return (process.env.COCO_PLUGIN_PATHS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
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

function parseFlag(args: string[], flag: string, fallback?: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function printOutput(io: CLIIO, jsonMode: boolean, payload: unknown, human: string): void {
  io.write(jsonMode ? JSON.stringify(payload, null, 2) : human)
}

export async function runCLI(argv: string[], io: CLIIO = defaultIO): Promise<number> {
  const [group, action, maybeSubject, ...remaining] = argv
  const subject = maybeSubject?.startsWith('--') ? undefined : maybeSubject
  const rest = maybeSubject?.startsWith('--') ? [maybeSubject, ...remaining] : remaining
  const jsonMode = hasFlag(rest, '--json')

  try {
    if (group === 'daemon' && action === 'start') {
      const createDaemon = await loadCreateDaemon()
      const daemon = createDaemon()
      await daemon.start()
      io.write(`coco daemon listening on ${daemon.url()}`)
      return await new Promise<number>(() => 0)
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

    io.write(`Usage:
coco repo add <path> [--json]
coco doctor run <repo-or-path> [--json]
coco plugins list [--json]
coco plugins inspect <name> [--json]
coco loop run <repo-or-path> [--rounds N] [--provider null|ollama] [--model NAME] [--json]
coco loop inspect <repo-path> [--rounds N] [--provider null|ollama] [--model NAME] [--json]
coco review run <repo-path> [--json]
coco daemon start`)
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
