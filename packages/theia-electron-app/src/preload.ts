import { contextBridge, ipcRenderer } from 'electron'

import type {
  DesktopDaemonMode,
  DesktopRuntimeStatus,
  MonitorEvent,
  SessionInfo,
  Task,
  TaskControlAction,
  TaskStep,
  WorkerInfo,
} from '@coco/core'

export interface DesktopSnapshotPayload {
  runtime: DesktopRuntimeStatus
  tasks: Task[]
  workers: WorkerInfo[]
  sessions: SessionInfo[]
}

export interface DesktopTaskDetailPayload {
  task: Task
  steps: TaskStep[]
  events: MonitorEvent[]
}

const api = {
  getRuntimeStatus(): Promise<DesktopRuntimeStatus> {
    return ipcRenderer.invoke('coco.runtime.status')
  },
  setMode(mode: DesktopDaemonMode): Promise<DesktopRuntimeStatus> {
    return ipcRenderer.invoke('coco.runtime.mode', mode)
  },
  setExternalDaemonUrl(url: string): Promise<DesktopRuntimeStatus> {
    return ipcRenderer.invoke('coco.runtime.url', url)
  },
  snapshot(): Promise<DesktopSnapshotPayload> {
    return ipcRenderer.invoke('coco.snapshot')
  },
  taskDetail(taskId: string): Promise<DesktopTaskDetailPayload> {
    return ipcRenderer.invoke('coco.task.detail', taskId)
  },
  controlTask(taskId: string, action: TaskControlAction): Promise<Task> {
    return ipcRenderer.invoke('coco.task.control', { taskId, action })
  },
  chat(prompt: string): Promise<{ reply: string; task?: Task | undefined }> {
    return ipcRenderer.invoke('coco.chat', prompt)
  },
}

contextBridge.exposeInMainWorld('cocoDesktop', api)

export type CocoDesktopApi = typeof api
