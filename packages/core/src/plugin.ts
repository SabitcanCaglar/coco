export type PluginKind = 'framework-expert' | 'review-check' | 'llm-provider'

export interface PluginManifest {
  name: string
  version: string
  kind: PluginKind
  capabilities: string[]
}
