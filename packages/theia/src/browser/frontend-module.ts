import { ContainerModule } from 'inversify'

import { CocoChatWidget } from './chat-widget.js'
import {
  CocoChatContribution,
  CocoMonitorContribution,
  CocoRuntimeContribution,
  CocoTimelineContribution,
  bindCocoViewContributions,
} from './contribution.js'
import { CocoMonitorWidget } from './monitor-widget.js'
import { CocoRuntimeService } from './runtime-service.js'
import { CocoRuntimeWidget } from './runtime-widget.js'
import { CocoTimelineWidget } from './timeline-widget.js'

export default new ContainerModule((bind) => {
  bind(CocoRuntimeService).toSelf().inSingletonScope()
  bind(CocoChatWidget).toSelf()
  bind(CocoMonitorWidget).toSelf()
  bind(CocoRuntimeWidget).toSelf()
  bind(CocoTimelineWidget).toSelf()
  bind(CocoChatContribution).toSelf().inSingletonScope()
  bind(CocoMonitorContribution).toSelf().inSingletonScope()
  bind(CocoRuntimeContribution).toSelf().inSingletonScope()
  bind(CocoTimelineContribution).toSelf().inSingletonScope()
  bindCocoViewContributions(bind)
})
