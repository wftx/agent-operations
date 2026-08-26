import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
} from '../../agent-operations-contracts/src/index.js';
import {
  ExecutionObservationService,
  ExecutionPlanningService,
  ExecutionPreflightService,
  JobLifecycleService,
  ManualDispatchService,
} from '../../agent-operations-core/src/index.js';
import { CortextOSExecutionAdapter } from '../../cortextos-execution-adapter/src/index.js';
import { CortextOSExecutionObserver } from '../../cortextos-execution-observer/src/index.js';
import { SqliteAgentOperationsStateStore } from '../../sqlite-state-adapter/src/index.js';

const TIME = '2026-08-24T20:00:00.000Z';
const PROJECT_ID = 'agent-operations-correlation-fixture';
const RUNTIME_ID = 'rehearsal/coder';
const THREAD_ID = 'thread-fixture-1';
const TURN_ID = 'turn-fixture-1';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ao-exact-correlation-'));
  directories.push(directory);
  return directory;
}

function runtime() {
  return new FakeAgentRuntimeAdapter([{
    id: RUNTIME_ID,
    name: 'coder',
    organization: 'rehearsal',
    provider: 'codex',
    enabled: true,
    configured: true,
    capabilities: [
      'session-resume',
      'exact-turn-correlation',
      'filesystem-read-only',
      'network-denial',
      'environment-empty',
    ],
    health: { state: 'running' },
    observedAt: TIME,
  }]);
}

function open(databasePath: string) {
  return SqliteAgentOperationsStateStore.open({
    databasePath,
    installationIdFactory: () => 'installation:exact-correlation',
    now: () => new Date(TIME),
  });
}

async function prepare(store: SqliteAgentOperationsStateStore) {
  await store.applyProjectConfiguration({
    project: { id: PROJECT_ID, name: 'Exact correlation fixture', createdAt: TIME, updatedAt: TIME },
    repositories: [],
    checkoutBindings: [],
    runtimeAgentIds: [RUNTIME_ID],
  });
  const lifecycle = new JobLifecycleService(store, {
    now: () => new Date(TIME),
    jobIdFactory: () => 'job:exact-correlation',
    attemptIdFactory: () => 'attempt:exact-correlation',
  });
  const job = await lifecycle.createJob({
    projectId: PROJECT_ID,
    title: 'Deterministic exact correlation',
    preferredRuntimeAgentId: RUNTIME_ID,
  });
  await lifecycle.markJobReady(job.id);
  const attempt = await lifecycle.createAttempt(job.id);
  const plan = await new ExecutionPlanningService(store, {
    now: () => new Date(TIME),
    planIdFactory: () => 'plan:exact-correlation',
  }).prepareExecutionPlan({
    projectId: PROJECT_ID,
    attemptId: attempt.id,
    instruction: 'Return one deterministic fixture result.',
    requestedPolicy: { version: 1, filesystem: 'read-only', network: 'deny', environment: 'empty' },
  });
  return { job, attempt, plan };
}

