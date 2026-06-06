import { randomUUID } from 'node:crypto'
import { type IncomingMessage, createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  ApprovalMode,
  CreatedBySurface,
  ExecutionMode,
  Mission,
  MissionAction,
  MissionAutonomyPolicy,
  MissionCommandEnvelope,
  MissionEvent,
  RepoExecutionProfile,
  StepClass,
} from '@coco/core'
import { LLMRegistry } from '@coco/llm'

function now(): string {
  return new Date().toISOString()
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
}

function approvalModeForStepClasses(stepClasses: StepClass[]): ApprovalMode {
  return stepClasses.some((stepClass) =>
    ['deploy', 'migration', 'destructive'].includes(stepClass),
  )
    ? 'approval-heavy'
    : 'mixed'
}

function buildDefaultAutonomyPolicy(): MissionAutonomyPolicy {
  return {
    mode: 'mixed-auto',
    retryIntervalSeconds: 120,
    maxAutoRetriesPerStep: 3,
    enableWebResearch: true,
    pauseOnRepeatedFailure: true,
  }
}

function normalizeIntentText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseJsonObject<T>(input: string): T | undefined {
  const trimmed = input.trim()
  const raw = trimmed.startsWith('```')
    ? trimmed
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim()
    : trimmed
  try {
    return JSON.parse(raw) as T
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as T
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolvePromise) => {
      setTimeout(() => resolvePromise(undefined), timeoutMs)
    }),
  ])
}

function repoNameVariants(value: string): string[] {
  const normalized = normalizeIntentText(value)
  if (!normalized) return []
  const spaced = normalized.replace(/[_-]+/g, ' ')
  const compact = spaced.replace(/\s+/g, '')
  const dashed = spaced.replace(/\s+/g, '-')
  const underscored = spaced.replace(/\s+/g, '_')
  const tokens = spaced.split(' ').filter(Boolean)
  const phrases: string[] = []
  for (let size = 2; size <= Math.min(tokens.length, 3); size += 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      phrases.push(tokens.slice(index, index + size).join(' '))
    }
  }
  return [
    ...new Set([
      normalized,
      spaced,
      dashed,
      underscored,
      compact,
      ...phrases.flatMap((phrase) => {
        const phraseCompact = phrase.replace(/\s+/g, '')
        return [phrase, phrase.replace(/\s+/g, '-'), phrase.replace(/\s+/g, '_'), phraseCompact]
      }),
    ]),
  ]
}

function swapAdjacentCharacters(value: string): string[] {
  const variants = new Set<string>([value])
  for (let index = 0; index < value.length - 1; index += 1) {
    const chars = value.split('')
    const current = chars[index] ?? ''
    chars[index] = chars[index + 1] ?? ''
    chars[index + 1] = current
    variants.add(chars.join(''))
  }
  return [...variants]
}

function profileAliases(profile: RepoExecutionProfile): string[] {
  const basename = profile.rootPath.split('/').at(-1) ?? profile.repoId
  return [...new Set([...repoNameVariants(profile.repoId), ...repoNameVariants(basename)])]
}

function extractRepoIntents(text: string, repoProfiles: RepoExecutionProfile[]): string[] {
  const normalized = normalizeIntentText(text)
  const compact = normalized.replace(/[\s/_-]+/g, '')
  const intents = new Set<string>()

  for (const profile of repoProfiles) {
    const aliases = profileAliases(profile)
    const matched = aliases.some((alias) => {
      const aliasNormalized = normalizeIntentText(alias)
      const aliasCompact = aliasNormalized.replace(/[\s/_-]+/g, '')
      return (
        (aliasNormalized.length >= 3 && normalized.includes(aliasNormalized)) ||
        (aliasCompact.length >= 4 &&
          swapAdjacentCharacters(aliasCompact).some((variant) => compact.includes(variant)))
      )
    })
    if (matched) intents.add(profile.repoId)
  }

  return [...intents]
}

function isStepClass(value: string): value is StepClass {
  return [
    'chat',
    'analysis',
    'edit',
    'build',
    'test',
    'research',
    'deploy',
    'migration',
    'destructive',
  ].includes(value)
}

type FollowUpKind = 'none' | 'plan' | 'progress' | 'eta' | 'social'

