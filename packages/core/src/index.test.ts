import { describe, expect, it } from 'vitest'

import {
  COMMAND_DISPOSITIONS,
  DEFAULT_COMMAND_POLICY,
  DEFAULT_SCORING_MODEL,
  DOCTOR_PHASES,
  LOOP_MODES,
  PATCH_FORMATS,
  PATCH_OPERATIONS,
  REVIEW_CHECK_KINDS,
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
})
