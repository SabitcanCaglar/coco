import type { CocoId } from './shared.js'

export const COMMAND_EFFECTS = ['read', 'write', 'network', 'process', 'git'] as const

export type CommandEffect = (typeof COMMAND_EFFECTS)[number]

export const COMMAND_DISPOSITIONS = ['allow', 'deny', 'ask'] as const

export type CommandDisposition = (typeof COMMAND_DISPOSITIONS)[number]

export interface CommandRequest {
  argv: string[]
  cwd: string
}

export interface CommandRule {
  id: CocoId
  description: string
  effect: CommandEffect
  disposition: CommandDisposition
  command: string
  argsPrefix?: string[]
  workingDirectory?: string
  reason?: string
}

export interface CommandDecision {
  disposition: CommandDisposition
  reason: string
  normalizedCommand: string
  matchedRuleId?: CocoId
}

export interface CommandPolicy {
  id: CocoId
  version: string
  defaultDisposition: CommandDisposition
  rules: CommandRule[]
}

export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
  id: 'default-command-policy',
  version: '0.1.0',
  defaultDisposition: 'ask',
  rules: [
    {
      id: 'allow-rg',
      description: 'Allow ripgrep for repository exploration.',
      effect: 'read',
      disposition: 'allow',
      command: 'rg',
    },
    {
      id: 'allow-find',
      description: 'Allow basic file discovery commands.',
      effect: 'read',
      disposition: 'allow',
      command: 'find',
    },
    {
      id: 'allow-git-status',
      description: 'Allow non-destructive git inspection.',
      effect: 'git',
      disposition: 'allow',
      command: 'git',
      argsPrefix: ['status'],
    },
    {
      id: 'deny-destructive-git-reset',
      description: 'Block destructive git resets by default.',
      effect: 'git',
      disposition: 'deny',
      command: 'git',
      argsPrefix: ['reset', '--hard'],
      reason: 'Destructive history rewrites require an explicit override.',
    },
    {
      id: 'ask-package-install',
      description: 'Escalate package manager installs and writes.',
      effect: 'write',
      disposition: 'ask',
      command: 'pnpm',
      argsPrefix: ['install'],
    },
  ],
}
