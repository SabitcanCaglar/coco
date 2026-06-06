import { injectable } from 'inversify'

import type {
  DesktopDaemonMode,
  DesktopRuntimeStatus,
  Mission,
  MissionEvent,
  ApprovalQueueItem,
  RepoExecutionProfile,
  Task,
  TaskControlAction,
  WorkspaceSession,
} from '@coco/core'

import { createDaemonClient } from '../common/daemon-client.js'

@injectable()
export class CocoRuntimeService {
  protected readonly client = createDaemonClient()
  protected selectedTaskId: string | undefined
  protected selectedMissionId: string | undefined

  get daemonClient() {
    return this.client
  }

  getSelectedTaskId(): string | undefined {
    return this.selectedTaskId
  }

  setSelectedTask(taskId: string | undefined): void {
    this.selectedTaskId = taskId
  }

  getSelectedMissionId(): string | undefined {
    return this.selectedMissionId
  }

  setSelectedMission(missionId: string | undefined): void {
    this.selectedMissionId = missionId
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

  async getWorkspaceSession(sessionId: string): Promise<WorkspaceSession> {
    return this.client.getWorkspaceSession(sessionId)
  }

  async getMissions(): Promise<Mission[]> {
    return this.client.getMissions()
  }

  async getMission(missionId: string): Promise<Mission> {
    return this.client.getMission(missionId)
  }

  async getMissionEvents(missionId: string): Promise<MissionEvent[]> {
    return this.client.getMissionEvents(missionId)
  }

  async getApprovals(): Promise<ApprovalQueueItem[]> {
    return this.client.getApprovals()
  }

  async approveMission(missionId: string, payload: Record<string, unknown>): Promise<Mission> {
    return this.client.approveMission(missionId, payload)
  }

  async getRepoProfiles(): Promise<RepoExecutionProfile[]> {
    return this.client.getRepoProfiles()
  }

  async postThreadMessage(
    threadId: string,
    payload: Record<string, unknown>,
  ): Promise<{ reply: string; mission?: Mission | undefined }> {
    return this.client.postThreadMessage(threadId, payload)
  }

  async discoverWorkspaceRepos(sessionId: string): Promise<WorkspaceSession> {
    return this.client.discoverWorkspaceRepos(sessionId)
  }

  async controlWorkspaceSession(
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<WorkspaceSession> {
    return this.client.controlWorkspaceSession(sessionId, payload)
  }
}
