import { describe, expect, it } from 'vitest'

import type { DesktopRuntimeStatus } from '@coco/core'

import { type MonitorSnapshot, buildWorkbenchBlueprint, summarizeMonitorSnapshot } from './index.js'

describe('@coco/theia', () => {
  it('defines the expected workbench blueprint', () => {
    const blueprint = buildWorkbenchBlueprint()
    expect(blueprint.productName).toBe('Coco IDE')
    expect(blueprint.panels.map((panel) => panel.id)).toEqual([
      'coco.chat',
      'coco.monitor',
      'coco.timeline',
      'coco.editor',
    ])
  })

  it('summarizes monitor state for task and worker visibility', () => {
    const snapshot: MonitorSnapshot = {
      runtime: {
        mode: 'embedded',
        state: 'connected',
        daemonUrl: 'http://127.0.0.1:3000',
        message: 'ready',
        lastCheckedAt: new Date().toISOString(),
      } satisfies DesktopRuntimeStatus,
      tasks: [
        {
          id: 'task-1',
          goal: 'Analyze subs-api',
          mode: 'analyze',
          status: 'running',
          sessionId: 'theia',
          plan: { steps: [] },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'task-2',
          goal: 'Fix auth issue',
          mode: 'fix',
          status: 'blocked',
          sessionId: 'theia',
          plan: { steps: [] },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      workers: [
        {
          id: 'worker-1',
          kind: 'analysis-worker',
          status: 'busy',
          lastHeartbeat: new Date().toISOString(),
        },
        {
          id: 'worker-2',
          kind: 'fix-worker',
          status: 'idle',
          lastHeartbeat: new Date().toISOString(),
        },
      ],
      sessions: [
        {
          id: 'theia',
          updatedAt: new Date().toISOString(),
          taskCount: 2,
        },
      ],
    }

    expect(summarizeMonitorSnapshot(snapshot)).toContain('2 tasks')
    expect(summarizeMonitorSnapshot(snapshot)).toContain('embedded')
    expect(summarizeMonitorSnapshot(snapshot)).toContain('1 running')
    expect(summarizeMonitorSnapshot(snapshot)).toContain('1 blocked')
  })
})
