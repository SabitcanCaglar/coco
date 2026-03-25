export const DESKTOP_DAEMON_MODES = ['embedded', 'external'] as const
export const DESKTOP_CONNECTION_STATES = ['starting', 'connected', 'disconnected', 'error'] as const
export const TASK_CONTROL_ACTIONS = ['pause', 'resume', 'cancel'] as const

export type DesktopDaemonMode = (typeof DESKTOP_DAEMON_MODES)[number]
export type DesktopConnectionState = (typeof DESKTOP_CONNECTION_STATES)[number]
export type TaskControlAction = (typeof TASK_CONTROL_ACTIONS)[number]

export interface DesktopRuntimeStatus {
  mode: DesktopDaemonMode
  state: DesktopConnectionState
  daemonUrl: string
  message: string
  lastCheckedAt: string
  lastError?: string | undefined
}
