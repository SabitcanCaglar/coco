import { describe, expect, it, vi } from 'vitest'

import { createDaemonClient } from './daemon-client.js'

describe('createDaemonClient', () => {
  it('returns connected runtime status when health is reachable', async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok', message: 'ready' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const client = createDaemonClient({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl,
      mode: 'embedded',
    })

    const status = await client.getRuntimeStatus()
    expect(status.state).toBe('connected')
    expect(status.message).toBe('ready')
  })

  it('sends task control requests to the canonical task action endpoints', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'task-1',
          goal: 'Analyze repo',
          mode: 'analyze',
          status: 'paused',
          sessionId: 'theia',
          plan: { steps: [] },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch

    const client = createDaemonClient({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl,
    })

    const task = await client.controlTask('task-1', 'pause')
    expect(task.status).toBe('paused')
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:3000/tasks/task-1/pause', {
      method: 'POST',
    })
  })
})
