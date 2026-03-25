import { injectable } from 'inversify'

import type { DesktopDaemonMode, DesktopRuntimeStatus, Task, TaskControlAction } from '@coco/core'

import { createDaemonClient } from '../common/daemon-client.js'

@injectable()
export class CocoRuntimeService {
  protected readonly client = createDaemonClient()
  protected selectedTaskId: string | undefined

  get daemonClient() {
    return this.client
  }

  getSelectedTaskId(): string | undefined {
    return this.selectedTaskId
  }

  setSelectedTask(taskId: string | undefined): void {
    this.selectedTaskId = taskId
  }

  setMode(mode: DesktopDaemonMode): void {
    this.client.setMode(mode)
  }

  getMode(): DesktopDaemonMode {
    return this.client.getMode()
  }

  setDaemonUrl(url: string): void {
    this.client.setBaseUrl(url)
  }

  getDaemonUrl(): string {
    return this.client.getBaseUrl()
  }

  async getRuntimeStatus(): Promise<DesktopRuntimeStatus> {
    return this.client.getRuntimeStatus()
  }

  async controlTask(taskId: string, action: TaskControlAction): Promise<Task> {
    return this.client.controlTask(taskId, action)
  }
}
