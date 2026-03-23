import { describe, expect, it } from 'vitest'

import {
  COMMAND_DISPOSITIONS,
  DEFAULT_COMMAND_POLICY,
  DEFAULT_SCORING_MODEL,
  DOCTOR_PHASES,
  LOOP_MODES,
  PATCH_FORMATS,
  PATCH_OPERATIONS,
  type PluginManifest,
  REVIEW_CHECK_KINDS,
  type RepoRef,
  SCORE_CATEGORIES,
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
  })
})
