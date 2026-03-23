import { readdir, readFile, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import type { TriageResult, LanguageInfo, FrameworkInfo, RedFlag } from '../types.js'

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.dart': 'dart',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.c': 'c',
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  'vendor', '.turbo', 'coverage', '.nyc_output', 'target',
])

async function walkDir(
  dir: string,
  maxDepth: number,
  depth = 0
): Promise<string[]> {
  if (depth > maxDepth) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkDir(full, maxDepth, depth + 1)))
    } else {
      files.push(full)
    }
  }
  return files
}

function detectLanguages(files: string[]): LanguageInfo[] {
  const counts: Record<string, number> = {}
  for (const f of files) {
    const lang = LANGUAGE_MAP[extname(f).toLowerCase()]
    if (lang) counts[lang] = (counts[lang] ?? 0) + 1
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([language, fileCount]) => ({
      language,
      fileCount,
      percentage: Math.round((fileCount / total) * 100),
    }))
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}

async function detectFrameworks(
  projectPath: string,
  files: string[]
): Promise<FrameworkInfo[]> {
  const fileSet = new Set(files.map((f) => f.replace(projectPath + '/', '')))
  const detected: FrameworkInfo[] = []
  const check = (name: string, markers: string[], confidence: number, category?: string, version?: string) => {
    if (markers.some((m) => fileSet.has(m) || [...fileSet].some((f) => f.includes(m)))) {
      detected.push({ name, confidence, category, version })
    }
  }

  check('nextjs', ['next.config.js', 'next.config.ts', 'next.config.mjs'], 0.98, 'frontend')
  check('nuxt', ['nuxt.config.js', 'nuxt.config.ts'], 0.97, 'frontend')
  check('sveltekit', ['svelte.config.js', 'svelte.config.ts'], 0.97, 'frontend')
  check('astro', ['astro.config.js', 'astro.config.ts', 'astro.config.mjs'], 0.97, 'frontend')
  check('remix', ['remix.config.js', 'remix.config.ts'], 0.97, 'frontend')
  check('angular', ['angular.json'], 0.99, 'frontend')
  check('vite', ['vite.config.js', 'vite.config.ts'], 0.9, 'build')
  check('django', ['manage.py', 'settings.py'], 0.95, 'backend')
  check('fastapi', ['main.py'], 0.6, 'backend')
  check('flask', ['app.py'], 0.6, 'backend')
  check('rails', ['Gemfile', 'config/routes.rb'], 0.95, 'backend')
  check('laravel', ['artisan', 'composer.json'], 0.9, 'backend')
  check('spring', ['pom.xml', 'build.gradle'], 0.85, 'backend')
  check('prisma', ['prisma/schema.prisma'], 0.99, 'orm')
  check('drizzle', ['drizzle.config.ts', 'drizzle.config.js'], 0.97, 'orm')
  check('supabase', ['supabase/config.toml'], 0.99, 'infra')
  check('firebase', ['firebase.json'], 0.99, 'infra')
  check('docker', ['docker-compose.yml', 'docker-compose.yaml', 'Dockerfile'], 0.95, 'infra')
  check('github-actions', ['.github/workflows/'], 0.95, 'ci')

  // more detailed detection from package.json
  const pkgPath = join(projectPath, 'package.json')
  if (await fileExists(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8').catch(() => '{}')).dependencies ?? {}
    if ('express' in pkg) detected.push({ name: 'express', confidence: 0.99, category: 'backend' })
    if ('hono' in pkg) detected.push({ name: 'hono', confidence: 0.99, category: 'backend' })
    if ('fastify' in pkg) detected.push({ name: 'fastify', confidence: 0.99, category: 'backend' })
  }

  return detected
}

async function quickRedFlagScan(projectPath: string, files: string[]): Promise<RedFlag[]> {
  const flags: RedFlag[] = []
  const gitignorePath = join(projectPath, '.gitignore')

  // missing .gitignore?
  if (!(await fileExists(gitignorePath))) {
    flags.push({ id: 'no-gitignore', severity: 'medium', message: 'No .gitignore file found' })
  }

  // .env committed to git?
  const envFiles = files.filter((f) => /\.env(\.|$)/.test(f))
  if (envFiles.length > 0) {
    let gitignoreContent = ''
    if (await fileExists(gitignorePath)) {
      gitignoreContent = await readFile(gitignorePath, 'utf-8').catch(() => '')
    }
    for (const envFile of envFiles) {
      if (!gitignoreContent.includes('.env')) {
        flags.push({
          id: 'env-not-ignored',
          severity: 'critical',
          message: `.env file may be committed to git: ${envFile}`,
          file: envFile,
        })
      }
    }
  }

  return flags
}

export async function triage(projectPath: string): Promise<TriageResult> {
  const files = await walkDir(projectPath, 6)

  const languages = detectLanguages(files)
  const primaryLanguage = languages[0]?.language ?? 'unknown'
  const frameworks = await detectFrameworks(projectPath, files)
  const redFlags = await quickRedFlagScan(projectPath, files)

  const hasTS = languages.some((l) => l.language === 'typescript')
  const hasTests = files.some((f) => /\.(test|spec)\.(ts|tsx|js|jsx|py|go|rs)$/.test(f))
  const hasDocker = files.some((f) => /Dockerfile|docker-compose/.test(f))
  const hasCICD =
    files.some((f) => f.includes('.github/workflows')) ||
    files.some((f) => f.includes('.gitlab-ci'))
  const hasMonorepo =
    files.some((f) => f.includes('pnpm-workspace.yaml')) ||
    files.some((f) => f.includes('lerna.json'))

  const packageManager = await (async () => {
    if (await fileExists(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm'
    if (await fileExists(join(projectPath, 'yarn.lock'))) return 'yarn'
    if (await fileExists(join(projectPath, 'bun.lockb'))) return 'bun'
    if (await fileExists(join(projectPath, 'package-lock.json'))) return 'npm'
    if (await fileExists(join(projectPath, 'Cargo.lock'))) return 'cargo'
    if (await fileExists(join(projectPath, 'go.sum'))) return 'go_mod'
    if (await fileExists(join(projectPath, 'Pipfile.lock'))) return 'pipenv'
    if (await fileExists(join(projectPath, 'poetry.lock'))) return 'poetry'
    return 'unknown'
  })()

  const urgency = redFlags.some((f) => f.severity === 'critical')
    ? 'critical'
    : redFlags.some((f) => f.severity === 'high')
    ? 'high'
    : 'normal'

  return {
    projectType: 'web_app',  // can be refined with deeper analysis
    languages,
    primaryLanguage,
    frameworks,
    packageManager,
    hasDocker,
    hasCICD,
    hasTests,
    hasTypeScript: hasTS,
    hasMonorepo,
    redFlags,
    urgency,
  }
}