interface InterpreterOutput {
  action: MissionAction
  executionMode: ExecutionMode
  requestedStepClasses: StepClass[]
  shouldDispatch: boolean
  followUpKind: FollowUpKind
  repoIntents: string[]
  socialReply?: string | undefined
  provider?: string | undefined
  model?: string | undefined
}

interface StatusSnapshot {
  mission: Mission
  steps: Array<Record<string, unknown>>
  checkpoints: Array<Record<string, unknown>>
  liveJobs: Array<Record<string, unknown>>
  repoNames: Record<string, string>
}

function fallbackInterpret(
  text: string,
  repoProfiles: RepoExecutionProfile[],
  latestMission?: Mission,
): InterpreterOutput {
  const normalized = normalizeIntentText(text)
  const repoIntents = extractRepoIntents(text, repoProfiles)

  if (!normalized) {
    return {
      action: 'status',
      executionMode: 'chat_only',
      requestedStepClasses: ['chat'],
      shouldDispatch: false,
      followUpKind: 'none',
      repoIntents,
    }
  }

  if (/\b(seviyorum seni|tesekkur|saol|eyvallah|adamsin|kralsin)\b/.test(normalized)) {
    return {
      action: 'status',
      executionMode: 'chat_only',
      requestedStepClasses: ['chat'],
      shouldDispatch: false,
      followUpKind: 'social',
      repoIntents,
      socialReply: 'Buradayim. Missioni beraber tasiyip sana net checkpointler gecmeye devam edecegim.',
    }
  }

  if (/\b(dur|pause|bekle)\b/.test(normalized)) {
    return {
      action: 'pause',
      executionMode: 'chat_only',
      requestedStepClasses: ['chat'],
      shouldDispatch: true,
      followUpKind: 'none',
      repoIntents,
    }
  }
  if (/\b(devam|resume|surdur)\b/.test(normalized) && latestMission) {
    return {
      action: 'resume',
      executionMode: 'chat_only',
      requestedStepClasses: ['chat'],
      shouldDispatch: true,
      followUpKind: 'progress',
      repoIntents,
    }
  }
  if (/\b(iptal|cancel|kill)\b/.test(normalized)) {
    return {
      action: 'cancel',
      executionMode: 'chat_only',
      requestedStepClasses: ['chat'],
      shouldDispatch: true,
      followUpKind: 'none',
      repoIntents,
    }
  }

  if (/\b(ne zaman biter|eta|kac dakika|ne kadar surer)\b/.test(normalized)) {
    return {
      action: 'status',
      executionMode: 'chat_only',
      requestedStepClasses: ['chat'],
      shouldDispatch: false,
      followUpKind: 'eta',
      repoIntents,
    }
  }

  if (
    /\b(devam mi|hangi adimdayiz|ne yapiyorsun|durum|hangi task|ne oldu|canli ozet)\b/.test(
      normalized,
    )
  ) {
    return {
      action: 'status',
      executionMode: 'chat_only',
      requestedStepClasses: ['chat'],
      shouldDispatch: false,
      followUpKind: 'progress',
      repoIntents,
    }
  }

  if (
    latestMission &&
    /\b(hangi dosya\w*|icerik\w*|plan\w*|neler ol\w*|ne olustur\w*|haber ver\w*)\b/.test(
      normalized,
    )
  ) {
    return {
      action: 'status',
      executionMode: 'chat_only',
      requestedStepClasses: ['chat'],
      shouldDispatch: false,
      followUpKind: 'plan',
      repoIntents: repoIntents.length > 0 ? repoIntents : latestMission.activeRepos,
    }
  }

  const wantsAutopilot =
    /\b(auto\s*pilot|autopilot|uzun|paralel|tek chat session|checkpoint)\b/.test(normalized) ||
    /\b(paralel|sessiondan|yonetecegiz|yoneticegiz|yonetecez|yoneticez)\b/.test(normalized)
  const wantsExecution =
    /\b(plan|analiz|fix|duzelt|build|test|autopilot|auto\s*pilot|yaz|refactor)\b/.test(
      normalized,
    ) ||
    /\b(olustur\w*|kur\w*|gelistir\w*|yap\w*|yonet\w*|tasarla\w*|ac\w*)\b/.test(normalized) ||
    /\b(dosya\w*|modul\w*|proje\w*|backend\w*|frontend\w*|ui\b|api\b|oyun\b)\b/.test(normalized)

  if (wantsExecution) {
    const stepClasses: StepClass[] = []
    if (/\b(analiz|inspect|review)\b/.test(normalized)) stepClasses.push('analysis')
    if (/\b(build)\b/.test(normalized)) stepClasses.push('build')
    if (/\b(test)\b/.test(normalized)) stepClasses.push('test')
    if (
      /\b(refactor|duzelt|fix|yaz)\b/.test(normalized) ||
      /\b(olustur\w*|kur\w*|gelistir\w*|yap\w*|tasarla\w*)\b/.test(normalized) ||
      /\b(dosya\w*|modul\w*|proje\w*|backend\w*|frontend\w*|ui\b|api\b|oyun\b)\b/.test(
        normalized,
      )
    ) {
      stepClasses.push('edit')
    }
    if (stepClasses.length === 0) stepClasses.push('analysis', 'edit')
    return {
      action: 'create',
      executionMode: wantsAutopilot ? 'durable_autopilot' : 'one_shot',
      requestedStepClasses: stepClasses,
      shouldDispatch: true,
      followUpKind: 'none',
      repoIntents,
      ...(process.env.OPENROUTER_API_KEY ? { provider: 'openclaw' } : {}),
      ...(process.env.COCO_OPENROUTER_MODEL ? { model: process.env.COCO_OPENROUTER_MODEL } : {}),
    }
  }

  return {
    action: 'status',
    executionMode: 'chat_only',
    requestedStepClasses: ['chat'],
    shouldDispatch: false,
    followUpKind: latestMission ? 'progress' : 'none',
    repoIntents,
  }
}

