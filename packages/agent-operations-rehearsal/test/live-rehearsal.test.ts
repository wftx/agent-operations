import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentRuntimeDetail,
  RuntimeDispatchResult,
} from '../../agent-operations-contracts/src/index.js';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  FakeRuntimeExecutionAdapter,
  FakeRuntimeExecutionObservationAdapter,
  InMemoryAgentOperationsStateStore,
} from '../../agent-operations-contracts/src/index.js';
import {
  LIVE_REHEARSAL_CONFIRMATION,
  LIVE_REHEARSAL_PROJECT_ID,
  CortextOSRehearsalSafetyInspector,
  LiveRehearsalOperations,
  createLiveRehearsalInstruction,
  runLiveRehearsalExecution,
  type LiveRehearsalCandidate,
  type RuntimeCandidateSafetyInspector,
} from '../src/index.js';

const TIME = '2026-08-22T05:00:00.000Z';
const RUNTIME_ID = 'rehearsal/safe-agent';
const NONCE = 'PHASE11NONCE0001';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runtime(state: 'running' | 'stopped' | 'degraded' = 'running'): AgentRuntimeDetail {
  return {
    id: RUNTIME_ID,
    name: 'safe-agent',
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
    health: { state },
    observedAt: TIME,
  };
}

const safeInspector: RuntimeCandidateSafetyInspector = {
  inspect: async () => ({
    safe: true,
    reason: 'Deterministic fake runtime is idle.',
    activeWorkEvidence: [],
    integrations: [],
  }),
};

function candidate(): LiveRehearsalCandidate {
  return {
    runtime: runtime(),
    safety: {
      safe: true,
      reason: 'Deterministic fake runtime is idle.',
      activeWorkEvidence: [],
      integrations: [],
    },
  };
}

function operations(
  store: InMemoryAgentOperationsStateStore,
  execution: FakeRuntimeExecutionAdapter,
  observed = new FakeRuntimeExecutionObservationAdapter([{
    source: 'fake-runtime',
    sourceEventId: 'idle:one',
    kind: 'runtime-idle',
    correlation: 'agent-level',
    observedAt: TIME,
  }]),
  runtimeAdapter = new FakeAgentRuntimeAdapter([runtime()]),
) {
  const value = new LiveRehearsalOperations(
    store,
    runtimeAdapter,
    new FakeRepositoryInventoryAdapter([]),
    execution,
    observed,
    {
      now: () => new Date(TIME),
      jobIdFactory: () => 'job:live-rehearsal',
      attemptIdFactory: () => 'attempt:live-rehearsal',
      planIdFactory: () => 'plan:live-rehearsal',
      dispatchIdFactory: () => 'dispatch:live-rehearsal',
      outcomeDecisionIdFactory: () => 'outcome:live-rehearsal',
    },
  );
  return { value, observed };
}

async function run(
  result: RuntimeDispatchResult = { status: 'accepted', message: 'accepted by fake' },
  operationRuntime = new FakeAgentRuntimeAdapter([runtime()]),
) {
  const store = new InMemoryAgentOperationsStateStore();
  const execution = new FakeRuntimeExecutionAdapter(result);
  const built = operations(store, execution, undefined, operationRuntime);
  const controller = await runLiveRehearsalExecution({
    execute: true,
    confirmation: LIVE_REHEARSAL_CONFIRMATION,
    runtimes: new FakeAgentRuntimeAdapter([runtime()]),
    safetyInspector: safeInspector,
    operationsFactory: async () => built.value,
    nonceFactory: () => NONCE,
  });
  return { store, execution, operations: built.value, observed: built.observed, controller };
}

describe('live rehearsal execution gates', () => {
  it('defaults to preview and never creates operations or dispatches', async () => {
    let factoryCalls = 0;
    const result = await runLiveRehearsalExecution({
      execute: false,
      runtimes: new FakeAgentRuntimeAdapter([runtime()]),
      safetyInspector: safeInspector,
      operationsFactory: async () => {
        factoryCalls++;
        throw new Error('must not create operations');
      },
      nonceFactory: () => NONCE,
    });
    expect(result).toMatchObject({ status: 'preview', operationsCreated: false });
    expect(result.preview).toMatchObject({
      repository: null,
      executionAuthorized: false,
      willContactRealRuntime: false,
      requestedPolicy: {
        version: 1,
        filesystem: 'read-only',
        network: 'deny',
        environment: 'empty',
      },
      effectivePolicy: {
        version: 1,
        filesystem: 'read-only',
        network: 'deny',
        environment: 'empty',
      },
      policyEnforceable: true,
      exactTurnCorrelationSupported: true,
    });
    expect(factoryCalls).toBe(0);
  });

  it('does not dispatch when --execute is missing even with the literal confirmation', async () => {
    const result = await runLiveRehearsalExecution({
      execute: false,
      confirmation: LIVE_REHEARSAL_CONFIRMATION,
      runtimes: new FakeAgentRuntimeAdapter([runtime()]),
      safetyInspector: safeInspector,
      operationsFactory: async () => { throw new Error('must not create operations'); },
      nonceFactory: () => NONCE,
    });
    expect(result.status).toBe('preview');
  });

  it('does not dispatch with the wrong literal confirmation', async () => {
    const result = await runLiveRehearsalExecution({
      execute: true,
      confirmation: 'WRONG',
      runtimes: new FakeAgentRuntimeAdapter([runtime()]),
      safetyInspector: safeInspector,
      operationsFactory: async () => { throw new Error('must not create operations'); },
      nonceFactory: () => NONCE,
    });
    expect(result.status).toBe('preview');
  });

  it('blocks before durable operations when no safe candidate exists', async () => {
    let factoryCalls = 0;
    const result = await runLiveRehearsalExecution({
      execute: true,
      confirmation: LIVE_REHEARSAL_CONFIRMATION,
      runtimes: new FakeAgentRuntimeAdapter([]),
      safetyInspector: safeInspector,
      operationsFactory: async () => {
        factoryCalls++;
        throw new Error('must not create operations');
      },
      nonceFactory: () => NONCE,
    });
    expect(result).toMatchObject({ status: 'blocked', operationsCreated: false });
    expect(factoryCalls).toBe(0);
  });
});

