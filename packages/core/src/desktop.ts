export const DESKTOP_DAEMON_MODES = ['embedded', 'external'] as const
export const DESKTOP_CONNECTION_STATES = ['starting', 'connected', 'disconnected', 'error'] as const
export const TASK_CONTROL_ACTIONS = ['pause', 'resume', 'cancel'] as const
export const THEIA_RUNTIME_STATES = ['starting', 'ready', 'stopped', 'error'] as const

export type DesktopDaemonMode = (typeof DESKTOP_DAEMON_MODES)[number]
export type DesktopConnectionState = (typeof DESKTOP_CONNECTION_STATES)[number]
export type TaskControlAction = (typeof TASK_CONTROL_ACTIONS)[number]
export type TheiaRuntimeState = (typeof THEIA_RUNTIME_STATES)[number]

export interface DesktopRuntimeStatus {
  mode: DesktopDaemonMode
  state: DesktopConnectionState
  daemonUrl: string
  message: string
  lastCheckedAt: string
  lastError?: string | undefined
}

export interface TheiaRuntimeConfig {
  host: string
  port: number
  workspaceRoots: string[]
  logFilePath: string
  nodeCommand: string
  nodeArgs: string[]
}

export interface TheiaRuntimeStatus {
  state: TheiaRuntimeState
  url: string
  host: string
  port: number
  logFilePath: string
  startedAt?: string | undefined
  pid?: number | undefined
  lastError?: string | undefined
}

export interface DesktopBootStatus {
  daemon: DesktopRuntimeStatus
  theia: TheiaRuntimeStatus
  currentMode: DesktopDaemonMode
  recoverySuggestion?: string | undefined
}
