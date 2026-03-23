import { describe, expect, it } from 'vitest'

import { cliPackage, getCLIStubMessage } from './index.js'

describe('@coco/cli', () => {
  it('exposes the CLI scaffold message', () => {
    expect(cliPackage.name).toBe('@coco/cli')
    expect(getCLIStubMessage()).toContain('pnpm loop -- <project-path>')
  })
})