describe('CortextOS rehearsal candidate safety', () => {
  function safetyFixture(
    state: 'running' | 'stopped' | 'degraded' = 'running',
  ): { ctxRoot: string; stateDir: string; inspector: CortextOSRehearsalSafetyInspector; runtime: AgentRuntimeDetail } {
    const ctxRoot = mkdtempSync(join(tmpdir(), 'ao-rehearsal-safety-'));
    temporaryDirectories.push(ctxRoot);
    const stateDir = join(ctxRoot, 'state', 'safe-agent');
    mkdirSync(stateDir, { recursive: true });
    const inspector = new CortextOSRehearsalSafetyInspector({
      ctxRoot,
      frameworkRoot: ctxRoot,
      now: () => new Date('2026-08-22T05:00:00.000Z'),
    });
    return { ctxRoot, stateDir, inspector, runtime: runtime(state) };
  }

  it('accepts a fresh running agent with recent idle evidence and no prior injection', async () => {
    const fixture = safetyFixture();
    writeFileSync(join(fixture.stateDir, 'last_idle.flag'), '1787374560');
    expect(await fixture.inspector.inspect(fixture.runtime)).toMatchObject({
      safe: true,
      activeWorkEvidence: [],
    });
  });

  it('accepts recent idle evidence newer than the most recent injection', async () => {
    const fixture = safetyFixture();
    writeFileSync(join(fixture.stateDir, 'last_message_injected.flag'), '1787374500');
    writeFileSync(join(fixture.stateDir, 'last_idle.flag'), '1787374560');
    expect(await fixture.inspector.inspect(fixture.runtime)).toMatchObject({
      safe: true,
      activeWorkEvidence: [],
    });
  });

  it('blocks when an injection is newer than the last idle signal', async () => {
    const fixture = safetyFixture();
    writeFileSync(join(fixture.stateDir, 'last_idle.flag'), '1787374560');
    writeFileSync(join(fixture.stateDir, 'last_message_injected.flag'), '1787374700');
    const result = await fixture.inspector.inspect(fixture.runtime);
    expect(result.safe).toBe(false);
    expect(result.activeWorkEvidence).toContain('last injected message is newer than the last idle signal');
  });

  it('blocks when the inbox is nonempty', async () => {
    const fixture = safetyFixture();
    writeFileSync(join(fixture.stateDir, 'last_idle.flag'), '1787374560');
    const inbox = join(fixture.ctxRoot, 'inbox', 'safe-agent');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'pending.json'), '{}');
    expect((await fixture.inspector.inspect(fixture.runtime)).activeWorkEvidence)
      .toContain('1 pending inbox message(s)');
  });

  it('blocks when inflight work exists', async () => {
    const fixture = safetyFixture();
    writeFileSync(join(fixture.stateDir, 'last_idle.flag'), '1787374560');
    const inflight = join(fixture.ctxRoot, 'inflight', 'safe-agent');
    mkdirSync(inflight, { recursive: true });
    writeFileSync(join(inflight, 'active.json'), '{}');
    expect((await fixture.inspector.inspect(fixture.runtime)).activeWorkEvidence)
      .toContain('1 inflight message(s)');
  });

  it.each(['stopped', 'degraded'] as const)('blocks a %s runtime', async state => {
    const fixture = safetyFixture(state);
    writeFileSync(join(fixture.stateDir, 'last_idle.flag'), '1787374560');
    expect((await fixture.inspector.inspect(fixture.runtime)).activeWorkEvidence)
      .toContain(`runtime health is ${state}, not running`);
  });

  it('blocks stale idle evidence even when there has never been an injection', async () => {
    const fixture = safetyFixture();
    writeFileSync(join(fixture.stateDir, 'last_idle.flag'), '1787370000');
    const result = await fixture.inspector.inspect(fixture.runtime);
    expect(result.safe).toBe(false);
    expect(result.activeWorkEvidence).toContain('last idle signal is older than ten minutes');
  });
});

