import {
  AbstractViewContribution,
  type FrontendApplication,
  FrontendApplicationContribution,
  WidgetFactory,
  bindViewContribution,
} from '@theia/core/lib/browser/index.js'
import type { CommandRegistry } from '@theia/core/lib/common/index.js'
import type { interfaces } from 'inversify'
import { injectable } from 'inversify'

import { CocoChatWidget } from './chat-widget.js'
import { CocoMonitorWidget } from './monitor-widget.js'
import { CocoRuntimeWidget } from './runtime-widget.js'
import { CocoTimelineWidget } from './timeline-widget.js'

export namespace CocoTheiaCommands {
  export const OPEN_CHAT = {
    id: 'coco.theia.openChat',
    label: 'Open OpenClaw Chat',
  }

  export const OPEN_MONITOR = {
    id: 'coco.theia.openMonitor',
    label: 'Open Coco Task Monitor',
  }

  export const OPEN_RUNTIME = {
    id: 'coco.theia.openRuntime',
    label: 'Open Coco Runtime Status',
  }

  export const OPEN_TIMELINE = {
    id: 'coco.theia.openTimeline',
    label: 'Open Coco Execution Timeline',
  }
}

@injectable()
export class CocoChatContribution
  extends AbstractViewContribution<CocoChatWidget>
  implements FrontendApplicationContribution
{
  constructor() {
    super({
      widgetId: CocoChatWidget.ID,
      widgetName: CocoChatWidget.LABEL,
      defaultWidgetOptions: { area: 'left' },
      toggleCommandId: CocoTheiaCommands.OPEN_CHAT.id,
    })
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(CocoTheiaCommands.OPEN_CHAT, {
      execute: () => super.openView({ activate: true, reveal: true }),
    })
  }

  async onStart(): Promise<void> {
    await this.openView({ activate: false, reveal: true })
  }
}

@injectable()
export class CocoMonitorContribution
  extends AbstractViewContribution<CocoMonitorWidget>
  implements FrontendApplicationContribution
{
  constructor() {
    super({
      widgetId: CocoMonitorWidget.ID,
      widgetName: CocoMonitorWidget.LABEL,
      defaultWidgetOptions: { area: 'right' },
      toggleCommandId: CocoTheiaCommands.OPEN_MONITOR.id,
    })
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(CocoTheiaCommands.OPEN_MONITOR, {
      execute: () => super.openView({ activate: true, reveal: true }),
    })
  }

  async onStart(app: FrontendApplication): Promise<void> {
    void app
    await this.openView({ activate: false, reveal: true })
  }
}

@injectable()
export class CocoRuntimeContribution
  extends AbstractViewContribution<CocoRuntimeWidget>
  implements FrontendApplicationContribution
{
  constructor() {
    super({
      widgetId: CocoRuntimeWidget.ID,
      widgetName: CocoRuntimeWidget.LABEL,
      defaultWidgetOptions: { area: 'right' },
      toggleCommandId: CocoTheiaCommands.OPEN_RUNTIME.id,
    })
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(CocoTheiaCommands.OPEN_RUNTIME, {
      execute: () => super.openView({ activate: true, reveal: true }),
    })
  }

  async onStart(): Promise<void> {
    await this.openView({ activate: false, reveal: true })
  }
}

@injectable()
export class CocoTimelineContribution
  extends AbstractViewContribution<CocoTimelineWidget>
  implements FrontendApplicationContribution
{
  constructor() {
    super({
      widgetId: CocoTimelineWidget.ID,
      widgetName: CocoTimelineWidget.LABEL,
      defaultWidgetOptions: { area: 'bottom' },
      toggleCommandId: CocoTheiaCommands.OPEN_TIMELINE.id,
    })
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(CocoTheiaCommands.OPEN_TIMELINE, {
      execute: () => super.openView({ activate: true, reveal: true }),
    })
  }

  async onStart(): Promise<void> {
    await this.openView({ activate: false, reveal: true })
  }
}

export function bindCocoViewContributions(bind: interfaces.Bind): void {
  bindViewContribution(bind, CocoChatContribution)
  bindViewContribution(bind, CocoMonitorContribution)
  bindViewContribution(bind, CocoRuntimeContribution)
  bindViewContribution(bind, CocoTimelineContribution)
  bind(FrontendApplicationContribution).toService(CocoChatContribution)
  bind(FrontendApplicationContribution).toService(CocoMonitorContribution)
  bind(FrontendApplicationContribution).toService(CocoRuntimeContribution)
  bind(FrontendApplicationContribution).toService(CocoTimelineContribution)
  bind(WidgetFactory).toDynamicValue((context) => ({
    id: CocoChatWidget.ID,
    createWidget: () => context.container.get(CocoChatWidget),
  }))
  bind(WidgetFactory).toDynamicValue((context) => ({
    id: CocoMonitorWidget.ID,
    createWidget: () => context.container.get(CocoMonitorWidget),
  }))
  bind(WidgetFactory).toDynamicValue((context) => ({
    id: CocoRuntimeWidget.ID,
    createWidget: () => context.container.get(CocoRuntimeWidget),
  }))
  bind(WidgetFactory).toDynamicValue((context) => ({
    id: CocoTimelineWidget.ID,
    createWidget: () => context.container.get(CocoTimelineWidget),
  }))
}
