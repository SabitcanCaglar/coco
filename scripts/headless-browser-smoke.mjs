import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

import { chromium } from 'playwright'

const runId = new Date().toISOString().replaceAll(/[:.]/g, '-')
const artifactDir = resolve(process.env.COCO_BROWSER_ARTIFACT_DIR ?? '.runtime/browser', runId)
await mkdir(artifactDir, { recursive: true })

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html>
    <html><body>
      <main><h1>Coco headless worker</h1>
      <button id="verify">Run interaction</button>
      <output id="result">waiting</output></main>
      <script>
        document.querySelector('#verify').addEventListener('click', () => {
          document.querySelector('#result').textContent = 'verified'
        })
      </script>
    </body></html>`)
})

await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
const address = server.address()
if (!address || typeof address === 'string')
  throw new Error('Unable to start browser smoke server.')
const testedUrl = `http://127.0.0.1:${address.port}`
const consoleErrors = []
let browser
let context
let success = false
let traceStopped = false

try {
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ recordVideo: { dir: join(artifactDir, 'video') } })
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await page.goto(testedUrl, { waitUntil: 'networkidle' })
  await page.locator('#verify').click()
  const result = await page.locator('#result').textContent()
  if (result !== 'verified') throw new Error(`Unexpected interaction result: ${result}`)
  if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join('; ')}`)
  await page.screenshot({ path: join(artifactDir, 'screenshot.png'), fullPage: true })
  await context.tracing.stop({ path: join(artifactDir, 'trace.zip') })
  traceStopped = true
  success = true
} finally {
  if (context && !traceStopped) {
    await context.tracing.stop({ path: join(artifactDir, 'trace.zip') }).catch(() => undefined)
  }
  await context?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  await new Promise((resolvePromise) => server.close(resolvePromise))
  await writeFile(
    join(artifactDir, 'result.json'),
    `${JSON.stringify({ runId, success, testedUrl, headless: true, consoleErrors }, null, 2)}\n`,
  )
}

console.log(`Headless browser smoke passed. Artifacts: ${artifactDir}`)