describe('live rehearsal durable orchestration', () => {
  it('prepares durable work and current preflight without invoking a Dispatch', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const execution = new FakeRuntimeExecutionAdapter({ status: 'accepted' });
    const built = operations(store, execution);
    const prepared = await built.value.prepare(candidate(), NONCE);
    expect(prepared).toMatchObject({
      projectId: LIVE_REHEARSAL_PROJECT_ID,
      job: { status: 'ready' },
      attempt: { status: 'created' },
      preflight: {
        status: 'ready',
        dispatchable: true,
      },
      nonce: NONCE,
    });
    expect(prepared.preflight.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'runtime-exact-turn-correlation-supported',
        severity: 'pass',
      }),
    ]));
    expect(execution.callCount).toBe(0);
    expect(await store.getExecutionDispatchForPlan(prepared.plan.id)).toBeNull();
  });

  it('lets current preflight block without creating or invoking a Dispatch', async () => {
    const setup = await run(
      { status: 'accepted' },
      new FakeAgentRuntimeAdapter([runtime('stopped')]),
    );
    expect(setup.controller.status).toBe('blocked');
    expect(setup.execution.callCount).toBe(0);
    expect(setup.controller.run?.dispatch).toBeNull();
  });

  it('uses the real AO chain for one accepted fake submission and leaves Attempt running', async () => {
    const setup = await run();
    expect(setup.controller).toMatchObject({
      status: 'accepted',
      operationsCreated: true,
      run: {
        projectId: LIVE_REHEARSAL_PROJECT_ID,
        job: { status: 'ready' },
        attempt: { status: 'running' },
        dispatch: { status: 'accepted' },
        dispatchOutcome: { adapterInvoked: true },
        executionDetail: {
          exactCompletionEvidence: false,
          outcome: 'awaiting-confirmation',
        },
      },
    });
    expect(setup.controller.run!.job).not.toHaveProperty('repositoryId');
    expect(setup.controller.run!.plan).not.toHaveProperty('repositoryId');
    expect(setup.controller.run!.plan).not.toHaveProperty('checkoutBindingId');
    expect(setup.execution.callCount).toBe(1);
    expect(setup.execution.requests[0]).toMatchObject({
      dispatchId: 'dispatch:live-rehearsal',
      executionPlanId: 'plan:live-rehearsal',
      runtimeAgentId: RUNTIME_ID,
      input: { instruction: createLiveRehearsalInstruction(NONCE) },
    });
    expect(setup.observed.callCount).toBe(1);
    expect(await setup.store.listProjectRepositoryIds(LIVE_REHEARSAL_PROJECT_ID)).toEqual([]);
  });

  it('repeated invocation observes the accepted run without redispatching', async () => {
    const setup = await run();
    const repeated = await setup.operations.execute(candidate(), 'DIFFERENTNONCE002');
    expect(repeated.dispatchOutcome).toMatchObject({ status: 'accepted', adapterInvoked: false });
    expect(repeated.nonce).toBe(NONCE);
    expect(setup.execution.callCount).toBe(1);
    expect(setup.observed.callCount).toBe(2);
    expect(await setup.store.listJobs(LIVE_REHEARSAL_PROJECT_ID)).toHaveLength(1);
  });

  it.each(['uncertain', 'rejected'] as const)(
    'stops on a %s adapter result without retry or Attempt start',
    async status => {
      const setup = await run({ status, message: `${status} fake result` });
      expect(setup.controller.status).toBe(status);
      expect(setup.execution.callCount).toBe(1);
      expect(setup.controller.run?.attempt.status).toBe('created');
      expect(setup.observed.callCount).toBe(0);
      const repeated = await setup.operations.execute(candidate(), NONCE);
      expect(repeated.dispatchOutcome.adapterInvoked).toBe(false);
      expect(setup.execution.callCount).toBe(1);
    },
  );

  it('uses human override for success and keeps Job completion separate', async () => {
    const setup = await run();
    const attemptId = setup.controller.run!.attempt.id;
    const jobId = setup.controller.run!.job.id;
    const completedAttempt = await setup.operations.confirmSuccess(attemptId);
    expect(completedAttempt).toMatchObject({
      attempt: { status: 'completed' },
      job: { status: 'ready' },
      outcomeDecision: {
        source: 'human',
        outcome: 'completed',
        overrideWithoutExactCompletionEvidence: true,
      },
    });
    expect((await setup.store.getJob(jobId))?.status).toBe('ready');
    expect((await setup.operations.completeJob(jobId)).status).toBe('completed');
    expect(setup.execution.callCount).toBe(1);
  });

  it('supports explicit human failure without retry or Job failure', async () => {
    const setup = await run();
    const detail = await setup.operations.confirmFailure(
      setup.controller.run!.attempt.id,
      'Human determined the harmless rehearsal did not complete.',
    );
    expect(detail).toMatchObject({
      attempt: { status: 'failed' },
      job: { status: 'ready' },
      outcomeDecision: { source: 'human', outcome: 'failed' },
    });
    expect(setup.execution.callCount).toBe(1);
  });
});
