const STUB_MESSAGE =
  '@coco/doctor is scaffolded as the examination engine boundary. The real phased doctor workflow is still to come.'

export interface FrameworkExpertDefinition {
  framework: string
  name: string
  description?: string
}

export const expertRegistry: FrameworkExpertDefinition[] = []

export function defineFrameworkExpert(
  definition: FrameworkExpertDefinition,
): FrameworkExpertDefinition {
  expertRegistry.push(definition)
  return definition
}

export class DoctorEngine {
  readonly status = 'stub' as const

  async examine(): Promise<never> {
    throw new Error(STUB_MESSAGE)
  }
}

export const doctorPackage = {
  name: '@coco/doctor',
  status: 'stub',
  message: STUB_MESSAGE,
} as const
