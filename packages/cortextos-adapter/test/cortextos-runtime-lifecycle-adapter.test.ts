import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeAdapter,
  AgentRuntimeDetail,
  AgentRuntimeSummary,
  RuntimeInventoryHealth,
} from '../../agent-operations-contracts/src/index.js';
import {
  CortextOSRuntimeLifecycleAdapter,
  resolveCodexExecutable,
} from '../src/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class MutableRuntime implements AgentRuntimeAdapter {
  ready = false;

  async listAgents(): Promise<readonly AgentRuntimeSummary[]> {
    return [this.agent()];
  }

  async getAgent(): Promise<AgentRuntimeDetail | null> {
    return { ...this.agent(), observedAt: '2026-08-28T00:00:00.000Z' };
  }

  async getHealth(): Promise<RuntimeInventoryHealth> {
    return {
      state: this.ready ? 'available' : 'unavailable',
      observedAt: '2026-08-28T00:00:00.000Z',
      agentCount: 1,
    };
  }

  private agent(): AgentRuntimeSummary {
    return {
      id: 'agent-operations/rehearsal',
      name: 'rehearsal',
      organization: 'agent-operations',
      provider: 'codex',
      enabled: true,
      configured: true,
      capabilities: ['exact-turn-correlation'],
      health: { state: this.ready ? 'running' : 'unknown', ...(this.ready ? { pid: 77 } : {}) },
    };
  }
}

class FakeChild extends EventEmitter {
  readonly pid = 44;
  exitCode: number | null = null;
  unrefCalls = 0;
  unref(): void { this.unrefCalls += 1; }
}

describe('CortextOSRuntimeLifecycleAdapter', () => {
  it('returns already running without spawning another canonical startup', async () => {
    const fixture = setup();
    fixture.runtime.ready = true;
    const spawnProcess = vi.fn();
    const adapter = new CortextOSRuntimeLifecycleAdapter({
      ...fixture.options,
      runtime: fixture.runtime,
      spawnProcess,
    });

    await expect(adapter.start()).resolves.toMatchObject({ status: 'already-running' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('fails immediately when no configured or known Codex executable exists', async () => {
    const fixture = setup(false);
    const spawnProcess = vi.fn();
    const adapter = new CortextOSRuntimeLifecycleAdapter({
      ...fixture.options,
      runtime: fixture.runtime,
      environment: { PATH: '' },
      codexCandidates: [],
      spawnProcess,
    });

    await expect(adapter.start()).resolves.toMatchObject({
      status: 'failed',
      message: 'Codex executable was not found.',
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('coalesces concurrent clicks into one canonical foreground startup and waits for readiness', async () => {
    const fixture = setup();
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child);
    const adapter = new CortextOSRuntimeLifecycleAdapter({
      ...fixture.options,
      runtime: fixture.runtime,
      spawnProcess,
      readinessIntervalMs: 0,
      sleep: async () => { fixture.runtime.ready = true; },
    });

    const [first, second] = await Promise.all([adapter.start(), adapter.start()]);

    expect(first).toMatchObject({ status: 'started', daemonPid: 44 });
    expect(second).toEqual(first);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [join(fixture.root, 'dist', 'cli.js'), 'start', '--foreground', '--instance', 'default'],
      expect.objectContaining({ cwd: fixture.root }),
    );
    expect(child.unrefCalls).toBe(1);
  });

  it('returns a bounded redacted early exit diagnostic without retrying', async () => {
    const fixture = setup();
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
      return child;
    });
    const adapter = new CortextOSRuntimeLifecycleAdapter({
      ...fixture.options,
      runtime: fixture.runtime,
      spawnProcess,
      readinessIntervalMs: 0,
      readinessTimeoutMs: 20,
      sleep: async () => undefined,
    });

    const result = await adapter.start();
    const fakeCredential = ['123456789', 'fixture-token-value-never-used'].join(':');

    expect(result).toMatchObject({ status: 'failed', message: 'Runtime failed before readiness.' });
    expect(result.diagnostic).toContain('code 1');
    expect(result.diagnostic).not.toContain(fakeCredential);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });
});

describe('resolveCodexExecutable', () => {
  it('prefers an explicit executable absolute path', () => {
    const fixture = setup();
    expect(resolveCodexExecutable({ AO_CODEX_EXECUTABLE: fixture.codex, PATH: '' }, []))
      .toBe(realpathSync(fixture.codex));
  });
});

function setup(withCodex = true): {
  root: string;
  codex: string;
  runtime: MutableRuntime;
  options: {
    instanceId: string;
    frameworkRoot: string;
    ctxRoot: string;
    environment: NodeJS.ProcessEnv;
    codexCandidates: readonly string[];
    isProcessAlive: (pid: number) => boolean;
  };
} {
  const root = mkdtempSync(join(tmpdir(), 'ao-runtime-lifecycle-'));
  roots.push(root);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cli.js'), 'fixture');
  const codex = join(root, 'codex');
  if (withCodex) {
    writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chmodSync(codex, 0o755);
  }
  return {
    root,
    codex,
    runtime: new MutableRuntime(),
    options: {
      instanceId: 'default',
      frameworkRoot: root,
      ctxRoot: join(root, 'state'),
      environment: { PATH: '', AO_CODEX_EXECUTABLE: withCodex ? codex : '' },
      codexCandidates: [],
      isProcessAlive: () => false,
    },
  };
}
