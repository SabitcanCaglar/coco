export const plugin = {
  manifest: {
    name: 'example-llm-mock-provider',
    version: '0.1.0',
    kind: 'llm-provider',
    capabilities: ['llm-generate'],
    source: 'external',
    description: 'Example LLM provider plugin for local testing.',
  },
  provider: {
    name: 'example-mock',
    models: [
      {
        provider: 'example-mock',
        name: 'example-mock-1',
        family: 'mock',
        supportsJson: true,
        supportsTools: false,
      },
    ],
    async generate() {
      return {
        model: this.models[0],
        content: '{"message":"example plugin response"}',
        finishReason: 'stop',
      }
    },
  },
}
