#!/usr/bin/env tsx
/**
 * COCO Karpathy Loop v0.1 — Proof of Concept
 *
 * Karpathy'nin autoresearch döngüsünün yazılım mühendisliğine uyarlanmış hali.
 * 3 primitif: Editable Asset (proje kodu) + Scalar Metric (health score) + Time-boxed Cycle
 *
 * observe → hypothesize → experiment → evaluate → loop
 *
 * Bağımlılık: simple-git + Node.js built-ins. LLM yok, DB yok, queue yok.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, extname, basename, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import simpleGit from 'simple-git'

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface HealthScore {
  overall: number          // 0-100
  security: number
  maintainability: number
  reliability: number
  size: number
}

interface Observation {
  score: HealthScore
  metrics: {
    totalFiles: number
    totalLines: number
    todoCount: number
    consoleLogCount: number
    emptyCatchCount: number
    largeFileCount: number   // 200+ satır
    envExposed: boolean
    hardcodedSecrets: number
    magicNumbers: number
    deepNesting: number      // 4+ seviye
  }
  fileDetails: FileDetail[]
}

interface FileDetail {
  path: string
  relativePath: string
  lines: number
  consoleLogs: number
  emptyCatches: number
  todos: number
  magicNumbers: number
  deepNesting: number
}

interface Hypothesis {
  id: string
  key: string  // deduplication key — aynı hipotezi tekrar denememek için
  description: string
  category: keyof Omit<HealthScore, 'overall'>
  expectedDelta: number
  targetFiles: string[]
  patchFn: (worktreePath: string) => Promise<PatchResult>
}

interface PatchResult {
  filesModified: number
  description: string
}

interface ExperimentResult {
  hypothesisId: string
  hypothesis: string
  beforeScore: number
  afterScore: number
  delta: number
  testsPassed: boolean | null  // null = no test command found
  status: 'validated' | 'reverted' | 'error'
  commitHash?: string
  duration: number
  error?: string
}

interface LoopConfig {
  projectPath: string
  rounds: number
  dryRun: boolean
  verbose: boolean
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONSTANTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  'vendor', '.turbo', 'coverage', '.nyc_output', 'target', '.cache',
  '.output', '.nuxt', '.svelte-kit', 'out',
])

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt',
  '.php', '.cs', '.cpp', '.c', '.swift', '.dart',
])

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret[_-]?key|password|passwd|token|auth[_-]?token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  /(?:sk|pk)[-_](?:live|test)[-_][a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWT
]

const MAGIC_NUMBER_PATTERN = /(?<![a-zA-Z_$.])\b(?!(?:0|1|2|10|100|200|201|204|301|302|400|401|403|404|500)\b)\d{4,}\b/g

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OBSERVE — metrik topla, health score hesapla
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function walkSourceFiles(dir: string, maxDepth = 8, depth = 0): Promise<string[]> {
  if (depth > maxDepth) return []
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue
    if (IGNORED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkSourceFiles(full, maxDepth, depth + 1))
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(full)
    } else if (entry.name === '.env' || entry.name.match(/\.env\./)) {
      files.push(full) // .env dosyalarını da tara
    }
  }
  return files
}

function countNestingDepth(content: string): number {
  let maxDepth = 0
  let currentDepth = 0
  for (const char of content) {
    if (char === '{') {
      currentDepth++
      if (currentDepth > maxDepth) maxDepth = currentDepth
    } else if (char === '}') {
      currentDepth = Math.max(0, currentDepth - 1)
    }
  }
  return maxDepth
}

async function analyzeFile(filePath: string, projectPath: string): Promise<FileDetail> {
  const content = await readFile(filePath, 'utf-8').catch(() => '')
  const lines = content.split('\n')
  const relativePath = relative(projectPath, filePath)

  // .env dosyaları için sadece exposed kontrolü
  if (basename(filePath).startsWith('.env')) {
    return {
      path: filePath,
      relativePath,
      lines: lines.length,
      consoleLogs: 0,
      emptyCatches: 0,
      todos: 0,
      magicNumbers: 0,
      deepNesting: 0,
    }
  }

  const consoleLogs = (content.match(/console\.(log|debug|info)\(/g) || []).length
  const emptyCatches = (content.match(/catch\s*\([^)]*\)\s*\{\s*\}/g) || []).length
  const todos = (content.match(/\/\/\s*(TODO|FIXME|HACK|XXX)/gi) || []).length
  const magicNumbers = (content.match(MAGIC_NUMBER_PATTERN) || []).length
  const nestingDepth = countNestingDepth(content)

  return {
    path: filePath,
    relativePath,
    lines: lines.length,
    consoleLogs,
    emptyCatches,
    todos,
    magicNumbers,
    deepNesting: nestingDepth >= 4 ? 1 : 0,
  }
}

function calculateHealthScore(metrics: Observation['metrics'], totalFiles: number): HealthScore {
  // Her kategori 0-100, sonra ortalamayla overall

  // Security: secrets, env exposed
  const secretPenalty = Math.min(metrics.hardcodedSecrets * 15, 60)
  const envPenalty = metrics.envExposed ? 25 : 0
  const security = Math.max(0, 100 - secretPenalty - envPenalty)

  // Maintainability: console.log, TODO, magic numbers, büyük dosyalar
  const consolePenalty = Math.min(metrics.consoleLogCount * 2, 30)
  const todoPenalty = Math.min(metrics.todoCount * 1.5, 20)
  const magicPenalty = Math.min(metrics.magicNumbers * 1, 15)
  const largePenalty = Math.min(metrics.largeFileCount * 5, 25)
  const nestingPenalty = Math.min(metrics.deepNesting * 3, 15)
  const maintainability = Math.max(0, 100 - consolePenalty - todoPenalty - magicPenalty - largePenalty - nestingPenalty)

  // Reliability: empty catches
  const catchPenalty = Math.min(metrics.emptyCatchCount * 10, 50)
  const reliability = Math.max(0, 100 - catchPenalty)

  // Size: dosya başına ortalama satır
  const avgLines = totalFiles > 0 ? metrics.totalLines / totalFiles : 0
  const sizePenalty = avgLines > 300 ? 30 : avgLines > 200 ? 15 : avgLines > 150 ? 5 : 0
  const size = Math.max(0, 100 - sizePenalty - largePenalty)

  const overall = Math.round(
    security * 0.30 +
    maintainability * 0.30 +
    reliability * 0.25 +
    size * 0.15
  )

  return {
    overall: Math.max(0, Math.min(100, overall)),
    security: Math.round(security),
    maintainability: Math.round(maintainability),
    reliability: Math.round(reliability),
    size: Math.round(size),
  }
}

async function observe(projectPath: string): Promise<Observation> {
  const files = await walkSourceFiles(projectPath)
  const fileDetails = await Promise.all(files.map(f => analyzeFile(f, projectPath)))

  // .env exposed kontrolü
  const gitignorePath = join(projectPath, '.gitignore')
  let gitignoreContent = ''
  try { gitignoreContent = await readFile(gitignorePath, 'utf-8') } catch { /* */ }
  const envExposed = fileDetails.some(f => basename(f.path).startsWith('.env')) && !gitignoreContent.includes('.env')

  // Hardcoded secrets
  let hardcodedSecrets = 0
  for (const fd of fileDetails) {
    if (basename(fd.path).startsWith('.env')) continue
    const content = await readFile(fd.path, 'utf-8').catch(() => '')
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0
      hardcodedSecrets += (content.match(pattern) || []).length
    }
  }

  const sourceFiles = fileDetails.filter(f => !basename(f.path).startsWith('.env'))

  const metrics = {
    totalFiles: sourceFiles.length,
    totalLines: sourceFiles.reduce((s, f) => s + f.lines, 0),
    todoCount: sourceFiles.reduce((s, f) => s + f.todos, 0),
    consoleLogCount: sourceFiles.reduce((s, f) => s + f.consoleLogs, 0),
    emptyCatchCount: sourceFiles.reduce((s, f) => s + f.emptyCatches, 0),
    largeFileCount: sourceFiles.filter(f => f.lines > 200).length,
    envExposed,
    hardcodedSecrets,
    magicNumbers: sourceFiles.reduce((s, f) => s + f.magicNumbers, 0),
    deepNesting: sourceFiles.reduce((s, f) => s + f.deepNesting, 0),
  }

  const score = calculateHealthScore(metrics, sourceFiles.length)

  return { score, metrics, fileDetails: sourceFiles }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HYPOTHESIZE — observation'dan hipotez üret
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function generateId(): string {
  return randomBytes(4).toString('hex').slice(0, 4)
}

