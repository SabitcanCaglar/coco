import { ReactWidget } from '@theia/core/lib/browser/index.js'
import type { MessageService } from '@theia/core/lib/common/index.js'
import { injectable, postConstruct } from 'inversify'
import * as React from 'react'

import type { MonitorEvent, Task, TaskStatus, TaskStep } from '@coco/core'

import type { CocoRuntimeService } from './runtime-service.js'

interface TaskDetailState {
  task?: Task | undefined
  steps: TaskStep[]
  events: MonitorEvent[]
  statusLine: string
}

@injectable()
export class CocoTimelineWidget extends ReactWidget {
  static readonly ID = 'coco.theia.timeline'
  static readonly LABEL = 'Execution Timeline'

  protected state: TaskDetailState = {
    steps: [],
    events: [],
    statusLine: 'Bir task secildiginde detaylari burada gosterilecek.',
  }

  protected timer: NodeJS.Timeout | undefined

  constructor(
    protected readonly runtimeService: CocoRuntimeService,
    protected readonly messageService: MessageService,
  ) {
    super()
  }

  @postConstruct()
  protected init(): void {
    this.id = CocoTimelineWidget.ID
    this.title.label = CocoTimelineWidget.LABEL
    this.title.caption = CocoTimelineWidget.LABEL
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
    const taskId = this.runtimeService.getSelectedTaskId()
    if (!taskId) {
      this.state = {
        task: undefined,
        steps: [],
        events: [],
        statusLine: 'Bir task secildiginde detaylari burada gosterilecek.',
      }
      this.update()
      return
    }
    try {
      const detail = await this.runtimeService.daemonClient.getTask(taskId)
      this.state = {
        task: detail.task,
        steps: detail.steps as TaskStep[],
        events: detail.events,
        statusLine: detail.task.latestSummary ?? detail.task.goal,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.state = {
        task: undefined,
        steps: [],
        events: [],
        statusLine: `Task detaylari alinamadi: ${message}`,
      }
    }
    this.update()
  }

  protected async control(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    const task = this.state.task
    if (!task) return
    try {
      const updated = await this.runtimeService.controlTask(task.id, action)
      this.state = {
        ...this.state,
        task: updated,
        statusLine: updated.latestSummary ?? `${action} islemi gonderildi.`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.messageService.error(`Task control failed: ${message}`)
    }
    this.update()
  }

  protected controlsFor(status: TaskStatus): Array<'pause' | 'resume' | 'cancel'> {
    if (status === 'running') return ['pause', 'cancel']
    if (status === 'paused' || status === 'blocked') return ['resume', 'cancel']
    if (status === 'queued') return ['cancel']
    return []
  }

  protected render(): React.ReactNode {
    const task = this.state.task
    return React.createElement(
      'div',
      {
        style: {
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          height: '100%',
        },
      },
      React.createElement('div', { style: { fontWeight: 700 } }, 'Task detail and timeline'),
      React.createElement('div', {}, this.state.statusLine),
      task
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(
              'div',
              {},
              `${task.mode} · ${task.status} · ${task.checkpoint?.currentPhase ?? 'phase n/a'}`,
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              ...this.controlsFor(task.status).map((action) =>
                React.createElement(
                  'button',
                  {
                    key: action,
                    type: 'button',
                    onClick: () => void this.control(action),
                  },
                  action,
                ),
              ),
            ),
            React.createElement(
              'div',
              {
                style: {
                  border: '1px solid var(--theia-editorWidget-border)',
                  borderRadius: '8px',
                  padding: '8px',
                  whiteSpace: 'pre-wrap',
                  overflow: 'auto',
                },
              },
              [
                'Steps:',
                ...this.state.steps.map((step) => `- ${step.status} · ${step.title}`),
                '',
                'Events:',
                ...this.state.events
                  .slice(-8)
                  .map((event) => `- ${event.phase} · ${event.message}`),
              ].join('\n'),
            ),
          )
        : null,
    )
  }
}
