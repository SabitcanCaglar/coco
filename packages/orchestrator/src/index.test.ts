import { afterEach, describe, expect, it } from 'vitest'

import { startOrchestratorStub } from './index.js'

const servers: Array<ReturnType<typeof startOrchestratorStub>> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }

            resolve()
          })
        }),
    ),
  )
})

describe('@coco/orchestrator', () => {
  it('serves a health endpoint in scaffold mode', async () => {
    const server = startOrchestratorStub(0)
    servers.push(server)

    await new Promise<void>((resolve) => server.once('listening', () => resolve()))

    const address = server.address()
    expect(address).not.toBeNull()
    expect(typeof address).toBe('object')

    const port = typeof address === 'object' && address ? address.port : 0
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    const body = (await response.json()) as { status: string; package: string; mode: string }

    expect(response.status).toBe(200)
    expect(body).toEqual({
      status: 'ok',
      package: '@coco/orchestrator',
      mode: 'stub',
    })
  })
})
