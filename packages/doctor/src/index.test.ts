import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { simpleGit } from 'simple-git'
import { describe, expect, it } from 'vitest'

import {
  DoctorRuntime,
  defineFrameworkExpert,
  doctorPackage,
  expertRegistry,
  listDoctorPlugins,
  loadFrameworkExpertPlugins,
} from './index.js'

async function createFixtureRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'coco-doctor-'))
  await mkdir(join(repoPath, 'src'))
  await writeFile(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'doctor-fixture',
        private: true,
        scripts: {
          test: 'node -e "process.exit(0)"',
          build: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    ),
  )
  await writeFile(join(repoPath, '.gitignore'), 'node_modules\ndist\n.env\n')
  await writeFile(
    join(repoPath, 'src', 'index.ts'),
    "console.log('debug')\n// TODO: clean this up\nexport const value = 1\n",
  )

  const git = simpleGit(repoPath)
  await git.init()
  await git.addConfig('user.name', 'coco-test')
  await git.addConfig('user.email', 'coco@example.com')
  await git.add('.')
  await git.commit('initial commit')

  return repoPath
}

describe('@coco/doctor', () => {
  it('registers framework experts in the scaffold registry', () => {
    const initialSize = expertRegistry.length
    const definition = defineFrameworkExpert({
      framework: 'nextjs',
      name: 'Next.js Expert',
      description: 'Scaffold smoke test',
      detect: () => true,
      find: () => [],
      prescribe: () => [],
    })

    expect(definition.framework).toBe('nextjs')
    expect(expertRegistry).toHaveLength(initialSize + 1)
    expertRegistry.splice(initialSize)
  })

  it('exposes scaffold package metadata', () => {
    expect(doctorPackage.name).toBe('@coco/doctor')
    expect(doctorPackage.status).toBe('ready')
    expect(listDoctorPlugins().length).toBeGreaterThan(0)
  })

  it('examines a repo and returns findings plus prescriptions', async () => {
    const repoPath = await createFixtureRepo()
    const runtime = new DoctorRuntime()

    try {
      const report = await runtime.examine({
        id: 'repo-1',
        rootPath: repoPath,
        defaultBranch: 'main',
        languageHints: [],
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      expect(report.findings.length).toBeGreaterThan(0)
      expect(report.prescriptions.length).toBeGreaterThan(0)
      expect(report.diagnoses.length).toBeGreaterThan(0)
      expect(report.prescriptions.some((prescription) => prescription.patchPlan)).toBe(true)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('loads external framework expert plugins from file paths', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'coco-doctor-plugin-'))
    const pluginPath = join(pluginDir, 'custom-expert.mjs')
    await writeFile(
      pluginPath,
      `export const plugin = {
        manifest: {
          name: 'external-doctor-plugin',
          version: '0.1.0',
          kind: 'framework-expert',
          capabilities: ['doctor-findings']
        },
        expert: {
          framework: 'custom',
          name: 'Custom Expert',
          detect: () => true,
          find: () => [],
          prescribe: () => []
        }
      };`,
    )

    try {
      const plugins = await loadFrameworkExpertPlugins([pluginPath])
      expect(plugins).toHaveLength(1)
      expect(plugins[0]?.manifest.name).toBe('external-doctor-plugin')
    } finally {
      await rm(pluginDir, { recursive: true, force: true })
    }
  })
})
