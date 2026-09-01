import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAgentRuntimeAdapter } from '../../agent-operations-contracts/src/index.js';
import { CortextOSExecutionObserver } from '../src/index.js';

const TIME = '2026-08-21T20:00:00.000Z';
const REQUEST = {
  dispatchId: 'dispatch:one',
  attemptId: 'attempt:one',
  runtimeAgentId: 'engineering/coder',
  acceptedAt: '2026-08-21T19:59:00.000Z',
};
const EXACT_REFERENCE = 'cortextos:codex-turn:v1:thread-1:turn-1';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ao-cortextos-observer-'));
  directories.push(directory);
  return directory;
}

function runtime(
  state: 'running' | 'degraded' | 'stopped' = 'running',
  provider: 'claude' | 'codex' | 'opencode' | 'hermes' = 'codex',
  reason?: string,
) {
  return new FakeAgentRuntimeAdapter([{
    id: REQUEST.runtimeAgentId,
    name: 'coder',
    organization: 'engineering',
    provider,
    enabled: true,
    configured: true,
    capabilities: [],
    health: { state, ...(reason ? { reason } : {}) },
    observedAt: TIME,
  }]);
}

function writeTurnRecord(
  ctxRoot: string,
  threadId: string,
  turnId: string,
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted',
  executionEvidence = false,
  resultText?: string,
): void {
  const directory = join(ctxRoot, 'state', 'coder', 'codex-turns', threadId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${turnId}.json`), JSON.stringify({
    version: 1,
    provider: 'codex',
    threadId,
    turnId,
    status,
    observedAt: TIME,
    startedAt: TIME,
    ...(status === 'inProgress' ? {} : { completedAt: TIME }),
    ...(status === 'failed' ? { error: 'fixture failure' } : {}),
    ...(resultText ? { resultText } : {}),
    ...(executionEvidence
      ? {
          workingDirectory: '/tmp/agent-operations',
          effectivePolicy: {
            version: 1,
            filesystem: 'read-only',
            network: 'deny',
            environment: 'empty',
          },
        }
      : {}),
  }));
}

describe('CortextOSExecutionObserver', () => {
  it('reports daemon running state only as agent-level evidence', async () => {
    const observer = new CortextOSExecutionObserver({ runtimeAdapter: runtime(), ctxRoot: root() });
    expect(await observer.observe(REQUEST)).toEqual([{
      source: 'cortextos-daemon-status',
      sourceEventId: 'status:engineering/coder:running:',
      kind: 'runtime-running',
      correlation: 'agent-level',
      observedAt: TIME,
      message: 'CortextOS runtime is running; this is not Dispatch completion evidence.',
    }]);
  });

  it('reports post-acceptance Claude/Codex idle flags as agent-level, never exact', async () => {
    const ctxRoot = root();
    const stateDir = join(ctxRoot, 'state', 'coder');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'last_idle.flag'), String(Date.parse(TIME) / 1000));
    const observer = new CortextOSExecutionObserver({ runtimeAdapter: runtime(), ctxRoot });
    const observations = await observer.observe(REQUEST);
    expect(observations).toHaveLength(2);
    expect(observations[1]).toMatchObject({
      kind: 'runtime-idle',
      correlation: 'agent-level',
      observedAt: TIME,
    });
    expect(observations.some(item => item.correlation === 'exact')).toBe(false);
  });

  it('maps explicit crashed/halted daemon evidence without resolving an outcome', async () => {
    const observer = new CortextOSExecutionObserver({
      runtimeAdapter: runtime('degraded', 'claude', 'CortextOS reported a crashed runtime'),
      ctxRoot: root(),
    });
    expect(await observer.observe(REQUEST)).toEqual([expect.objectContaining({
      kind: 'runtime-crashed',
      correlation: 'agent-level',
    })]);
  });

  it('reports unavailable observation transport as uncorrelated ambiguity', async () => {
    const observer = new CortextOSExecutionObserver({
      runtimeAdapter: {
        listAgents: async () => [],
        getAgent: async () => { throw new Error('daemon unavailable'); },
        getHealth: async () => ({
          state: 'unavailable' as const,
          observedAt: TIME,
          agentCount: 0,
        }),
      },
      ctxRoot: root(),
      now: () => new Date(TIME),
    });
    expect(await observer.observe(REQUEST)).toEqual([expect.objectContaining({
      kind: 'runtime-unavailable',
      correlation: 'uncorrelated',
      observedAt: TIME,
    })]);
  });

  it('does not invent idle completion for OpenCode or Hermes', async () => {
    const ctxRoot = root();
    const stateDir = join(ctxRoot, 'state', 'coder');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'last_idle.flag'), String(Date.parse(TIME) / 1000));
    for (const provider of ['opencode', 'hermes'] as const) {
      const observer = new CortextOSExecutionObserver({
        runtimeAdapter: runtime('running', provider),
        ctxRoot,
      });
      expect(await observer.observe(REQUEST)).toHaveLength(1);
    }
  });

  it('emits exact evidence only for the stored matching thread and turn', async () => {
    const ctxRoot = root();
    writeTurnRecord(ctxRoot, 'thread-1', 'turn-1', 'completed', true, 'bounded final result');
    const observer = new CortextOSExecutionObserver({ runtimeAdapter: runtime(), ctxRoot });
    const observations = await observer.observe({ ...REQUEST, externalReference: EXACT_REFERENCE });
    expect(observations.at(-1)).toMatchObject({
      source: 'cortextos-codex-turn-record',
      kind: 'turn-completed',
      correlation: 'exact',
      correlatedDispatchId: REQUEST.dispatchId,
      runtimeSessionId: 'thread-1',
      externalReference: EXACT_REFERENCE,
      executionContext: { workingDirectory: '/tmp/agent-operations' },
      effectivePolicy: {
        version: 1,
        filesystem: 'read-only',
        network: 'deny',
        environment: 'empty',
      },
      resultText: 'bounded final result',
    });
  });

  it('preserves bounded Input operations and exact Input allowlist evidence', async () => {
    const ctxRoot = root();
    const directory = join(ctxRoot, 'state', 'coder', 'codex-turns', 'thread-1');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'turn-1.json'), JSON.stringify({
      version: 1, provider: 'codex', threadId: 'thread-1', turnId: 'turn-1',
      status: 'completed', observedAt: TIME, completedAt: TIME,
      workingDirectory: '/tmp/agent-operations', inputIds: ['input:attached'],
      effectivePolicy: { version: 1, filesystem: 'read-only', network: 'deny', environment: 'empty' },
      effectiveCapabilities: { version: 1, repositoryRead: false, inputRead: true },
      toolOperations: [{
        namespace: 'inputs', operation: 'read', success: true, occurredAt: TIME,
        inputId: 'input:attached', offset: 0, requestedLength: 64,
        returnedLength: 64, endOfInput: false, byteSize: 128, sha256: 'a'.repeat(64),
      }],
      resultText: 'bounded final result',
    }));
    const observer = new CortextOSExecutionObserver({ runtimeAdapter: runtime(), ctxRoot });

    const observation = (await observer.observe({ ...REQUEST, externalReference: EXACT_REFERENCE })).at(-1);

    expect(observation).toMatchObject({
      correlation: 'exact',
      executionContext: { inputIds: ['input:attached'] },
      effectiveCapabilities: { inputRead: true },
      toolOperations: [{
        namespace: 'inputs', operation: 'read', inputId: 'input:attached', returnedLength: 64,
      }],
    });
    expect(JSON.stringify(observation)).not.toContain('storageReference');
  });

  it.each([
    ['inProgress', 'runtime-running'],
    ['failed', 'runtime-crashed'],
    ['interrupted', 'runtime-crashed'],
  ] as const)('maps exact Codex status %s to %s without deciding an outcome', async (status, kind) => {
    const ctxRoot = root();
    writeTurnRecord(ctxRoot, 'thread-1', 'turn-1', status);
    const observer = new CortextOSExecutionObserver({ runtimeAdapter: runtime(), ctxRoot });
    expect((await observer.observe({ ...REQUEST, externalReference: EXACT_REFERENCE })).at(-1))
      .toMatchObject({ kind, correlation: 'exact' });
  });

  it('does not match older, newer, wrong-thread, or wrong-turn records', async () => {
    const ctxRoot = root();
    writeTurnRecord(ctxRoot, 'thread-1', 'turn-old', 'completed');
    writeTurnRecord(ctxRoot, 'thread-1', 'turn-new', 'completed');
    writeTurnRecord(ctxRoot, 'thread-other', 'turn-1', 'completed');
    const observer = new CortextOSExecutionObserver({ runtimeAdapter: runtime(), ctxRoot });
    const observations = await observer.observe({ ...REQUEST, externalReference: EXACT_REFERENCE });
    expect(observations.some(item => item.kind === 'turn-completed')).toBe(false);
    expect(observations.at(-1)).toMatchObject({ kind: 'unknown', correlation: 'uncorrelated' });
  });

  it('fails closed on a malformed reference or mismatched structured record', async () => {
    const ctxRoot = root();
    writeTurnRecord(ctxRoot, 'thread-1', 'turn-1', 'completed');
    const recordPath = join(ctxRoot, 'state', 'coder', 'codex-turns', 'thread-1', 'turn-1.json');
    writeFileSync(recordPath, JSON.stringify({
      version: 1,
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'different-turn',
      status: 'completed',
      observedAt: TIME,
    }));
    const observer = new CortextOSExecutionObserver({ runtimeAdapter: runtime(), ctxRoot });
    expect((await observer.observe({ ...REQUEST, externalReference: EXACT_REFERENCE })).at(-1))
      .toMatchObject({ kind: 'unknown', correlation: 'uncorrelated' });
    expect((await observer.observe({ ...REQUEST, externalReference: 'not-a-codex-reference' })).at(-1))
      .toMatchObject({ kind: 'unknown', correlation: 'uncorrelated' });
  });
});
