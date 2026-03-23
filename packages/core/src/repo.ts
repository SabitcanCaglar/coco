import type { CocoId, ISO8601Timestamp } from './shared.js'

export type RepoStatus = 'active' | 'paused' | 'archived'

export interface RepoRef {
  id: CocoId
  rootPath: string
  defaultBranch: string
  languageHints: string[]
  status: RepoStatus
  createdAt: ISO8601Timestamp
  updatedAt: ISO8601Timestamp
}