function writeTurnRecord(ctxRoot: string, status: 'completed' | 'failed' = 'completed'): void {
  const directory = join(ctxRoot, 'state', 'coder', 'codex-turns', THREAD_ID);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${TURN_ID}.json`), JSON.stringify({
    version: 1,
    provider: 'codex',
    threadId: THREAD_ID,
    turnId: TURN_ID,
    status,
    observedAt: TIME,
    startedAt: TIME,
    completedAt: TIME,
    ...(status === 'failed' ? { error: 'deterministic fixture failure' } : {}),
  }));
}

describe('exact Codex correlation across the durable AO boundary', () => {
  it('persists acceptance, survives database reopen, and records only matching exact completion', async () => {
    const root = fixtureRoot();
    const databasePath = join(root, 'ao', 'state.db');
    const ctxRoot = join(root, 'ctx');
    let store = open(databasePath);
    const { job, attempt, plan } = await prepare(store);
    const sender = vi.fn().mockResolvedValue({
      success: true,
      data: {
        execution: {
          provider: 'codex',
          sessionId: THREAD_ID,
          turnId: TURN_ID,
          effectivePolicy: plan.requestedPolicy,
        },
      },
    });
    const dispatch = await new ManualDispatchService(
      store,
      new ExecutionPreflightService(
        store,
        runtime(),
        new FakeRepositoryInventoryAdapter([]),
        () => new Date(TIME),
      ),
      new CortextOSExecutionAdapter({ requestSender: sender }),
      { now: () => new Date(TIME), dispatchIdFactory: () => 'dispatch:exact-correlation' },
    ).dispatchExecutionPlan(plan.id);

    expect(dispatch).toMatchObject({
      status: 'accepted',
      adapterInvoked: true,
      attemptRunning: true,
      dispatch: {
        externalReference: `cortextos:codex-turn:v1:${THREAD_ID}:${TURN_ID}`,
      },
    });
    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0]?.[2]).toMatchObject({
      dispatchId: 'dispatch:exact-correlation',
      idempotencyKey: 'dispatch-plan:plan:exact-correlation',
    });

    await store.close();
    writeTurnRecord(ctxRoot);
    store = open(databasePath);
    const observations = new ExecutionObservationService(
      store,
      new CortextOSExecutionObserver({ runtimeAdapter: runtime(), ctxRoot }),
      () => new Date(TIME),
    );
    const first = await observations.observeAttemptExecution(attempt.id);
    expect(first).toMatchObject({ inserted: 2, duplicates: 0, ignoredUnrelated: 0 });
    expect(first.detail).toMatchObject({
      state: 'completion-evidence',
      exactCompletionEvidence: true,
      outcome: 'awaiting-confirmation',
      attempt: { status: 'running' },
      job: { id: job.id, status: 'ready' },
      outcomeDecision: null,
    });
    expect(first.detail.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'cortextos-codex-turn-record',
        kind: 'turn-completed',
        correlation: 'exact',
        correlatedDispatchId: 'dispatch:exact-correlation',
        runtimeSessionId: THREAD_ID,
      }),
      expect.objectContaining({
        source: 'cortextos-daemon-status',
        kind: 'runtime-running',
        correlation: 'agent-level',
      }),
    ]));

    const repeated = await observations.observeAttemptExecution(attempt.id);
    expect(repeated).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(repeated.detail.observations).toHaveLength(2);
    expect(await store.getAttempt(attempt.id)).toMatchObject({ status: 'running' });
    expect(await store.getAttemptOutcomeDecision(attempt.id)).toBeNull();
    await store.close();
  });

  it('maps an atomic busy rejection without starting the Attempt or retrying', async () => {
    const root = fixtureRoot();
    const store = open(join(root, 'ao', 'state.db'));
    const { attempt, plan } = await prepare(store);
    const sender = vi.fn().mockResolvedValue({
      success: false,
      code: 'RUNTIME_BUSY',
      error: 'The runtime already has an active turn.',
    });
    const service = new ManualDispatchService(
      store,
      new ExecutionPreflightService(
        store,
        runtime(),
        new FakeRepositoryInventoryAdapter([]),
        () => new Date(TIME),
      ),
      new CortextOSExecutionAdapter({ requestSender: sender }),
      { now: () => new Date(TIME), dispatchIdFactory: () => 'dispatch:busy' },
    );
    expect(await service.dispatchExecutionPlan(plan.id)).toMatchObject({
      status: 'rejected',
      adapterInvoked: true,
      attemptRunning: false,
    });
    expect(await service.dispatchExecutionPlan(plan.id)).toMatchObject({
      status: 'rejected',
      adapterInvoked: false,
      attemptRunning: false,
    });
    expect(sender).toHaveBeenCalledOnce();
    expect(await store.getAttempt(attempt.id)).toMatchObject({ status: 'created' });
    await store.close();
  });
});
