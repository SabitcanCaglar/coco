declare global {
  interface Window {
    cocoDesktop: import('./preload.js').CocoDesktopApi
  }
}

function panel(title: string, body: string): string {
  return `<section class="panel"><h2>${title}</h2><pre>${body}</pre></section>`
}

function mountSkeleton(): void {
  document.body.innerHTML = `
    <main class="layout">
      <section class="hero panel">
        <h1>Coco IDE</h1>
        <div id="runtime-line">Booting desktop runtime...</div>
        <div class="row">
          <button id="mode-embedded">Embedded</button>
          <button id="mode-external">External</button>
          <input id="daemon-url" placeholder="http://127.0.0.1:3000" />
          <button id="daemon-connect">Connect</button>
        </div>
      </section>
      <section class="chat panel">
        <h2>OpenClaw Chat</h2>
        <div id="chat-log" class="log"></div>
        <textarea id="chat-input" rows="5" placeholder="Ornek: subs-api repo yapisini analiz et"></textarea>
        <button id="chat-send">Send</button>
      </section>
      <section id="monitor-grid" class="monitor-grid"></section>
    </main>
  `
}

async function refreshDashboard(selectedTaskId?: string): Promise<void> {
  const snapshot = await window.cocoDesktop.snapshot()
  const runtimeLine = document.getElementById('runtime-line')
  if (runtimeLine) {
    runtimeLine.textContent = `${snapshot.runtime.mode} · ${snapshot.runtime.state} · ${snapshot.runtime.daemonUrl} · ${snapshot.runtime.message}`
  }
  const daemonUrlInput = document.getElementById('daemon-url') as HTMLInputElement | null
  if (daemonUrlInput && daemonUrlInput !== document.activeElement) {
    daemonUrlInput.value = snapshot.runtime.daemonUrl
  }

  const primaryTask = selectedTaskId ?? snapshot.tasks.find((task) => task.status === 'running')?.id
  const detail =
    primaryTask && snapshot.tasks.some((task) => task.id === primaryTask)
      ? await window.cocoDesktop.taskDetail(primaryTask)
      : undefined

  const tasksBody =
    snapshot.tasks.length === 0
      ? 'No tasks yet.'
      : snapshot.tasks
          .map(
            (task) =>
              `${task.id === primaryTask ? '>' : '-'} ${task.mode} · ${task.status} · ${task.goal}`,
          )
          .join('\n')

  const workersBody =
    snapshot.workers.length === 0
      ? 'No workers.'
      : snapshot.workers
          .map(
            (worker) =>
              `- ${worker.kind} · ${worker.status} · task=${worker.currentTaskId ?? 'n/a'} · heartbeat=${worker.lastHeartbeat}`,
          )
          .join('\n')

  const sessionsBody =
    snapshot.sessions.length === 0
      ? 'No sessions.'
      : snapshot.sessions
          .map(
            (session) =>
              `- ${session.id} · tasks=${session.taskCount} · active=${session.activeTaskId ?? 'n/a'}`,
          )
          .join('\n')

  const timelineBody = detail
    ? [
        `${detail.task.mode} · ${detail.task.status}`,
        detail.task.latestSummary ?? detail.task.goal,
        detail.task.blockedReason ? `Blocked: ${detail.task.blockedReason}` : '',
        '',
        'Steps:',
        ...detail.steps.map((step) => `- ${step.status} · ${step.title}`),
        '',
        'Events:',
        ...detail.events.slice(-10).map((event) => `- ${event.phase} · ${event.message}`),
      ]
        .filter(Boolean)
        .join('\n')
    : 'No task selected.'

  const controls = detail
    ? `<div class="row">
        <button data-task-control="pause" data-task-id="${detail.task.id}">Pause</button>
        <button data-task-control="resume" data-task-id="${detail.task.id}">Resume</button>
        <button data-task-control="cancel" data-task-id="${detail.task.id}">Cancel</button>
      </div>`
    : ''

  const monitorGrid = document.getElementById('monitor-grid')
  if (monitorGrid) {
    monitorGrid.innerHTML = [
      panel('Tasks', tasksBody),
      panel('Workers', workersBody),
      panel('Sessions', sessionsBody),
      `<section class="panel"><h2>Timeline</h2>${controls}<pre>${timelineBody}</pre></section>`,
    ].join('')
  }

  for (const element of Array.from(document.querySelectorAll('[data-task-control]'))) {
    element.addEventListener('click', async () => {
      const taskId = element.getAttribute('data-task-id')
      const action = element.getAttribute('data-task-control') as
        | 'pause'
        | 'resume'
        | 'cancel'
        | null
      if (!taskId || !action) return
      await window.cocoDesktop.controlTask(taskId, action)
      await refreshDashboard(taskId)
    })
  }
}

function appendChatLine(line: string): void {
  const chatLog = document.getElementById('chat-log')
  if (!chatLog) return
  chatLog.textContent = `${chatLog.textContent ?? ''}${chatLog.textContent ? '\n\n' : ''}${line}`
  chatLog.scrollTop = chatLog.scrollHeight
}

async function bootstrap(): Promise<void> {
  mountSkeleton()
  appendChatLine('OpenClaw burada. Hedefi yaz; analyze, fix veya autopilot akisini ben yoneteyim.')
  await refreshDashboard()

  document.getElementById('mode-embedded')?.addEventListener('click', async () => {
    await window.cocoDesktop.setMode('embedded')
    await refreshDashboard()
  })
  document.getElementById('mode-external')?.addEventListener('click', async () => {
    await window.cocoDesktop.setMode('external')
    await refreshDashboard()
  })
  document.getElementById('daemon-connect')?.addEventListener('click', async () => {
    const daemonUrlInput = document.getElementById('daemon-url') as HTMLInputElement | null
    if (!daemonUrlInput) return
    await window.cocoDesktop.setExternalDaemonUrl(daemonUrlInput.value.trim())
    await refreshDashboard()
  })
  document.getElementById('chat-send')?.addEventListener('click', async () => {
    const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
    const prompt = input?.value.trim() ?? ''
    if (!prompt) return
    appendChatLine(`You: ${prompt}`)
    if (input) input.value = ''
    const result = await window.cocoDesktop.chat(prompt)
    appendChatLine(`OpenClaw: ${result.reply}`)
    await refreshDashboard(result.task?.id)
  })

  setInterval(() => {
    void refreshDashboard()
  }, 5_000)
}

const style = document.createElement('style')
style.textContent = `
  :root { color-scheme: dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0b1311; color: #e7fff4; }
  .layout { display: grid; gap: 16px; padding: 20px; }
  .panel { border: 1px solid #27453b; border-radius: 12px; padding: 16px; background: #13201c; }
  .monitor-grid { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .chat .log, pre { white-space: pre-wrap; overflow: auto; max-height: 260px; background: #0f1815; border-radius: 8px; padding: 10px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  input, textarea, button { font: inherit; }
  input, textarea { width: 100%; background: #08100e; color: #e7fff4; border: 1px solid #27453b; border-radius: 8px; padding: 10px; }
  button { background: #1d6b4b; color: white; border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
`
document.head.appendChild(style)

void bootstrap()
