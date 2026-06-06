import { ReactWidget } from '@theia/core/lib/browser/index.js'
import type { MessageService } from '@theia/core/lib/common/index.js'
import { injectable, postConstruct } from 'inversify'
import * as React from 'react'

import { defaultTheiaOrchestratorUrl } from '../common/model.js'
import type { CocoRuntimeService } from './runtime-service.js'

@injectable()
export class CocoChatWidget extends ReactWidget {
  static readonly ID = 'coco.theia.chat'
  static readonly LABEL = 'OpenClaw Chat'

  protected messages: string[] = [
    'Mission chat hazir. Hedefi yaz; thread ve mission durumu kalici olarak tutulacak.',
  ]

  protected inputValue = ''
  protected readonly threadId = 'theia-main'

  constructor(
    protected readonly messageService: MessageService,
    protected readonly runtimeService: CocoRuntimeService,
  ) {
    super()
  }

  @postConstruct()
  protected init(): void {
    this.id = CocoChatWidget.ID
    this.title.label = CocoChatWidget.LABEL
    this.title.caption = CocoChatWidget.LABEL
    this.title.closable = true
    this.update()
  }

  protected async submit(): Promise<void> {
    const prompt = this.inputValue.trim()
    if (!prompt) {
      return
    }

    this.messages = [...this.messages, `You: ${prompt}`]
    this.inputValue = ''
    this.update()

    try {
      if (!this.runtimeService.getDaemonUrl()) {
        this.runtimeService.setDaemonUrl(defaultTheiaOrchestratorUrl())
      }
      const result = await this.runtimeService.postThreadMessage(this.threadId, {
        text: prompt,
        surface: 'web',
        user_id: 'theia',
      })
      const thread = await this.runtimeService.daemonClient.requestThread(this.threadId)
      this.messages = thread.messages.map(
        (message) => `${message.role === 'user' ? 'You' : 'OpenClaw'}: ${message.text}`,
      )
      if (result.mission) {
        this.runtimeService.setSelectedMission(result.mission.missionId)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.messages = [...this.messages, `OpenClaw: ${message}`]
      this.messageService.error(`OpenClaw request failed: ${message}`)
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
          style: {
            fontWeight: 700,
            fontSize: '13px',
          },
        },
        'Canonical mission chat',
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
            lineHeight: 1.5,
          },
        },
        this.messages.join('\n\n'),
      ),
      React.createElement('textarea', {
        value: this.inputValue,
        rows: 4,
        placeholder: 'Ornek: subs-api repo yapisini analiz et',
        onChange: (event: unknown) => {
          const target = (event as { target?: { value?: string } | null })?.target
          this.inputValue = target?.value ?? ''
          this.update()
        },
      }),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => {
            void this.submit()
          },
        },
        'Send to mission control',
      ),
    )
  }
}