async function interpretWithModel(input: {
  text: string
  latestMission?: Mission | undefined
  repoProfiles: RepoExecutionProfile[]
  threadMessages: ThreadMessage[]
}): Promise<InterpreterOutput | undefined> {
  if (!process.env.OPENROUTER_API_KEY) return undefined
  const registry = new LLMRegistry()
  const response = await registry.generate(
    {
      systemPrompt: [
        'You are a mission interpreter for a chat-first control plane.',
        'Return strict JSON only.',
        'Classify whether the message should create/update/control a mission or stay chat-only.',
        'Prefer status/progress/eta follow-up classification for short operator questions tied to an existing mission.',
        'Purely social messages must not mutate mission state.',
        'Extract repo intents from the repo ids and root paths provided in KNOWN_REPO_PROFILES.',
        'Prefer canonical repo ids from KNOWN_REPO_PROFILES when you can infer them.',
        'Use executionMode durable_autopilot for long-running multi-project prompts.',
        'Use requestedStepClasses from chat|analysis|edit|build|test|research|deploy|migration|destructive.',
        'Do not invent unknown repos.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            `USER_MESSAGE:\n${input.text}`,
            `LATEST_MISSION:\n${JSON.stringify(input.latestMission ?? null, null, 2)}`,
            `KNOWN_REPO_PROFILES:\n${JSON.stringify(
              input.repoProfiles.map((profile) => ({
                repoId: profile.repoId,
                rootPath: profile.rootPath,
                stackFamily: profile.stackFamily,
                runnerType: profile.runnerType,
              })),
              null,
              2,
            )}`,
            `THREAD_TAIL:\n${JSON.stringify(input.threadMessages.slice(-6), null, 2)}`,
            `Return JSON:
{
  "action": "create|update|pause|resume|cancel|reprioritize|status",
  "executionMode": "chat_only|one_shot|durable_autopilot",
  "requestedStepClasses": ["chat"],
  "shouldDispatch": true,
  "followUpKind": "none|plan|progress|eta|social",
  "repoIntents": ["optional aliases"],
  "socialReply": "optional natural Turkish reply",
  "provider": "optional",
  "model": "optional"
}`,
          ].join('\n\n'),
        },
      ],
      temperature: 0,
      maxOutputTokens: 220,
      responseFormat: 'json',
    },
    {
      provider: 'openclaw',
      ...(process.env.COCO_OPENROUTER_MODEL ? { model: process.env.COCO_OPENROUTER_MODEL } : {}),
    },
  )

  if (response.finishReason === 'error') return undefined
  const parsed = parseJsonObject<Partial<InterpreterOutput>>(response.content)
  if (!parsed) return undefined
  const requestedStepClasses: StepClass[] = Array.isArray(parsed.requestedStepClasses)
    ? parsed.requestedStepClasses.filter(
        (value): value is StepClass => typeof value === 'string' && isStepClass(value),
      )
    : ['chat']
  return {
    action: (parsed.action as MissionAction | undefined) ?? 'status',
    executionMode: (parsed.executionMode as ExecutionMode | undefined) ?? 'chat_only',
    requestedStepClasses: requestedStepClasses.length > 0 ? requestedStepClasses : ['chat'],
    shouldDispatch: Boolean(parsed.shouldDispatch),
    followUpKind: (parsed.followUpKind as FollowUpKind | undefined) ?? 'none',
    repoIntents: Array.isArray(parsed.repoIntents)
      ? parsed.repoIntents.filter((value): value is string => typeof value === 'string')
      : [],
    ...(typeof parsed.socialReply === 'string' ? { socialReply: parsed.socialReply } : {}),
    ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
    ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
  }
}

