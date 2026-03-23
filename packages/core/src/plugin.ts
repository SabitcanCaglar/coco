import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { Diagnosis, DoctorFinding, Prescription } from './doctor.js'
import type { LLMProviderContract } from './llm.js'
import type { Observation } from './observation.js'
import type { RepoRef } from './repo.js'
import type { ReviewCheckResult, ReviewViolation } from './review.js'

export const PLUGIN_KINDS = ['framework-expert', 'review-check', 'llm-provider'] as const
export const PLUGIN_ENTRY_EXTENSIONS = ['.js', '.mjs'] as const

export type PluginKind = (typeof PLUGIN_KINDS)[number]

export type PluginSource = 'builtin' | 'external'

export interface PluginManifest {
  name: string
  version: string
  kind: PluginKind
  capabilities: string[]
  source?: PluginSource
  description?: string
  entrypoint?: string
  cocoVersion?: string
}

export interface PluginCompatibility {
  supported: boolean
  reason: string
}

export interface PluginValidationResult {
  valid: boolean
  errors: string[]
}

export interface FrameworkExpertContext {
  repo: RepoRef
  observation: Observation
}

export interface FrameworkExpertPluginDefinition {
  framework: string
  name: string
  description?: string
  detect(context: FrameworkExpertContext): boolean
  find(context: FrameworkExpertContext): DoctorFinding[]
  prescribe(context: FrameworkExpertContext, findings: DoctorFinding[]): Prescription[]
  diagnose?(findings: DoctorFinding[]): Diagnosis[]
}

export interface ReviewCheckPluginContext {
  projectPath: string
  patchApplied: boolean
}

export interface ReviewCheckExecutionResult {
  result: ReviewCheckResult
  violations?: ReviewViolation[]
}

export interface ReviewCheckPluginDefinition {
  id: string
  name: string
  kind: 'diff' | 'build' | 'test' | 'lint' | 'policy'
  required: boolean
  discover(context: ReviewCheckPluginContext): string[] | null | Promise<string[] | null>
  run(
    context: ReviewCheckPluginContext,
    command: string[] | null,
  ): ReviewCheckExecutionResult | Promise<ReviewCheckExecutionResult>
}

export interface FrameworkExpertPlugin {
  manifest: PluginManifest & { kind: 'framework-expert' }
  expert: FrameworkExpertPluginDefinition
}

export interface ReviewCheckPlugin {
  manifest: PluginManifest & { kind: 'review-check' }
  check: ReviewCheckPluginDefinition
}

export interface LLMProviderPlugin {
  manifest: PluginManifest & { kind: 'llm-provider' }
  provider: LLMProviderContract
}

export type CocoPluginModule = FrameworkExpertPlugin | ReviewCheckPlugin | LLMProviderPlugin

export function validatePluginManifest(manifest: PluginManifest): PluginValidationResult {
  const errors: string[] = []
  if (!manifest.name.trim()) errors.push('Plugin manifest name is required.')
  if (!manifest.version.trim()) errors.push('Plugin manifest version is required.')
  if (!PLUGIN_KINDS.includes(manifest.kind)) {
    errors.push(`Unsupported plugin kind "${manifest.kind}".`)
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    errors.push('Plugin manifest capabilities must contain at least one capability.')
  }
  return {
    valid: errors.length === 0,
    errors,
  }
}

export function validatePluginModule(plugin: CocoPluginModule): PluginValidationResult {
  const manifestValidation = validatePluginManifest(plugin.manifest)
  const errors = [...manifestValidation.errors]

  if (plugin.manifest.kind === 'framework-expert') {
    const frameworkPlugin = plugin as FrameworkExpertPlugin
    if (!frameworkPlugin.expert.framework.trim()) {
      errors.push('Framework expert plugins must declare a framework id.')
    }
  }

  if (plugin.manifest.kind === 'review-check') {
    const reviewPlugin = plugin as ReviewCheckPlugin
    if (!reviewPlugin.check.id.trim()) {
      errors.push('Review check plugins must declare a check id.')
    }
  }

  if (plugin.manifest.kind === 'llm-provider') {
    const llmPlugin = plugin as LLMProviderPlugin
    if (!llmPlugin.provider.name.trim()) {
      errors.push('LLM provider plugins must expose a provider name.')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export function checkPluginCompatibility(
  manifest: PluginManifest,
  cocoVersion = '0.1.0',
): PluginCompatibility {
  if (!manifest.cocoVersion) {
    return {
      supported: true,
      reason: 'Plugin did not declare a cocoVersion constraint.',
    }
  }

  const supported = manifest.cocoVersion === cocoVersion
  return {
    supported,
    reason: supported
      ? `Plugin targets coco ${cocoVersion}.`
      : `Plugin targets coco ${manifest.cocoVersion}, current runtime is ${cocoVersion}.`,
  }
}

export async function resolvePluginEntrypoints(pluginPaths: string[]): Promise<string[]> {
  const resolved = new Set<string>()

  for (const pluginPath of pluginPaths) {
    const absolutePath = resolve(pluginPath)
    const details = await stat(absolutePath).catch(() => null)
    if (!details) {
      continue
    }

    if (details.isDirectory()) {
      const entries = await readdir(absolutePath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (!PLUGIN_ENTRY_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue
        resolved.add(resolve(absolutePath, entry.name))
      }
      continue
    }

    resolved.add(absolutePath)
  }

  return [...resolved].sort()
}
