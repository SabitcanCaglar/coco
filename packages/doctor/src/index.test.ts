import { describe, expect, it } from 'vitest'

import { defineFrameworkExpert, doctorPackage, expertRegistry } from './index.js'

describe('@coco/doctor', () => {
  it('registers framework experts in the scaffold registry', () => {
    const initialSize = expertRegistry.length
    const definition = defineFrameworkExpert({
      framework: 'nextjs',
      name: 'Next.js Expert',
      description: 'Scaffold smoke test',
    })

    expect(definition.framework).toBe('nextjs')
    expect(expertRegistry).toHaveLength(initialSize + 1)
    expertRegistry.splice(initialSize)
  })

  it('exposes scaffold package metadata', () => {
    expect(doctorPackage.name).toBe('@coco/doctor')
    expect(doctorPackage.status).toBe('stub')
  })
})
