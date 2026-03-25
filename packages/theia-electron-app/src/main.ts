import { join } from 'node:path'

import { BrowserWindow, app, ipcMain } from 'electron'

import { type SupervisorSessionState, createSupervisor } from '@coco/openclaw-supervisor'
import { buildWorkbenchBlueprint } from '@coco/theia'
import { createDaemonClient } from '@coco/theia'

import { createDesktopRuntimeManager } from './runtime.js'

const runtime = createDesktopRuntimeManager()
const sessions: SupervisorSessionState = {}

function daemonClient() {
  const status = runtime.getStatus()
  return createDaemonClient({
    baseUrl: status.daemonUrl,
    mode: status.mode,
  })
}

async function ensureRuntime() {
  return runtime.start()
}

ipcMain.handle('coco.runtime.status', async () => {
  return runtime.getStatus()
})

ipcMain.handle('coco.runtime.mode', async (_event, mode: 'embedded' | 'external') => {
  runtime.setMode(mode)
  return ensureRuntime()
})

ipcMain.handle('coco.runtime.url', async (_event, url: string) => {
  runtime.setExternalDaemonUrl(url)
  if (runtime.getStatus().mode === 'external') {
    return ensureRuntime()
  }
  return runtime.getStatus()
})

ipcMain.handle('coco.snapshot', async () => {
  await ensureRuntime()
  const client = daemonClient()
  return client.snapshot()
})

ipcMain.handle('coco.task.detail', async (_event, taskId: string) => {
  await ensureRuntime()
  const client = daemonClient()
  return client.getTask(taskId)
})

ipcMain.handle(
  'coco.task.control',
  async (_event, payload: { taskId: string; action: 'pause' | 'resume' | 'cancel' }) => {
    await ensureRuntime()
    const client = daemonClient()
    return client.controlTask(payload.taskId, payload.action)
  },
)

ipcMain.handle('coco.chat', async (_event, prompt: string) => {
  const status = await ensureRuntime()
  const supervisor = createSupervisor({ daemonUrl: status.daemonUrl })
  return supervisor.handleMessage(prompt, 'desktop', sessions)
})

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'Coco IDE',
  })
  const status = await runtime.start()
  const blueprint = buildWorkbenchBlueprint()
  const html = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>${blueprint.productName}</title>
    </head>
    <body>
      <script>window.__COCO_BOOTSTRAP__ = ${JSON.stringify({
        productName: blueprint.productName,
        runtime: status,
        panels: blueprint.panels,
      })}</script>
      <script type="module" src="file://${join(import.meta.dirname, 'renderer.js').replaceAll('\\', '/')}"></script>
    </body>
  </html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

app.whenReady().then(() => {
  void createWindow()
})

app.on('window-all-closed', () => {
  void runtime.stop().finally(() => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
})
