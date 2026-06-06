import { ReactWidget } from '@theia/core/lib/browser/index.js'
import { injectable, postConstruct } from 'inversify'
import * as React from 'react'

import type {
  ApprovalQueueItem,
  DesktopRuntimeStatus,
  RepoExecutionProfile,
  SessionInfo,
  Task,
  WorkerInfo,
  WorkspaceSession,
} from '@coco/core'

import {
  choosePrimaryTask,
  defaultTheiaOrchestratorUrl,
  normalizeTaskHeadline,
  summarizeMonitorSnapshot,
} from '../common/model.js'
import type { CocoRuntimeService } from './runtime-service.js'

interface SnapshotState {
  runtime?: DesktopRuntimeStatus | undefined
  tasks: Task[]
  workers: WorkerInfo[]
  sessions: SessionInfo[]
  approvals: ApprovalQueueItem[]
  repoProfiles: RepoExecutionProfile[]
  workspaceSession?: WorkspaceSession | undefined
  statusLine: string
}

@injectable()
export class CocoMonitorWidget extends ReactWidget {
  static readonly ID = 'coco.theia.monitor'
  static readonly LABEL = 'Task Monitor'

  protected snapshot: SnapshotState = {
    runtime: undefined,
    tasks: [],
    workers: [],
    sessions: [],
    approvals: [],
    repoProfiles: [],
    workspaceSession: undefined,
    statusLine: 'Connecting to orchestrator...',
  }

  protected timer: NodeJS.Timeout | undefined

  constructor(protected readonly runtimeService: CocoRuntimeService) {
    super()
  }

  @postConstruct()
  protected init(): void {
    this.id = CocoMonitorWidget.ID
    this.title.label = CocoMonitorWidget.LABEL
    this.title.caption = CocoMonitorWidget.LABEL
    this.title.closable = true
    void this.refresh()
    this.timer = setInterval(() => {
      void this.refresh()
    }, 5_000)
    this.toDispose.push({
      dispose: () => {
        if (this.timer) {
          clearInterval(this.timer)
          this.timer = undefined
        }
      },
    })
  }

  protected async refresh(): Promise<void> {
    try {
      const { runtime, tasks, workers, sessions, approvals } =
        await this.runtimeService.daemonClient.snapshot()
      const repoProfiles = await this.runtimeService.getRepoProfiles().catch(() => [])
      const workspaceSession = await this.runtimeService
        .getWorkspaceSession('theia')
        .catch(() => undefined)
      const primaryTask = choosePrimaryTask(tasks)
      if (primaryTask && !this.runtimeService.getSelectedTaskId()) {
        this.runtimeService.setSelectedTask(primaryTask.id)
      }
      this.snapshot = {
        runtime,
        tasks,
        workers,
        sessions,
        approvals: approvals ?? [],
        repoProfiles,
        workspaceSession,
        statusLine: summarizeMonitorSnapshot({
          runtime,
          tasks,
          workers,
          sessions,
          approvals: approvals ?? [],
        }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.snapshot = {
        runtime: undefined,
        tasks: [],
        workers: [],
        sessions: [],
        approvals: [],
        repoProfiles: [],
        workspaceSession: undefined,
        statusLine: `Orchestrator unreachable: ${message}`,
      }
    }

    this.update()
  }

  protected render(): React.ReactNode {
    return React.createElement(
      'div',
      {
        style: {
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          height: '100%',
        },
      },
      React.createElement(
        'div',
        {
          style: { fontWeight: 700, fontSize: '13px' },
        },
        this.snapshot.statusLine,
      ),
      React.createElement(
        'div',
        {
          style: { display: 'grid', gap: '8px', gridTemplateColumns: '1fr' },
        },
        React.createElement('div', {}, `Tasks: ${this.snapshot.tasks.length}`),
        React.createElement('div', {}, `Workers: ${this.snapshot.workers.length}`),
        React.createElement('div', {}, `Sessions: ${this.snapshot.sessions.length}`),
        React.createElement('div', {}, `Approvals: ${this.snapshot.approvals.length}`),
        React.createElement('div', {}, `Repo profiles: ${this.snapshot.repoProfiles.length}`),
        React.createElement(
          'div',
          {},
          `Workspace focus: ${
            this.snapshot.workspaceSession?.managedRepos.find(
              (repo) => repo.repoId === this.snapshot.workspaceSession?.focusRepoId,
            )?.rootPath ?? 'none'
          }`,
        ),
        React.createElement(
          'div',
          {},
          `Review: ${this.snapshot.workspaceSession?.lastReviewDecision ?? 'n/a'}`,
        ),
        React.createElement(
          'div',
          {},
          `Daemon: ${this.runtimeService.getMode()} @ ${this.runtimeService.getDaemonUrl()}`,
        ),
      ),
      React.createElement(
        'div',
        {
          style: {
            flex: 1,
            overflow: 'auto',
            border: '1px solid var(--theia-editorWidget-border)',
            borderRadius: '8px',
            padding: '8px',
            whiteSpace: 'pre-wrap',
          },
        },
        this.snapshot.tasks.length === 0
          ? [
              'No active tasks yet.',
              ...this.snapshot.approvals.map(
                (approval) =>
                  `APPROVAL · ${approval.stepClass} · ${approval.goal} · ${approval.runnerType ?? 'runner n/a'}`,
              ),
            ]
              .filter(Boolean)
              .join('\n')
          : this.snapshot.tasks
              .map((task) => {
                const pointer = this.runtimeService.getSelectedTaskId() === task.id ? '>' : '-'
                return `${pointer} ${normalizeTaskHeadline(task)}`
              })
              .concat(
                this.snapshot.approvals.map(
                  (approval) =>
                    `! APPROVAL · ${approval.stepClass} · ${approval.goal} · ${approval.runnerType ?? 'runner n/a'}`,
                ),
              )
              .join('\n'),
      ),
    )
  }
}
