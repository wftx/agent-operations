import { describe, expect, it } from 'vitest';
import {
  FakeAgentRuntimeAdapter,
  RUNTIME_PROVIDERS,
  RUNTIME_STATES,
  createAgentRuntimeId,
  createRuntimeInventoryFixtures,
  isRuntimeProvider,
  isRuntimeState,
  type AgentRuntimeSummary,
} from '../src/index.js';

describe('Agent Operations runtime contract', () => {
  it('exposes only the normalized provider and state vocabulary', () => {
    expect(RUNTIME_PROVIDERS).toEqual(['claude', 'codex', 'opencode', 'hermes', 'unknown']);
    expect(RUNTIME_STATES).toEqual(['running', 'stopped', 'starting', 'degraded', 'unknown']);
    expect(isRuntimeProvider('codex')).toBe(true);
    expect(isRuntimeProvider('codex-app-server')).toBe(false);
    expect(isRuntimeState('halted')).toBe(false);
  });

  it('creates deterministic, path-safe agent identifiers', () => {
    expect(createAgentRuntimeId('research', 'agent one')).toBe('research/agent%20one');
    expect(createAgentRuntimeId(null, 'agent')).toBe('_unscoped/agent');
    expect(() => createAgentRuntimeId('research', '  ')).toThrow('Agent name is required');
  });

  it('permits observability fields to be absent', () => {
    const summary: AgentRuntimeSummary = {
      id: 'ops/quiet',
      name: 'quiet',
      organization: 'ops',
      provider: 'unknown',
      enabled: null,
      configured: false,
      capabilities: [],
      health: { state: 'unknown' },
    };
    expect(summary.health).toEqual({ state: 'unknown' });
  });
});

describe('FakeAgentRuntimeAdapter', () => {
  it('provides deterministic healthy, stopped, and degraded fixtures', async () => {
    const adapter = new FakeAgentRuntimeAdapter();
    const agents = await adapter.listAgents();
    expect(agents.map(agent => agent.health.state).sort()).toEqual(['degraded', 'running', 'stopped']);
    expect(agents.map(agent => agent.provider).sort()).toEqual(['claude', 'codex', 'hermes']);
    expect(await adapter.getHealth()).toEqual({
      state: 'available',
      observedAt: '2026-01-01T00:00:00.000Z',
      agentCount: 3,
    });
  });

  it('returns copies and supports deterministic lookup', async () => {
    const adapter = new FakeAgentRuntimeAdapter(createRuntimeInventoryFixtures());
    const first = await adapter.getAgent('research/researcher');
    expect(first?.name).toBe('researcher');
    expect(await adapter.getAgent('missing/agent')).toBeNull();

    if (first) (first.health as { state: string }).state = 'stopped';
    expect((await adapter.getAgent('research/researcher'))?.health.state).toBe('running');
  });
});