function displayRepoName(profile: RepoExecutionProfile): string {
  return profile.rootPath.split('/').at(-1) ?? profile.repoId
}

function deriveWorkstreams(
  text: string,
  targetRepos: string[],
  repoProfiles: RepoExecutionProfile[],
): string[] {
  const normalized = normalizeIntentText(text)
  const workstreams = targetRepos
    .map((repoId) => repoProfiles.find((profile) => profile.repoId === repoId))
    .filter((profile): profile is RepoExecutionProfile => Boolean(profile))
    .map((profile) => {
      const repoLabel = displayRepoName(profile)
      switch (profile.stackFamily) {
        case 'cpp-unreal':
          return `${repoLabel} icin Unreal gameplay, oyun loopu ve servis entegrasyon iskeleti`
        case 'csharp':
          return `${repoLabel} icin solution/proje yapisi, servis katmani ve build akislarinin kurulumu`
        case 'ts':
          return `${repoLabel} icin llm-friendly modul ayrimi, uygulama akislari ve backend entegrasyonu`
        default:
          return `${repoLabel} icin repo yapisi, gorev parcasi ve entegrasyon planinin netlestirilmesi`
      }
    })

  if (/\b(paralel|tek chat session|checkpoint)\b/.test(normalized)) {
    workstreams.push('Tum is kollarini tek mission icinde checkpoint bazli paralel yonetim')
  }

  return workstreams.length > 0
    ? [...new Set(workstreams)]
    : ['Ilk turda kapsam cikarimi, repo haritalama ve dosya iskeleti olusturma']
}

function derivePlannedFiles(targetRepos: string[], repoProfiles: RepoExecutionProfile[]): string[] {
  const files = ['docs/missions/current-plan.md: hedefler, is paketleri, riskler ve checkpoint plani']

  for (const repoId of targetRepos) {
    const profile = repoProfiles.find((candidate) => candidate.repoId === repoId)
    if (!profile) continue
    const repoLabel = displayRepoName(profile)
    if (profile.stackFamily === 'cpp-unreal') {
      files.push(
        `${repoLabel}/Source/: target, build, game mode ve player controller girisleri`,
        `${repoLabel}/Config/DefaultGame.ini: ilk oyun ayarlari ve servis konfigurasyonu`,
      )
      continue
    }
    if (profile.stackFamily === 'csharp') {
      files.push(
        `${repoLabel}/docs/architecture.md: katmanlar, servis akisları ve entegrasyon plani`,
        `${repoLabel}/src/ veya */*.csproj: uygulama modulleri ve servis iskeleti`,
      )
      continue
    }
    if (profile.stackFamily === 'ts') {
      files.push(
        `${repoLabel}/docs/architecture.md: ekranlar, veri akisi ve backend kullanim plani`,
        `${repoLabel}/src/: uygulama klasor yapisi, moduller ve API client`,
      )
      continue
    }
    files.push(
      `${repoLabel}/docs/current-plan.md: repo ozel hedefler ve riskler`,
      `${repoLabel}/: ilk klasor ve entegrasyon iskeleti`,
    )
  }

  return [...new Set(files)]
}

function buildPlanSummary(
  text: string,
  targetRepos: string[],
  repoProfiles: RepoExecutionProfile[],
): string {
  return [
    'Ilk tur plani:',
    ...deriveWorkstreams(text, targetRepos, repoProfiles).map((item) => `- ${item}`),
    '',
    'Ilk olusturmayi bekledigim dosya gruplari:',
    ...derivePlannedFiles(targetRepos, repoProfiles).map((item) => `- ${item}`),
    '',
    'Her checkpointte hangi dosyalari actigimi, icerik taslagini ve bir sonraki adimi sana yazacagim.',
  ].join('\n')
}

