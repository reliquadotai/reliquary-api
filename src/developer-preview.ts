/** Official read-only workflows shipped with the customer client. */
export const OFFICIAL_SKILLS = [
  {
    id: 'reliquary-compute',
    title: 'Find compute for your workload',
    description: 'Compare provider offers with their package costs, source freshness and booking limits.',
    prompt: 'Compare H200 offers, show their sources and freshness, and explain how I can book them.',
    command: 'reliqua compute list --gpu H200 --json',
    docs: '/docs/agents/compute',
    mcpTools: ['reliquary_connection', 'reliquary_compute_catalog'],
  },
  {
    id: 'reliquary-observe',
    title: 'Follow published network evidence',
    description: 'Inspect published models and network observations while keeping missing and stale sources visible.',
    prompt: 'Summarize published checkpoints and network activity. Explain which sources are stale or missing.',
    command: 'reliqua inventory --json',
    docs: '/docs/agents/observe',
    mcpTools: ['reliquary_connection', 'reliquary_inventory', 'reliquary_network'],
  },
] as const;

export const DEVELOPER_PREVIEW = {
  version: '0.4.0',
  cli: 'reliqua',
  executionEnabled: false,
  docsOrigin: 'https://app.reliqua.ai',
  apiOrigin: 'https://api.reliqua.ai',
} as const;
