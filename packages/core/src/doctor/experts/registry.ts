import type { Finding, TriageResult } from '../types.js'

export interface FrameworkExpert {
  id: string
  frameworks: string[]
  examine(projectPath: string, triage: TriageResult): Promise<Finding[]>
}

export const expertRegistry = new Map<string, FrameworkExpert>()

// ── Generic expert — her projede çalışır ────────────────────────────────────
expertRegistry.set('generic', {
  id: 'generic',
  frameworks: ['*'],
  async examine(projectPath, triage) {
    const findings: Finding[] = []

    // Red flag'leri finding'e dönüştür
    for (const flag of triage.redFlags) {
      findings.push({
        id: `generic-redflag-${flag.id}`,
        expertId: 'generic',
        category: 'security',
        severity: flag.severity,
        title: flag.message,
        description: flag.message,
        filePath: flag.file,
      })
    }

    return findings
  },
})

// ── Next.js uzmanı ───────────────────────────────────────────────────────────
expertRegistry.set('nextjs', {
  id: 'nextjs',
  frameworks: ['nextjs'],
  async examine(_projectPath, _triage) {
    // TODO: next.config.js security headers, server/client boundary,
    //       API route rate limiting, ISR/SSG/SSR seçimi
    return []
  },
})

// ── Supabase uzmanı ──────────────────────────────────────────────────────────
expertRegistry.set('supabase', {
  id: 'supabase',
  frameworks: ['supabase'],
  async examine(_projectPath, _triage) {
    // TODO: RLS kontrol, service_role key client'ta mı?
    return []
  },
})

// ── Prisma uzmanı ────────────────────────────────────────────────────────────
expertRegistry.set('prisma', {
  id: 'prisma',
  frameworks: ['prisma'],
  async examine(_projectPath, _triage) {
    // TODO: N+1 query, raw SQL injection, connection pooling
    return []
  },
})

// ── Docker uzmanı ────────────────────────────────────────────────────────────
expertRegistry.set('docker', {
  id: 'docker',
  frameworks: ['docker'],
  async examine(_projectPath, _triage) {
    // TODO: root user, multi-stage build, .dockerignore, health check
    return []
  },
})

/**
 * Plugin API — topluluk uzmanları bu fonksiyon ile kayıt yaptırır
 */
export function defineFrameworkExpert(expert: FrameworkExpert): FrameworkExpert {
  expertRegistry.set(expert.id, expert)
  return expert
}
