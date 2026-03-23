import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_PORT = Number(process.env.PORT ?? 3000)

const STUB_MESSAGE =
  '@coco/orchestrator is scaffolded. Queueing, prioritization, and worker dispatch will land in a later milestone.'

export const orchestratorPackage = {
  name: '@coco/orchestrator',
  status: 'stub',
  message: STUB_MESSAGE,
  defaultPort: DEFAULT_PORT,
} as const

export function startOrchestratorStub(port = DEFAULT_PORT) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8')

    if (request.url === '/health') {
      response.writeHead(200)
      response.end(
        JSON.stringify({
          status: 'ok',
          package: orchestratorPackage.name,
          mode: orchestratorPackage.status,
        }),
      )
      return
    }

    response.writeHead(200)
    response.end(
      JSON.stringify({
        package: orchestratorPackage.name,
        message: STUB_MESSAGE,
      }),
    )
  })

  server.listen(port, () => {
    console.log(`${STUB_MESSAGE} Listening on http://0.0.0.0:${port}`)
  })

  return server
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false
}

if (isDirectExecution()) {
  const server = startOrchestratorStub()
  const shutdown = () => {
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
