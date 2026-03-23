#!/usr/bin/env node

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const STUB_MESSAGE =
  '@coco/cli is scaffolded. For now, use `pnpm loop -- <project-path>` while the dedicated CLI surface is being built.'

export const cliPackage = {
  name: '@coco/cli',
  status: 'stub',
  message: STUB_MESSAGE,
} as const

export function getCLIStubMessage(): string {
  return STUB_MESSAGE
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false
}

if (isDirectExecution()) {
  console.log(STUB_MESSAGE)
}
