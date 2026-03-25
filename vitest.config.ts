import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const rootDir = dirname(fileURLToPath(import.meta.url))

const workspaceAlias = {
  '@coco/core': resolve(rootDir, 'packages/core/src/index.ts'),
  '@coco/llm': resolve(rootDir, 'packages/llm/src/index.ts'),
  '@coco/doctor': resolve(rootDir, 'packages/doctor/src/index.ts'),
  '@coco/review': resolve(rootDir, 'packages/review/src/index.ts'),
  '@coco/loop': resolve(rootDir, 'packages/loop/src/index.ts'),
  '@coco/openclaw-supervisor': resolve(rootDir, 'packages/openclaw-supervisor/src/index.ts'),
  '@coco/openclaw-agent': resolve(rootDir, 'packages/openclaw-agent/src/index.ts'),
  '@coco/theia': resolve(rootDir, 'packages/theia/src/index.ts'),
  '@coco/theia-electron-app': resolve(rootDir, 'packages/theia-electron-app/src/index.ts'),
  '@coco/cli': resolve(rootDir, 'packages/cli/src/index.ts'),
  '@coco/worker': resolve(rootDir, 'packages/worker/src/index.ts'),
  '@coco/orchestrator': resolve(rootDir, 'packages/orchestrator/src/index.ts'),
  '@coco/telegram': resolve(rootDir, 'packages/telegram/src/index.ts'),
}

export default defineConfig({
  resolve: {
    alias: workspaceAlias,
  },
  test: {
    projects: [
      'packages/core',
      'packages/llm',
      'packages/doctor',
      'packages/review',
      'packages/loop',
      'packages/openclaw-supervisor',
      'packages/openclaw-agent',
      'packages/theia',
      'packages/theia-electron-app',
      'packages/cli',
      'packages/worker',
      'packages/orchestrator',
      'packages/telegram',
    ],
  },
})
