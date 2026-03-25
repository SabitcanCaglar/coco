import { ReactWidget } from '@theia/core/lib/browser/index.js'
import type { MessageService } from '@theia/core/lib/common/index.js'
import { injectable, postConstruct } from 'inversify'
import * as React from 'react'

import type { DesktopRuntimeStatus } from '@coco/core'

import { formatRuntimeLine } from '../common/model.js'
import type { CocoRuntimeService } from './runtime-service.js'

@injectable()
export class CocoRuntimeWidget extends ReactWidget {
  static readonly ID = 'coco.theia.runtime'
  static readonly LABEL = 'Runtime Status'

  protected runtime!: DesktopRuntimeStatus

  protected daemonUrlInput = ''
  protected timer: NodeJS.Timeout | undefined

  constructor(
    protected readonly runtimeService: CocoRuntimeService,
    protected readonly messageService: MessageService,
  ) {
    super()
    this.runtime = {
      mode: 'embedded',
      state: 'starting',
      daemonUrl: this.runtimeService.getDaemonUrl(),
      message: 'Runtime kontrol ediliyor...',
      lastCheckedAt: new Date().toISOString(),
    }
    this.daemonUrlInput = this.runtimeService.getDaemonUrl()
  }

  @postConstruct()
  protected init(): void {
    this.id = CocoRuntimeWidget.ID
    this.title.label = CocoRuntimeWidget.LABEL
    this.title.caption = CocoRuntimeWidget.LABEL
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
    this.runtime = await this.runtimeService.getRuntimeStatus()
    this.update()
  }

  protected async switchMode(mode: DesktopRuntimeStatus['mode']): Promise<void> {
    this.runtimeService.setMode(mode)
    await this.refresh()
  }

  protected applyDaemonUrl(): void {
    const normalized = this.daemonUrlInput.trim()
    if (!normalized) {
      this.messageService.warn('Daemon URL bos olamaz.')
      return
    }
    this.runtimeService.setDaemonUrl(normalized)
    void this.refresh()
  }

  protected render(): React.ReactNode {
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
      React.createElement('div', { style: { fontWeight: 700 } }, 'Desktop runtime'),
      React.createElement('div', {}, formatRuntimeLine(this.runtime)),
      React.createElement('div', {}, this.runtime.message),
      React.createElement(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        React.createElement(
          'button',
          { type: 'button', onClick: () => void this.switchMode('embedded') },
          'Use embedded daemon',
        ),
        React.createElement(
          'button',
          { type: 'button', onClick: () => void this.switchMode('external') },
          'Use external daemon',
        ),
      ),
      React.createElement('input', {
        value: this.daemonUrlInput,
        placeholder: 'http://127.0.0.1:3000',
        onChange: (event: unknown) => {
          const target = (event as { target?: { value?: string } | null })?.target
          this.daemonUrlInput = target?.value ?? ''
          this.update()
        },
      }),
      React.createElement(
        'button',
        { type: 'button', onClick: () => this.applyDaemonUrl() },
        'Connect',
      ),
    )
  }
}
