import { describe, expect, it } from 'vitest'

import { ReviewGate, reviewPackage } from './index.js'

describe('@coco/review', () => {
  it('exposes scaffold metadata', () => {
    expect(reviewPackage.name).toBe('@coco/review')
    expect(reviewPackage.status).toBe('stub')
  })

  it('marks the review gate as a stub', () => {
    expect(new ReviewGate().status).toBe('stub')
  })
})
