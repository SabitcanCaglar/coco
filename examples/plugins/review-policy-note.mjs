export const plugin = {
  manifest: {
    name: 'example-review-policy-note',
    version: '0.1.0',
    kind: 'review-check',
    capabilities: ['review-policy'],
    source: 'external',
    description: 'Example review check plugin that reports a pass-through policy note.',
  },
  check: {
    id: 'example-policy',
    name: 'Example Policy',
    kind: 'policy',
    required: false,
    discover: () => null,
    run: () => ({
      result: {
        checkId: 'example-policy',
        status: 'pass',
        summary: 'Example external policy executed.',
      },
    }),
  },
}
