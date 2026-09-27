export function buildAgentOverlayScript(): string {
  return `
(() => {
  const existing = document.getElementById('coco-agent-overlay');
  if (existing) return;

  const style = document.createElement('style');
  style.textContent = \`
    #coco-agent-overlay {
      position: fixed;
      top: 34px;
      right: 0;
      bottom: 24px;
      width: 380px;
      z-index: 999999;
      background: var(--theia-sideBar-background, #1e1e1e);
      border-left: 1px solid var(--theia-sideBar-border, var(--theia-widget-border, #3c3c3c));
      box-shadow: -18px 0 40px rgba(0,0,0,0.18);
      color: var(--theia-foreground, #cccccc);
      font-family: var(--theia-ui-font-family, ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #coco-agent-overlay.coco-collapsed {
      width: 52px;
    }
    #coco-agent-overlay .coco-agent-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid var(--theia-sideBar-border, var(--theia-widget-border, #3c3c3c));
      background: var(--theia-titleBar-activeBackground, var(--theia-editorGroupHeader-tabsBackground, #252526));
    }
    #coco-agent-overlay .coco-agent-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #coco-agent-overlay .coco-agent-kicker {
      font-size: 11px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--theia-descriptionForeground, #8c8c8c);
    }
    #coco-agent-overlay .coco-agent-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      min-height: 0;
      flex: 1;
    }
    #coco-agent-overlay.coco-collapsed .coco-agent-title,
    #coco-agent-overlay.coco-collapsed .coco-agent-body {
      display: none;
    }
    #coco-agent-overlay .coco-agent-tab {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      font-size: 12px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--theia-descriptionForeground, #8c8c8c);
      display: none;
      margin: auto;
    }
    #coco-agent-overlay.coco-collapsed .coco-agent-tab {
      display: block;
    }
    #coco-agent-overlay .coco-log,
    #coco-agent-overlay .coco-tasks {
      white-space: pre-wrap;
      overflow: auto;
      background: var(--theia-editor-background, #1e1e1e);
      color: var(--theia-editor-foreground, #d4d4d4);
      border-radius: 8px;
      padding: 10px;
      border: 1px solid var(--theia-widget-border, #3c3c3c);
    }
    #coco-agent-overlay .coco-log { max-height: 220px; }
    #coco-agent-overlay .coco-tasks { max-height: 180px; }
    #coco-agent-overlay textarea {
      width: 100%;
      box-sizing: border-box;
      background: var(--theia-input-background, #3c3c3c);
      color: var(--theia-input-foreground, #f3f3f3);
      border: 1px solid var(--theia-input-border, var(--theia-widget-border, #3c3c3c));
      border-radius: 8px;
      padding: 10px;
      resize: vertical;
    }
    #coco-agent-overlay .coco-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    #coco-agent-overlay button {
      font: inherit;
      cursor: pointer;
      border-radius: 8px;
      padding: 8px 12px;
      background: var(--theia-button-background, #0e639c);
      color: var(--theia-button-foreground, #ffffff);
      border: 1px solid transparent;
    }
    #coco-agent-overlay button.coco-secondary {
      background: var(--theia-input-background, #3c3c3c);
      color: var(--theia-input-foreground, #f3f3f3);
      border-color: var(--theia-widget-border, #3c3c3c);
    }
    #coco-agent-overlay .coco-status {
      font-size: 12px;
      color: var(--theia-descriptionForeground, #8c8c8c);
    }
  \`;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'coco-agent-overlay';
  root.innerHTML = \`
    <div class="coco-agent-header">
      <div class="coco-agent-title">
        <div class="coco-agent-kicker">OpenClaw</div>
        <div style="font-weight:700;">Agent Panel</div>
      </div>
      <div class="coco-row">
        <button id="coco-agent-min" class="coco-secondary">Hide</button>
      </div>
    </div>
    <div id="coco-agent-body" class="coco-agent-body">
      <div id="coco-agent-status" class="coco-status">Connecting to Coco bridge...</div>
      <div id="coco-agent-log" class="coco-log">OpenClaw is ready.</div>
      <textarea id="coco-agent-input" rows="5" placeholder="Describe the goal. Example: analyze this repo without changing code"></textarea>
      <div class="coco-row">
        <button id="coco-agent-send">Send</button>
        <button id="coco-agent-refresh" class="coco-secondary">Refresh</button>
      </div>
      <div id="coco-agent-tasks" class="coco-tasks">Waiting for task data...</div>
    </div>
    <div class="coco-agent-tab">OpenClaw</div>
  \`;

  document.body.appendChild(root);

  const statusEl = root.querySelector('#coco-agent-status');
  const logEl = root.querySelector('#coco-agent-log');
  const tasksEl = root.querySelector('#coco-agent-tasks');
  const inputEl = root.querySelector('#coco-agent-input');
  const minEl = root.querySelector('#coco-agent-min');

  const getBridge = () => globalThis.cocoDesktop || globalThis.__COCO_DESKTOP__;

  const appendLog = (line) => {
    if (!logEl) return;
    logEl.textContent = (logEl.textContent ? logEl.textContent + '\\n\\n' : '') + line;
    logEl.scrollTop = logEl.scrollHeight;
  };

  const setStatus = (line) => {
    if (statusEl) statusEl.textContent = line;
  };

  const refresh = async () => {
    const bridge = getBridge();
    if (!bridge) {
      setStatus('Waiting for Coco bridge...');
      return;
    }
    try {
      const boot = await bridge.getBootStatus();
      const snapshot = await bridge.snapshot();
      setStatus(\`\${snapshot.runtime.mode} · \${snapshot.runtime.state} · theia=\${boot.theia.state}\`);
      if (tasksEl) {
        tasksEl.textContent = snapshot.tasks.length
          ? snapshot.tasks.map(task => \`- \${task.mode} · \${task.status} · \${task.goal}\`).join('\\n')
          : 'No tasks yet.';
      }
    } catch (error) {
      setStatus(\`Connection error: \${error instanceof Error ? error.message : String(error)}\`);
    }
  };

  root.querySelector('#coco-agent-send')?.addEventListener('click', async () => {
    const bridge = getBridge();
    if (!bridge) {
      appendLog('OpenClaw: Coco bridge is not ready yet.');
      return;
    }
    const prompt = inputEl && 'value' in inputEl ? String(inputEl.value || '').trim() : '';
    if (!prompt) return;
    appendLog('You: ' + prompt);
    if (inputEl && 'value' in inputEl) inputEl.value = '';
    try {
      const result = await bridge.chat(prompt);
      appendLog('OpenClaw: ' + result.reply);
      await refresh();
    } catch (error) {
      appendLog('OpenClaw: ' + (error instanceof Error ? error.message : String(error)));
    }
  });

  root.querySelector('#coco-agent-refresh')?.addEventListener('click', () => { void refresh(); });
  minEl?.addEventListener('click', () => {
    root.classList.toggle('coco-collapsed');
    if (minEl instanceof HTMLButtonElement) {
      minEl.textContent = root.classList.contains('coco-collapsed') ? 'Show' : 'Hide';
    }
  });

  void refresh();
  setInterval(() => { void refresh(); }, 5000);
})();
`
}