function buildEtaClass(snapshot: StatusSnapshot): 'birazdan' | 'birkac dakika' | 'belirsiz' | 'blocked' {
  if (snapshot.mission.status === 'blocked') return 'blocked'
  const activeCount = snapshot.steps.filter((step) =>
    ['running', 'queued', 'retryable'].includes(String(step.status ?? '')),
  ).length
  if (activeCount <= 1 && snapshot.steps.length <= 1) return 'birazdan'
  if (activeCount > 0) return 'birkac dakika'
  return 'belirsiz'
}

function buildFallbackStatusSummary(snapshot: StatusSnapshot): string {
  const prioritizedStep =
    snapshot.steps.find((step) => String(step.status) === 'failed') ??
    snapshot.steps.find((step) => String(step.status) === 'blocked') ??
    snapshot.steps.find((step) => String(step.status) === 'running') ??
    snapshot.steps.find((step) => String(step.status) === 'queued') ??
    snapshot.steps[0]
  const latestCheckpoint =
    [...snapshot.checkpoints]
      .reverse()
      .find((checkpoint) =>
        String((checkpoint.payload as Record<string, unknown> | undefined)?.status ?? '').match(
          /failed|blocked/,
        ),
      ) ?? snapshot.checkpoints.at(-1)
  const latestJob = snapshot.liveJobs[0]
  const eta = buildEtaClass(snapshot)
  const repoLabel =
    (typeof prioritizedStep?.repoId === 'string' &&
      (snapshot.repoNames[prioritizedStep.repoId] ?? prioritizedStep.repoId)) ||
    snapshot.mission.activeRepos[0] ||
    'repo secimi'
  const jobStatus = typeof latestJob?.status === 'string' ? latestJob.status : 'beklemede'
  const nextAction =
    snapshot.mission.blockedReason ??
    snapshot.mission.checkpointSummary ??
    (typeof latestCheckpoint?.summary === 'string' && latestCheckpoint.summary
      ? latestCheckpoint.summary
      : 'Siradaki uygun step dispatch edilecek.')

  return [
    'Canli Ozet',
    `- Mission durumu: ${snapshot.mission.status}`,
    `- Aktif is kolu: ${repoLabel}`,
    `- Adim: ${String(prioritizedStep?.stepClass ?? snapshot.mission.currentPhase)}`,
    `- Job durumu: ${jobStatus}`,
    `- Son checkpoint: ${typeof latestCheckpoint?.summary === 'string' ? latestCheckpoint.summary : nextAction}`,
    `- Sonraki hamle: ${nextAction}`,
    `- ETA: ${eta}`,
  ].join('\n')
}

async function summarizeStatusWithModel(snapshot: StatusSnapshot): Promise<string | undefined> {
  if (!process.env.OPENROUTER_API_KEY) return undefined
  const registry = new LLMRegistry()
  const response = await registry.generate(
    {
      systemPrompt: [
        'You summarize a live coding mission for Telegram/Web operators.',
        'Return concise Turkish plain text.',
        'Always start with "Canli Ozet".',
        'Include mission state, current repo/workstream, job status, latest checkpoint, next action, and ETA class.',
        'ETA class must be one of: birazdan, birkac dakika, belirsiz, blocked.',
        'Do not invent exact times.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: JSON.stringify(snapshot, null, 2),
        },
      ],
      temperature: 0.1,
      maxOutputTokens: 180,
    },
    {
      provider: 'openclaw',
      ...(process.env.COCO_OPENROUTER_MODEL ? { model: process.env.COCO_OPENROUTER_MODEL } : {}),
    },
  )

  if (response.finishReason === 'error') return undefined
  return response.content.trim() || undefined
}

function buildCreateReply(
  text: string,
  mission: Mission,
  targetRepos: string[],
  repoProfiles: RepoExecutionProfile[],
): string {
  const summary = buildPlanSummary(text, targetRepos, repoProfiles)
  if (mission.status === 'blocked') {
    return [
      'Missioni actim ama hemen blokladim; eksik repo veya kritik bagimlilik cozunmeden dispatch baslatmayacagim.',
      '',
      summary,
      '',
      `Blok nedeni: ${mission.checkpointSummary ?? mission.blockedReason ?? 'Belirsiz'}`,
    ].join('\n')
  }
  if (mission.currentPhase === 'dispatch' || mission.status === 'running') {
    return ['Bunu uzun soluklu bir mission olarak ele aliyorum; checkpoint alarak kendi kendime ilerleyecegim.', '', summary].join('\n')
  }
  return ['Bunu calistirilabilir bir mission olarak aciyorum ve ilk adimi planliyorum.', '', summary].join('\n')
}