function hypothesize(obs: Observation, triedHypotheses: Set<string>): Hypothesis | null {
  const candidates: Hypothesis[] = []

  // ── console.log kaldırma ──
  const consoleLogs = obs.fileDetails.filter(f => f.consoleLogs > 0)
  if (consoleLogs.length > 0) {
    const totalLogs = consoleLogs.reduce((s, f) => s + f.consoleLogs, 0)
    const key = `remove-console-logs-${consoleLogs.map(f => f.relativePath).sort().join(',')}`
    if (!triedHypotheses.has(key)) {
      candidates.push({
        id: generateId(),
        key,
        description: `Remove ${totalLogs} console.log statements from ${consoleLogs.length} files`,
        category: 'maintainability',
        expectedDelta: Math.min(totalLogs * 2, 15),
        targetFiles: consoleLogs.map(f => f.path),
        patchFn: async (worktreePath) => {
          let modified = 0
          for (const fd of consoleLogs) {
            const targetPath = join(worktreePath, fd.relativePath)
            let content: string
            try { content = await readFile(targetPath, 'utf-8') } catch { continue }
            // Satır bazında console.log kaldır (tam satır silme)
            const lines = content.split('\n')
            const filtered = lines.filter(line => !line.trim().match(/^console\.(log|debug|info)\(.*\);?\s*$/))
            if (filtered.length !== lines.length) {
              await writeFile(targetPath, filtered.join('\n'))
              modified++
            }
          }
          return { filesModified: modified, description: `Removed console.log from ${modified} files` }
        },
      })
      // key'i burada ekleme — evaluate'de eklenecek
    }
  }

  // ── Boş catch bloklarına error handling ekleme ──
  const emptyCatches = obs.fileDetails.filter(f => f.emptyCatches > 0)
  if (emptyCatches.length > 0) {
    const total = emptyCatches.reduce((s, f) => s + f.emptyCatches, 0)
    const key = `fix-empty-catches-${emptyCatches.map(f => f.relativePath).sort().join(',')}`
    if (!triedHypotheses.has(key)) {
      candidates.push({
        id: generateId(),
        key,
        description: `Add error handling to ${total} empty catch blocks in ${emptyCatches.length} files`,
        category: 'reliability',
        expectedDelta: Math.min(total * 8, 30),
        targetFiles: emptyCatches.map(f => f.path),
        patchFn: async (worktreePath) => {
          let modified = 0
          for (const fd of emptyCatches) {
            const targetPath = join(worktreePath, fd.relativePath)
            let content: string
            try { content = await readFile(targetPath, 'utf-8') } catch { continue }
            const patched = content.replace(
              /catch\s*\((\w+)\)\s*\{\s*\}/g,
              'catch ($1) {\n    console.error(\'Caught error:\', $1);\n    throw $1;\n  }'
            )
            if (patched !== content) {
              await writeFile(targetPath, patched)
              modified++
            }
          }
          return { filesModified: modified, description: `Added error handling to ${modified} files` }
        },
      })
    }
  }

  // ── TODO/FIXME'ları listeye dönüştür ──
  const todosFiles = obs.fileDetails.filter(f => f.todos > 0)
  if (todosFiles.length > 0 && obs.metrics.todoCount >= 5) {
    const key = `cleanup-todos`
    if (!triedHypotheses.has(key)) {
      candidates.push({
        id: generateId(),
        key,
        description: `Convert ${obs.metrics.todoCount} TODO/FIXME comments to standardized format in ${todosFiles.length} files`,
        category: 'maintainability',
        expectedDelta: Math.min(Math.round(obs.metrics.todoCount * 1.5), 10),
        targetFiles: todosFiles.map(f => f.path),
        patchFn: async (worktreePath) => {
          let modified = 0
          for (const fd of todosFiles) {
            const targetPath = join(worktreePath, fd.relativePath)
            let content: string
            try { content = await readFile(targetPath, 'utf-8') } catch { continue }
            // TODO/FIXME/HACK → standardized TODO(coco) format
            const patched = content
              .replace(/\/\/\s*FIXME:?\s*/gi, '// TODO(coco): [fix] ')
              .replace(/\/\/\s*HACK:?\s*/gi, '// TODO(coco): [refactor] ')
              .replace(/\/\/\s*XXX:?\s*/gi, '// TODO(coco): [review] ')
            if (patched !== content) {
              await writeFile(targetPath, patched)
              modified++
            }
          }
          return { filesModified: modified, description: `Standardized TODOs in ${modified} files` }
        },
      })
    }
  }

  // ── Magic number'ları named constant'a çevir ──
  const magicFiles = obs.fileDetails.filter(f => f.magicNumbers > 0)
  if (magicFiles.length > 0) {
    const key = `fix-magic-numbers-${magicFiles.map(f => f.relativePath).sort().join(',')}`
    if (!triedHypotheses.has(key)) {
      candidates.push({
        id: generateId(),
        key,
        description: `Replace ${obs.metrics.magicNumbers} magic numbers with named constants in ${magicFiles.length} files`,
        category: 'maintainability',
        expectedDelta: Math.min(obs.metrics.magicNumbers * 1.5, 10),
        targetFiles: magicFiles.map(f => f.path),
        patchFn: async (worktreePath) => {
          let modified = 0
          for (const fd of magicFiles) {
            const targetPath = join(worktreePath, fd.relativePath)
            let content: string
            try { content = await readFile(targetPath, 'utf-8') } catch { continue }
            // Her magic number'ı bul ve dosya başına constant ekle
            const matches = content.match(MAGIC_NUMBER_PATTERN)
            if (!matches || matches.length === 0) continue
            const unique = [...new Set(matches)]
            let header = '\n// Auto-extracted constants\n'
            let patched = content
            for (const num of unique.slice(0, 5)) { // max 5 per file
              const constName = `CONST_${num}`
              header += `const ${constName} = ${num};\n`
              patched = patched.replace(new RegExp(`(?<![a-zA-Z_$])${num}(?![a-zA-Z_$0-9])`, 'g'), constName)
            }
            if (patched !== content) {
              // constant'ları import'lar sonrasına ekle
              const insertIdx = patched.search(/\n(?!import |\/\/)/)
              if (insertIdx > 0) {
                patched = patched.slice(0, insertIdx) + header + patched.slice(insertIdx)
              } else {
                patched = header + patched
              }
              await writeFile(targetPath, patched)
              modified++
            }
          }
          return { filesModified: modified, description: `Extracted magic numbers in ${modified} files` }
        },
      })
    }
  }

  if (candidates.length === 0) return null

  // En yüksek expectedDelta olan hipotezi seç
  candidates.sort((a, b) => b.expectedDelta - a.expectedDelta)
  return candidates[0]
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPERIMENT — git worktree'de izole deney
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function detectTestCommand(projectPath: string): string | null {
  try {
    const pkgPath = join(projectPath, 'package.json')
    const pkg = JSON.parse(require('node:fs').readFileSync(pkgPath, 'utf-8'))
    if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
      return 'npm test'
    }
  } catch { /* */ }

  // Python
  try {
    execSync('which pytest', { stdio: 'ignore' })
    const pyproject = join(projectPath, 'pyproject.toml')
    try { require('node:fs').statSync(pyproject); return 'pytest' } catch { /* */ }
  } catch { /* */ }

  // Go
  try {
    const goMod = join(projectPath, 'go.mod')
    require('node:fs').statSync(goMod)
    return 'go test ./...'
  } catch { /* */ }

  // Rust
  try {
    const cargoToml = join(projectPath, 'Cargo.toml')
    require('node:fs').statSync(cargoToml)
    return 'cargo test'
  } catch { /* */ }

  return null
}

