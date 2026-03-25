import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  COMMAND_DISPOSITIONS,
  DEFAULT_COMMAND_POLICY,
  DEFAULT_SCORING_MODEL,
  DOCTOR_PHASES,
  LOOP_MODES,
  PATCH_FORMATS,
  PATCH_OPERATIONS,
  PLUGIN_ENTRY_EXTENSIONS,
  PLUGIN_KINDS,
  type PluginManifest,
  REVIEW_CHECK_KINDS,
  type RepoRef,
  SCORE_CATEGORIES,
  TASK_MODES,
  TASK_STATUSES,
  type Task,
  WORKER_KINDS,
  checkPluginCompatibility,
  resolvePluginEntrypoints,
  validatePluginManifest,
} from './index.js'

describe('@coco/core', () => {
  it('exports the pure contract constants', () => {
    expect(SCORE_CATEGORIES).toEqual(['security', 'maintainability', 'reliability', 'size'])
    expect(LOOP_MODES).toEqual(['auto', 'deterministic', 'ollama', 'openclaw'])
    expect(DOCTOR_PHASES).toContain('diagnosis')
    expect(PATCH_OPERATIONS).toContain('update')
    expect(PATCH_FORMATS).toContain('unified-diff')
    expect(REVIEW_CHECK_KINDS).toContain('test')
    expect(COMMAND_DISPOSITIONS).toContain('ask')
    expect(PLUGIN_KINDS).toContain('llm-provider')
    expect(TASK_MODES).toContain('autopilot')
    expect(TASK_STATUSES).toContain('blocked')
    expect(WORKER_KINDS).toContain('fix-worker')
  })

  it('ships a default scoring model and command policy', () => {
    expect(DEFAULT_SCORING_MODEL.id).toBe('health-score-default')
    expect(DEFAULT_SCORING_MODEL.rules.length).toBeGreaterThan(0)
    expect(DEFAULT_COMMAND_POLICY.defaultDisposition).toBe('ask')
    expect(DEFAULT_COMMAND_POLICY.rules.some((rule) => rule.command === 'rg')).toBe(true)
  })

  it('exports repo and plugin contracts for runtime packages', () => {
    const repo: RepoRef = {
      id: 'repo-1',
      rootPath: '/tmp/repo',
      defaultBranch: 'main',
      languageHints: ['ts'],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const plugin: PluginManifest = {
      name: 'builtin-node',
      version: '0.1.0',
      kind: 'framework-expert',
      capabilities: ['detect', 'find', 'prescribe'],
    }

    expect(repo.status).toBe('active')
    expect(plugin.kind).toBe('framework-expert')
    expect(validatePluginManifest(plugin).valid).toBe(true)
    expect(checkPluginCompatibility(plugin).supported).toBe(true)
  })

  it('exports task and monitoring contracts for supervisor runtimes', () => {
    const task: Task = {
      id: 'task-1',
      goal: 'Inspect repo state',
      mode: 'analyze',
      status: 'queued',
      sessionId: 'session-1',
      plan: {
        steps: [],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    expect(task.mode).toBe('analyze')
    expect(task.status).toBe('queued')
  })

  it('resolves plugin entrypoints from directories', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'coco-plugin-dir-'))
    await writeFile(join(pluginDir, 'doctor-plugin.mjs'), 'export const plugin = {}')
    await writeFile(join(pluginDir, 'ignore.txt'), 'ignore')

    try {
      expect(PLUGIN_ENTRY_EXTENSIONS).toContain('.mjs')
      const entries = await resolvePluginEntrypoints([pluginDir])
      expect(entries).toHaveLength(1)
      expect(entries[0]).toContain('doctor-plugin.mjs')
    } finally {
      await rm(pluginDir, { recursive: true, force: true })
    }
  })
})
