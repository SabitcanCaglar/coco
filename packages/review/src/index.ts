const STUB_MESSAGE =
  '@coco/review is scaffolded as the review gate boundary. Lint/test/diff orchestration will land in a later milestone.'

export class ReviewGate {
  readonly status = 'stub' as const

  async run(): Promise<never> {
    throw new Error(STUB_MESSAGE)
  }
}

export const reviewPackage = {
  name: '@coco/review',
  status: 'stub',
  message: STUB_MESSAGE,
} as const
