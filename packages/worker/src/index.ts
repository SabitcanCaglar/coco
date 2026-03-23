import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HEARTBEAT_INTERVAL_MS = 60_000

const STUB_MESSAGE =
  '@coco/worker is scaffolded and running in idle mode. Repository execution logic will land in a later milestone.'

export const workerPackage = {
  name: '@coco/worker',
  status: 'stub',
  message: STUB_MESSAGE,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
} as const

export function startWorkerStub(intervalMs = HEARTBEAT_INTERVAL_MS): NodeJS.Timeout {
  console.log(STUB_MESSAGE)
  return setInterval(() => undefined, intervalMs)
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false
}

if (isDirectExecution()) {
  const timer = startWorkerStub()
  const shutdown = () => {
    clearInterval(timer)
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