function resolveKnownTargetRepos(repoProfiles: RepoExecutionProfile[], repoIntents: string[]): string[] {
  const normalizedIntents = repoIntents.map((value) => normalizeIntentText(value))
  const matches = new Set<string>()
  for (const profile of repoProfiles) {
    const candidates = [
      profile.repoId,
      profile.rootPath.split('/').at(-1) ?? '',
      normalizeIntentText(profile.rootPath),
    ].map((value) => normalizeIntentText(String(value)))
    if (normalizedIntents.some((intent) => candidates.some((candidate) => candidate === intent))) {
      matches.add(profile.repoId)
    }
  }
  return [...matches]
}

export interface ThreadMessage {
  id: string
  threadId?: string | undefined
  role: 'user' | 'assistant'
  text: string
  surface?: string | undefined
  createdAt: string
  missionId?: string | undefined
}

export interface ChatGatewayConfig {
  controlPlaneUrl?: string
  orchestratorUrl?: string
  fetchImpl?: typeof fetch
  port?: number
}

export function createChatGateway(config: ChatGatewayConfig = {}) {
  const controlPlaneUrl = config.controlPlaneUrl ?? process.env.COCO_LANGGRAPH_URL ?? 'http://127.0.0.1:4100'
  const orchestratorUrl =
    config.orchestratorUrl ??
    process.env.COCO_ORCHESTRATOR_URL ??
    (process.env.COCO_DAEMON_URL || 'http://127.0.0.1:3000')
  const fetchImpl = config.fetchImpl ?? fetch

  async function controlPlaneRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`${controlPlaneUrl}${path}`, init)
    if (!response.ok) {
      const body = (await response.text().catch(() => '')) || response.statusText
      throw new Error(`chat-gateway control plane request failed for ${path}: ${body}`)
    }
    return (await response.json()) as T
  }

  async function orchestratorRequest<T>(path: string): Promise<T | undefined> {
    try {
      const response = await fetchImpl(`${orchestratorUrl}${path}`)
      if (!response.ok) return undefined
      return (await response.json()) as T
    } catch {
      return undefined
    }
  }

  async function buildStatusSnapshot(mission: Mission): Promise<StatusSnapshot> {
    const [steps, checkpoints, repoProfiles] = await Promise.all([
      controlPlaneRequest<Array<Record<string, unknown>>>(`/missions/${mission.missionId}/steps`).catch(
        () => [],
      ),
      controlPlaneRequest<Array<Record<string, unknown>>>(
        `/missions/${mission.missionId}/checkpoints`,
      ).catch(() => []),
      controlPlaneRequest<RepoExecutionProfile[]>('/repo-profiles').catch(() => []),
    ])
    const jobIds = steps
      .map((step) => {
        const outputs = step.outputs
        if (outputs && typeof outputs === 'object') {
          const jobId = (outputs as Record<string, unknown>).orchestratorJobId
          if (typeof jobId === 'string' && jobId) return jobId
        }
        return undefined
      })
      .filter((value): value is string => Boolean(value))
    const liveJobs = (
      await Promise.all(
        jobIds.slice(0, 3).map(async (jobId) => {
          const record = await orchestratorRequest<Record<string, unknown>>(`/jobs/${jobId}`)
          if (!record || typeof record.job !== 'object' || !record.job) return undefined
          return { jobId, ...(record.job as Record<string, unknown>) }
        }),
      )
    ).filter((value) => Boolean(value)) as Array<Record<string, unknown>>
    const repoNames = Object.fromEntries(
      repoProfiles.map((profile) => [
        profile.repoId,
        profile.rootPath.split('/').at(-1) ?? profile.repoId,
      ]),
    )
    return { mission, steps, checkpoints, liveJobs, repoNames }
  }

  async function postMessage(
    threadId: string,
    input: {
      text: string
      surface?: CreatedBySurface
      userId?: string
      tenantId?: string
      workspaceId?: string
    },
  ): Promise<{
    reply: string
    envelope: MissionCommandEnvelope
    mission?: Mission | undefined
  }> {
    const text = input.text.trim()
    const [repoProfiles, missions, thread] = await Promise.all([
      controlPlaneRequest<RepoExecutionProfile[]>('/repo-profiles').catch(() => []),
      controlPlaneRequest<Mission[]>('/missions').catch(() => []),
      controlPlaneRequest<{ threadId: string; messages: ThreadMessage[] }>(
        `/threads/${encodeURIComponent(threadId)}`,
      ).catch(() => ({ threadId, messages: [] })),
    ])
    const latestMission = missions.find((candidate) => candidate.threadId === threadId)
    const interpreted =
      (await withTimeout(
        interpretWithModel({
          text,
          latestMission,
          repoProfiles,
          threadMessages: thread.messages,
        }).catch(() => undefined),
        8_000,
      )) ?? fallbackInterpret(text, repoProfiles, latestMission)
    const targetRepos = resolveKnownTargetRepos(repoProfiles, interpreted.repoIntents)
    const idempotencyKey = randomUUID()
    const surfaceEventId = randomUUID()
    const envelope: MissionCommandEnvelope = {
      chatReply: '',
      missionAction: interpreted.action,
      executionMode: interpreted.executionMode,
      targetRepos: interpreted.repoIntents.length > 0 ? interpreted.repoIntents : targetRepos,
      requestedStepClasses: interpreted.requestedStepClasses,
      autonomyPolicy: buildDefaultAutonomyPolicy(),
      approvalMode: approvalModeForStepClasses(interpreted.requestedStepClasses),
      idempotencyKey,
      surfaceEventId,
    }

    await controlPlaneRequest<ThreadMessage>(`/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'user',
        text,
        surface: input.surface ?? 'web',
        idempotency_key: `${idempotencyKey}:user`,
      }),
    })

    let mission: Mission | undefined
    let reply = interpreted.socialReply ?? 'Mesaji aldim.'

    if (interpreted.action === 'create') {
      mission = await controlPlaneRequest<Mission>('/missions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: text,
          thread_id: threadId,
          user_id: input.userId ?? threadId,
          tenant_id: input.tenantId,
          workspace_id: input.workspaceId,
          created_by_surface: input.surface ?? 'web',
          execution_mode: interpreted.executionMode,
          requested_step_classes: interpreted.requestedStepClasses,
          active_repos: targetRepos,
          target_repos: interpreted.repoIntents.length > 0 ? interpreted.repoIntents : targetRepos,
          approval_mode: envelope.approvalMode,
          autonomy_policy: envelope.autonomyPolicy,
          idempotency_key: idempotencyKey,
          surface_event_id: surfaceEventId,
          ...(interpreted.provider ? { provider: interpreted.provider } : {}),
          ...(interpreted.model ? { model: interpreted.model } : {}),
        }),
      })
      const refreshedProfiles = await controlPlaneRequest<RepoExecutionProfile[]>('/repo-profiles').catch(
        () => repoProfiles,
      )
      reply = `${buildCreateReply(text, mission, mission.activeRepos, refreshedProfiles)}\n\nMission ${mission.missionId} acildi.`
    } else if (interpreted.action === 'pause' || interpreted.action === 'resume' || interpreted.action === 'cancel') {
      if (latestMission) {
        mission = await controlPlaneRequest<Mission>(`/missions/${latestMission.missionId}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            command: interpreted.action,
            idempotency_key: idempotencyKey,
            surface_event_id: surfaceEventId,
            expected_version: latestMission.version,
            surface: input.surface ?? 'web',
          }),
        })
        reply =
          interpreted.action === 'pause'
            ? 'Aktif mission varsa duraklatma istegini uyguladim.'
            : interpreted.action === 'resume'
              ? 'Aktif mission varsa son checkpointten devam ettiriyorum.'
              : 'Aktif mission varsa iptal ettim.'
      } else {
        reply = 'Kontrol edilecek aktif bir mission bulamadim.'
      }
    } else if (latestMission && (interpreted.followUpKind === 'plan' || interpreted.followUpKind === 'progress' || interpreted.followUpKind === 'eta')) {
      const snapshot = await buildStatusSnapshot(latestMission)
      if (interpreted.followUpKind === 'plan') {
        reply = [
          'Bu mission icin simdiki plan ozeti su sekilde:',
          '',
          buildPlanSummary(latestMission.goal, latestMission.activeRepos, repoProfiles),
        ].join('\n')
      } else {
        reply =
          (await withTimeout(summarizeStatusWithModel(snapshot).catch(() => undefined), 6_000)) ??
          buildFallbackStatusSummary(snapshot)
      }
      mission = latestMission
    } else if (interpreted.followUpKind === 'social') {
      reply = interpreted.socialReply ?? 'Buradayim.'
    } else if (latestMission) {
      const snapshot = await buildStatusSnapshot(latestMission)
      reply =
        (await withTimeout(summarizeStatusWithModel(snapshot).catch(() => undefined), 6_000)) ??
        buildFallbackStatusSummary(snapshot)
      mission = latestMission
    } else {
      reply = 'Aktif mission yok. Istersen hedefi tek mesajda yaz, ben mission olarak acayim.'
    }

    envelope.chatReply = reply

    await controlPlaneRequest<ThreadMessage>(`/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'assistant',
        text: reply,
        surface: input.surface ?? 'web',
        mission_id: mission?.missionId,
        idempotency_key: `${idempotencyKey}:assistant`,
      }),
    })
    return { reply, envelope, ...(mission ? { mission } : {}) }
  }

  async function getThread(threadId: string): Promise<{ threadId: string; messages: ThreadMessage[] }> {
    return controlPlaneRequest<{ threadId: string; messages: ThreadMessage[] }>(
      `/threads/${encodeURIComponent(threadId)}`,
    )
  }

  const server = createServer(async (incomingRequest, response) => {
    const url = new URL(incomingRequest.url ?? '/', 'http://127.0.0.1')
    try {
      if (incomingRequest.method === 'GET' && url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ status: 'ok', package: '@coco/chat-gateway' }))
        return
      }
      if (incomingRequest.method === 'POST' && /^\/threads\/[^/]+\/messages$/.test(url.pathname)) {
        const threadId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
        const body = await readJson(incomingRequest)
        const result = await postMessage(threadId, {
          text: String(body.text ?? ''),
          ...(body.surface ? { surface: body.surface as CreatedBySurface } : {}),
          ...(body.user_id ? { userId: String(body.user_id) } : {}),
          ...(body.tenant_id ? { tenantId: String(body.tenant_id) } : {}),
          ...(body.workspace_id ? { workspaceId: String(body.workspace_id) } : {}),
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result))
        return
      }
      if (incomingRequest.method === 'GET' && /^\/threads\/[^/]+$/.test(url.pathname)) {
        const threadId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(await getThread(threadId)))
        return
      }
      if (incomingRequest.method === 'GET' && url.pathname === '/missions') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(await controlPlaneRequest<Mission[]>('/missions')))
        return
      }
      if (incomingRequest.method === 'GET' && /^\/missions\/[^/]+$/.test(url.pathname)) {
        const missionId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(await controlPlaneRequest<Mission>(`/missions/${missionId}/state`)))
        return
      }
      if (incomingRequest.method === 'GET' && /^\/missions\/[^/]+\/events$/.test(url.pathname)) {
        const missionId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(await controlPlaneRequest<MissionEvent[]>(`/missions/${missionId}/events`)),
        )
        return
      }
      if (incomingRequest.method === 'POST' && /^\/missions\/[^/]+\/control$/.test(url.pathname)) {
        const missionId = decodeURIComponent(url.pathname.split('/')[2] ?? '')
        const body = await readJson(incomingRequest)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            await controlPlaneRequest<Mission>(`/missions/${missionId}/commands`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
          ),
        )
        return
      }

      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Not found.' }))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })

  return {
    server,
    postMessage,
    getThread,
    async start(): Promise<void> {
      const port = config.port ?? Number(process.env.PORT ?? 4200)
      await new Promise<void>((resolvePromise) => {
        server.listen(port, '0.0.0.0', () => resolvePromise())
      })
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolvePromise()
        })
      })
    },
  }
}

export const chatGatewayPackage = {
  name: '@coco/chat-gateway',
  status: 'ready',
  message: 'Chat-first mission gateway for Web and Telegram surfaces.',
} as const

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false
}

if (isDirectExecution()) {
  const gateway = createChatGateway()
  void gateway.start().then(() => {
    const port = Number(process.env.PORT ?? 4200)
    console.log(`Chat gateway listening on http://127.0.0.1:${port}`)
  })
}
