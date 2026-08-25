import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntimeAdapter } from '../../agent-operations-contracts/src/index.js';
import {
  CortextOSRuntimeAdapter,
  normalizeCortextOSProvider,
} from '../src/index.js';

const OBSERVED_AT = '2026-02-03T04:05:06.000Z';

describe('CortextOSRuntimeAdapter', () => {
  let root: string;
  let frameworkRoot: string;
  let ctxRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ao-runtime-adapter-'));
    frameworkRoot = join(root, 'framework');
    ctxRoot = join(root, 'state');
    mkdirSync(join(frameworkRoot, 'orgs'), { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function addAgent(
    organization: string,
    name: string,
    config: unknown = {},
    displayName?: string,
  ): void {
    const agentRoot = join(frameworkRoot, 'orgs', organization, 'agents', name);
    mkdirSync(agentRoot, { recursive: true });
    writeFileSync(join(agentRoot, 'config.json'), JSON.stringify(config));
    if (displayName) {
      writeFileSync(join(agentRoot, 'IDENTITY.md'), `# Identity\n\n## Name\n${displayName}\n\n## Role\nTest agent\n`);
    }
  }

  function writeHeartbeat(name: string, value: unknown): void {
    const stateRoot = join(ctxRoot, 'state', name);
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, 'heartbeat.json'), typeof value === 'string' ? value : JSON.stringify(value));
  }

  function adapter(statusResponse: unknown): CortextOSRuntimeAdapter {
    return new CortextOSRuntimeAdapter({
      frameworkRoot,
      ctxRoot,
      now: () => new Date(OBSERVED_AT),
      statusReader: async () => statusResponse,
    });
  }

  it('normalizes every current CortextOS runtime name', () => {
    expect(normalizeCortextOSProvider(undefined)).toBe('claude');
    expect(normalizeCortextOSProvider('claude-code')).toBe('claude');
    expect(normalizeCortextOSProvider('codex-app-server')).toBe('codex');
    expect(normalizeCortextOSProvider('opencode')).toBe('opencode');
    expect(normalizeCortextOSProvider('hermes')).toBe('hermes');
    expect(normalizeCortextOSProvider('future-runtime')).toBe('unknown');
  });

  it('discovers configured agents and maps live daemon health without leaking daemon shapes', async () => {
    addAgent('research', 'researcher', { runtime: 'claude-code' }, 'Research');
    addAgent('engineering', 'coder', { runtime: 'codex-app-server', enabled: false });
    addAgent('engineering', 'forge', { runtime: 'opencode' });
    addAgent('operations', 'analyst', { runtime: 'hermes' });
    writeHeartbeat('researcher', { last_heartbeat: '2026-02-03T04:00:00.000Z' });

    const subject: AgentRuntimeAdapter = adapter({
      success: true,
      data: [
        { name: 'researcher', status: 'running', pid: 1001, uptime: 50, model: 'private-core-shape' },
        { name: 'coder', status: 'stopped' },
        { name: 'forge', status: 'starting' },
        { name: 'analyst', status: 'halted', crashCount: 8 },
      ],
    });

    const agents = await subject.listAgents();
    expect(agents.map(agent => [agent.id, agent.provider, agent.health.state])).toEqual([
      ['engineering/coder', 'codex', 'stopped'],
      ['engineering/forge', 'opencode', 'starting'],
      ['operations/analyst', 'hermes', 'degraded'],
      ['research/researcher', 'claude', 'running'],
    ]);
    expect(agents.find(agent => agent.name === 'researcher')).toMatchObject({
      displayName: 'Research',
      capabilities: ['session-resume'],
      health: { pid: 1001, lastHeartbeat: '2026-02-03T04:00:00.000Z' },
    });
    expect(agents.find(agent => agent.name === 'coder')?.capabilities)
      .toEqual(['session-resume', 'exact-turn-correlation']);
    expect(agents.find(agent => agent.name === 'forge')?.capabilities)
      .toEqual(['session-resume']);
    expect(agents.find(agent => agent.name === 'analyst')?.capabilities)
      .toEqual(['session-resume']);
    expect(JSON.stringify(agents)).not.toContain('private-core-shape');
    expect(JSON.stringify(agents)).not.toContain('crashCount');
    expect(await subject.getHealth()).toEqual({
      state: 'available',
      observedAt: OBSERVED_AT,
      agentCount: 4,
    });
  });

  it('falls back to configured inventory and heartbeat metadata when the daemon is unavailable', async () => {
    addAgent('research', 'researcher', { runtime: 'claude-code' });
    writeHeartbeat('researcher', { timestamp: '2026-02-03T03:00:00.000Z' });

    const subject = adapter({ success: false, error: 'CortextOS daemon is not running' });
    expect(await subject.listAgents()).toEqual([
      expect.objectContaining({
        id: 'research/researcher',
        provider: 'claude',
        health: {
          state: 'unknown',
          lastHeartbeat: '2026-02-03T03:00:00.000Z',
          reason: 'Live daemon status is unavailable',
        },
      }),
    ]);
    expect(await subject.getHealth()).toEqual({
      state: 'degraded',
      observedAt: OBSERVED_AT,
      agentCount: 1,
      reason: 'CortextOS daemon is not running',
    });
  });

  it('handles malformed config, heartbeat, and daemon records without crashing', async () => {
    const agentRoot = join(frameworkRoot, 'orgs', 'operations', 'agents', 'broken');
    mkdirSync(agentRoot, { recursive: true });
    writeFileSync(join(agentRoot, 'config.json'), '{ definitely not json');
    writeHeartbeat('broken', 'not-json');

    const subject = adapter({
      success: true,
      data: [
        { name: 'broken', status: 'running', pid: 500 },
        { status: 'running' },
      ],
    });
    const [agent] = await subject.listAgents();
    expect(agent).toMatchObject({
      id: 'operations/broken',
      provider: 'unknown',
      enabled: null,
      configured: true,
      capabilities: [],
      health: { state: 'degraded', pid: 500 },
    });
    expect(agent.health.reason).toContain('Malformed config.json');
    expect(agent.health.reason).toContain('Malformed heartbeat.json');
    expect((await subject.getHealth()).state).toBe('degraded');
  });

  it('surfaces live agents with no readable configuration as explicitly incomplete', async () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({
      remote: { org: 'operations', enabled: true },
    }));
    const subject = adapter({
      success: true,
      data: [{ name: 'remote', status: 'running', pid: 700 }],
    });
    expect(await subject.getAgent('operations/remote')).toMatchObject({
      provider: 'unknown',
      configured: false,
      health: {
        state: 'running',
        pid: 700,
        reason: 'Daemon reported an agent with no matching readable configuration',
      },
    });
  });

  it('treats a malformed successful IPC response as degraded observability', async () => {
    addAgent('research', 'researcher', {});
    const subject = adapter({ success: true, data: { not: 'an array' } });
    expect((await subject.listAgents())[0].health.state).toBe('unknown');
    expect(await subject.getHealth()).toMatchObject({
      state: 'degraded',
      reason: 'Daemon status response did not contain an agent array',
    });
  });
});
