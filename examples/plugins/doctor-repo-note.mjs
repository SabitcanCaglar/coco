export const plugin = {
  manifest: {
    name: 'example-doctor-repo-note',
    version: '0.1.0',
    kind: 'framework-expert',
    capabilities: ['doctor-findings'],
    source: 'external',
    description: 'Example doctor plugin that adds a lightweight diagnosis note.',
  },
  expert: {
    framework: 'example-repo-note',
    name: 'Example Repo Note',
    detect: () => true,
    find: () => [
      {
        id: 'example-repo-note-finding',
        phase: 'diagnosis',
        title: 'Example plugin loaded',
        summary: 'This finding comes from an external doctor plugin.',
        severity: 'low',
        tags: ['example', 'plugin'],
        evidence: [],
        targetFiles: [],
      },
    ],
    prescribe: () => [],
  },
}
