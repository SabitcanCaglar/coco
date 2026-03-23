import type { Finding, TriageResult } from '../types.js'

export interface FrameworkExpert {
  id: string
  frameworks: string[]
  examine(projectPath: string, triage: TriageResult): Promise<Finding[]>
}

export const expertRegistry = new Map<string, FrameworkExpert>()

// ── Generic expert — runs on every project ──────────────────────────────────
expertRegistry.set('generic', {
  id: 'generic',
  frameworks: ['*'],
  async examine(projectPath, triage) {
    const findings: Finding[] = []

    // convert red flags to findings
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

// ── Next.js expert ──────────────────────────────────────────────────────────
expertRegistry.set('nextjs', {
  id: 'nextjs',
  frameworks: ['nextjs'],
  async examine(_projectPath, _triage) {
    // TODO: next.config.js security headers, server/client boundary,
    //       API route rate limiting, ISR/SSG/SSR selection
    return []
  },
})

// ── Supabase expert ─────────────────────────────────────────────────────────
expertRegistry.set('supabase', {
  id: 'supabase',
  frameworks: ['supabase'],
  async examine(_projectPath, _triage) {
    // TODO: RLS check, service_role key in client code?
    return []
  },
})

// ── Prisma expert ───────────────────────────────────────────────────────────
expertRegistry.set('prisma', {
  id: 'prisma',
  frameworks: ['prisma'],
  async examine(_projectPath, _triage) {
    // TODO: N+1 query, raw SQL injection, connection pooling
    return []
  },
})

// ── Docker expert ───────────────────────────────────────────────────────────
expertRegistry.set('docker', {
  id: 'docker',
  frameworks: ['docker'],
  async examine(_projectPath, _triage) {
    // TODO: root user, multi-stage build, .dockerignore, health check
    return []
  },
})

/**
 * Plugin API — community experts register via this function
 */
export function defineFrameworkExpert(expert: FrameworkExpert): FrameworkExpert {
  expertRegistry.set(expert.id, expert)
  return expert
}
