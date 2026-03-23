import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/llm',
      'packages/doctor',
      'packages/review',
      'packages/loop',
      'packages/cli',
    ],
  },
})