function runTests(projectPath: string, testCommand: string): boolean {
  try {
    execSync(testCommand, {
      cwd: projectPath,
      stdio: 'pipe',
      timeout: 120_000, // 2 dakika timeout
      env: { ...process.env, CI: '1', NODE_ENV: 'test' },
    })
    return true
  } catch {
    return false
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN LOOP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function log(phase: string, msg: string) {
  const gray = '\x1b[90m'
  const reset = '\x1b[0m'
  const bold = '\x1b[1m'
  const green = '\x1b[32m'
  const red = '\x1b[31m'
  const yellow = '\x1b[33m'
  const cyan = '\x1b[36m'

  const colors: Record<string, string> = {
    observe: cyan,
    hypothesize: yellow,
    experiment: bold,
    patch: gray,
    test: bold,
    're-audit': cyan,
    evaluate: green,
    error: red,
    summary: bold,
  }

  const color = colors[phase] || reset
  console.log(`  ${gray}[${color}${phase}${gray}]${reset} ${msg}`)
}

function printScore(score: HealthScore) {
  const bar = (val: number) => {
    const filled = Math.round(val / 5)
    const empty = 20 - filled
    const color = val >= 70 ? '\x1b[32m' : val >= 40 ? '\x1b[33m' : '\x1b[31m'
    return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)}\x1b[0m ${val}`
  }
  console.log(`            security:        ${bar(score.security)}`)
  console.log(`            maintainability: ${bar(score.maintainability)}`)
  console.log(`            reliability:     ${bar(score.reliability)}`)
  console.log(`            size:            ${bar(score.size)}`)
}

async function run(config: LoopConfig) {
  const { projectPath, rounds, dryRun } = config
  const git = simpleGit(projectPath)

  // Git repo mu kontrol et
  const isRepo = await git.checkIsRepo().catch(() => false)
  if (!isRepo) {
    console.error('\x1b[31mError: Not a git repository. Karpathy Loop requires git.\x1b[0m')
    process.exit(1)
  }

  // Uncommitted changes var mı?
  const status = await git.status()
  if (status.modified.length > 0 || status.staged.length > 0) {
    console.error('\x1b[31mError: Uncommitted changes detected. Commit or stash first.\x1b[0m')
    process.exit(1)
  }

  const currentBranch = status.current || 'main'

  console.log()
  console.log('  \x1b[1mCOCO Karpathy Loop v0.1\x1b[0m')
  console.log(`  Target: ${projectPath}`)
  if (dryRun) console.log('  \x1b[33mMode: DRY RUN (no changes will be made)\x1b[0m')
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log()

  // İlk observation
  const initialObs = await observe(projectPath)
  log('observe', `Initial health score: \x1b[1m${initialObs.score.overall}/100\x1b[0m`)
  printScore(initialObs.score)
  console.log()

  if (dryRun) {
    // Dry run: sadece observe + hypothesize
    const triedSet = new Set<string>()
    for (let i = 0; i < rounds; i++) {
      const h = hypothesize(initialObs, triedSet)
      if (!h) { log('hypothesize', 'No more hypotheses to try.'); break }
      log('hypothesize', `"${h.description}" → expected +${h.expectedDelta} ${h.category}`)
      triedSet.add(h.key)
    }
    console.log()
    console.log('  \x1b[33mDry run complete. No changes were made.\x1b[0m')
    return
  }

  // Test komutu
  const testCommand = detectTestCommand(projectPath)
  if (testCommand) {
    log('observe', `Test command detected: \x1b[1m${testCommand}\x1b[0m`)
  } else {
    log('observe', '\x1b[33mNo test command found — experiments will skip test validation\x1b[0m')
  }
  console.log()

  const results: ExperimentResult[] = []
  const triedHypotheses = new Set<string>()
  let currentScore = initialObs.score.overall

  for (let round = 1; round <= rounds; round++) {
    console.log(`  \x1b[90m[round ${round}/${rounds}]\x1b[0m`)
    const roundStart = Date.now()

    // Re-observe (her round'da güncel durumu oku)
    const obs = round === 1 ? initialObs : await observe(projectPath)
    currentScore = obs.score.overall

    // Hypothesize
    const hypothesis = hypothesize(obs, triedHypotheses)
    if (!hypothesis) {
      log('hypothesize', 'No more hypotheses to try. Stopping.')
      break
    }
    triedHypotheses.add(hypothesis.key)
    log('hypothesize', `"${hypothesis.description}" → expected +${hypothesis.expectedDelta} ${hypothesis.category}`)

    // Experiment — git worktree oluştur
    const expId = hypothesis.id
    const worktreePath = join(projectPath, '..', `coco-exp-${expId}`)
    const branchName = `experiment/${expId}`

    try {
      log('experiment', `worktree: ${relative(projectPath, worktreePath)} | branch: ${branchName}`)

      // Worktree oluştur
      await git.raw(['worktree', 'add', '-b', branchName, worktreePath])

      // Patch uygula
      const patchResult = await hypothesis.patchFn(worktreePath)
      log('patch', patchResult.description)

      if (patchResult.filesModified === 0) {
        log('evaluate', '\x1b[33m⊘ SKIPPED — no changes applied\x1b[0m')
        // Cleanup
        await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {})
        await git.raw(['branch', '-D', branchName]).catch(() => {})
        results.push({
          hypothesisId: expId,
          hypothesis: hypothesis.description,
          beforeScore: currentScore,
          afterScore: currentScore,
          delta: 0,
          testsPassed: null,
          status: 'reverted',
          duration: Date.now() - roundStart,
        })
        console.log()
        continue
      }

      // Testleri çalıştır (varsa)
      let testsPassed: boolean | null = null
      if (testCommand) {
        testsPassed = runTests(worktreePath, testCommand)
        log('test', `${testCommand} → ${testsPassed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}`)
      }

      // Re-audit
      const afterObs = await observe(worktreePath)
      const delta = afterObs.score.overall - currentScore
      log('re-audit', `New score: ${afterObs.score.overall}/100 (${delta >= 0 ? '+' : ''}${delta})`)

      // Evaluate
      const improved = delta > 0
      const testsOk = testsPassed === null || testsPassed

      if (improved && testsOk) {
        // Validated — commit worktree changes, then merge to main
        const worktreeGit = simpleGit(worktreePath)
        await worktreeGit.add('.')
        const commitResult = await worktreeGit.commit(
          `coco: ${hypothesis.description}\n\nKarpathy Loop experiment ${expId}\nScore: ${currentScore} → ${afterObs.score.overall} (+${delta})`
        )
        const commitHash = commitResult.commit?.slice(0, 7) || 'unknown'

        // Merge experiment branch into main
        await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {})
        await git.merge([branchName, '--no-ff', '-m', `coco: merge experiment/${expId}`]).catch(async () => {
          // Merge conflict — fast-forward dene
          await git.merge([branchName]).catch(() => {})
        })
        await git.raw(['branch', '-d', branchName]).catch(() => {})

        log('evaluate', `\x1b[32m✓ VALIDATED\x1b[0m — committed as ${commitHash}`)

        results.push({
          hypothesisId: expId,
          hypothesis: hypothesis.description,
          beforeScore: currentScore,
          afterScore: afterObs.score.overall,
          delta,
          testsPassed,
          status: 'validated',
          commitHash,
          duration: Date.now() - roundStart,
        })
      } else {
        // Revert
        await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {})
        await git.raw(['branch', '-D', branchName]).catch(() => {})

        const reason = !testsOk ? 'tests failed' : `no improvement (${delta >= 0 ? '+' : ''}${delta})`
        log('evaluate', `\x1b[31m✗ REVERTED\x1b[0m — ${reason}`)

        results.push({
          hypothesisId: expId,
          hypothesis: hypothesis.description,
          beforeScore: currentScore,
          afterScore: afterObs.score.overall,
          delta,
          testsPassed,
          status: 'reverted',
          duration: Date.now() - roundStart,
        })
      }
    } catch (err: any) {
      log('error', err.message || String(err))
      // Cleanup on error
      await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {})
      await git.raw(['branch', '-D', branchName]).catch(() => {})
      results.push({
        hypothesisId: expId,
        hypothesis: hypothesis.description,
        beforeScore: currentScore,
        afterScore: currentScore,
        delta: 0,
        testsPassed: null,
        status: 'error',
        error: err.message,
        duration: Date.now() - roundStart,
      })
    }

    console.log()
  }

  // ── Summary ──
  const validated = results.filter(r => r.status === 'validated')
  const reverted = results.filter(r => r.status === 'reverted')
  const errors = results.filter(r => r.status === 'error')
  const finalObs = await observe(projectPath)
  const totalDelta = finalObs.score.overall - initialObs.score.overall
  const totalDuration = results.reduce((s, r) => s + r.duration, 0)

  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  \x1b[1mSUMMARY\x1b[0m')
  console.log(`    Rounds:     ${results.length}`)
  console.log(`    Validated:  \x1b[32m${validated.length}\x1b[0m (${results.length > 0 ? Math.round(validated.length / results.length * 100) : 0}%)`)
  console.log(`    Reverted:   \x1b[31m${reverted.length}\x1b[0m`)
  if (errors.length > 0) console.log(`    Errors:     \x1b[31m${errors.length}\x1b[0m`)
  console.log(`    Score:      ${initialObs.score.overall} → \x1b[1m${finalObs.score.overall}\x1b[0m (${totalDelta >= 0 ? '+' : ''}${totalDelta})`)
  console.log(`    Duration:   ${formatDuration(totalDuration)}`)
  if (validated.length > 0) {
    console.log(`    Commits:    ${validated.map(r => r.commitHash).join(', ')}`)
  }
  console.log()
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function parseArgs(args: string[]): LoopConfig {
  const positional: string[] = []
  let rounds = 5
  let dryRun = false
  let verbose = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--rounds' || arg === '-r') {
      rounds = parseInt(args[++i] || '5', 10)
    } else if (arg === '--dry-run' || arg === '-n') {
      dryRun = true
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
  COCO Karpathy Loop v0.1

  Usage: npx tsx karpathy-loop.ts [project-path] [options]

  Options:
    --rounds, -r <n>    Number of experiment rounds (default: 5)
    --dry-run, -n       Only observe and hypothesize, no changes
    --verbose, -v       Show detailed output
    --help, -h          Show this help

  Examples:
    npx tsx karpathy-loop.ts .                    # Current dir, 5 rounds
    npx tsx karpathy-loop.ts /path/to/project -r 10
    npx tsx karpathy-loop.ts . --dry-run          # Preview only
`)
      process.exit(0)
    } else if (!arg.startsWith('-')) {
      positional.push(arg)
    }
  }

  const projectPath = positional[0]
    ? join(process.cwd(), positional[0]).replace(/\/+$/, '')
    : process.cwd()

  return { projectPath, rounds, dryRun, verbose }
}

// SIGINT graceful shutdown
let shuttingDown = false
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(1)
  shuttingDown = true
  console.log('\n  \x1b[33mGraceful shutdown... finishing current experiment.\x1b[0m')
})

// Entry point
const config = parseArgs(process.argv.slice(2))

// resolve to absolute path
const resolvedPath = config.projectPath.startsWith('/')
  ? config.projectPath
  : join(process.cwd(), config.projectPath)

run({ ...config, projectPath: resolvedPath }).catch((err) => {
  console.error('\x1b[31mFatal error:\x1b[0m', err.message)
  process.exit(1)
})
