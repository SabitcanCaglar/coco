import { describe, expect, it } from 'vitest'

import { workerPackage } from './index.js'

describe('@coco/worker', () => {
  it('exposes worker scaffold metadata', () => {
    expect(workerPackage.name).toBe('@coco/worker')
    expect(workerPackage.status).toBe('stub')
    expect(workerPackage.heartbeatIntervalMs).toBe(60_000)
  })
})
