import type {
  AgentRuntimeAdapter,
  AgentRuntimeDetail,
  AgentRuntimeSummary,
  RuntimeInventoryHealth,
} from '../runtime.js';

const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';

function cloneSummary(agent: AgentRuntimeSummary): AgentRuntimeSummary {
  return {
    ...agent,
    capabilities: [...agent.capabilities],
    health: { ...agent.health },
  };
}

function cloneDetail(agent: AgentRuntimeDetail): AgentRuntimeDetail {
  return { ...cloneSummary(agent), observedAt: agent.observedAt };
}

/** Deterministic fixtures for AO-domain tests that must not require CortextOS. */
export function createRuntimeInventoryFixtures(): readonly AgentRuntimeDetail[] {
  return [
    {
      id: 'research/researcher',
      name: 'researcher',
      displayName: 'Research',
      organization: 'research',
      provider: 'claude',
      enabled: true,
      configured: true,
      capabilities: ['session-resume'],
      health: {
        state: 'running',
        lastHeartbeat: FIXTURE_TIME,
        pid: 4101,
      },
      observedAt: FIXTURE_TIME,
    },
    {
      id: 'engineering/coder',
      name: 'coder',
      organization: 'engineering',
      provider: 'codex',
      enabled: false,
      configured: true,
      capabilities: ['session-resume'],
      health: { state: 'stopped', reason: 'Disabled fixture' },
      observedAt: FIXTURE_TIME,
    },
    {
      id: 'operations/analyst',
      name: 'analyst',
      organization: 'operations',
      provider: 'hermes',
      enabled: true,
      configured: true,
      capabilities: ['session-resume'],
      health: { state: 'degraded', reason: 'Heartbeat is stale' },
      observedAt: FIXTURE_TIME,
    },
  ];
}

export class FakeAgentRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly agents: readonly AgentRuntimeDetail[];
  private readonly inventoryHealth: RuntimeInventoryHealth;

  constructor(
    agents: readonly AgentRuntimeDetail[] = createRuntimeInventoryFixtures(),
    inventoryHealth?: RuntimeInventoryHealth,
  ) {
    this.agents = agents.map(cloneDetail).sort((a, b) => a.id.localeCompare(b.id));
    this.inventoryHealth = inventoryHealth ?? {
      state: 'available',
      observedAt: FIXTURE_TIME,
      agentCount: agents.length,
    };
  }

  async listAgents(): Promise<readonly AgentRuntimeSummary[]> {
    return this.agents.map(cloneSummary);
  }

  async getAgent(id: string): Promise<AgentRuntimeDetail | null> {
    const agent = this.agents.find(candidate => candidate.id === id);
    return agent ? cloneDetail(agent) : null;
  }

  async getHealth(): Promise<RuntimeInventoryHealth> {
    return { ...this.inventoryHealth };
  }
}
