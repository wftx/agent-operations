import { describe, expect, it } from 'vitest';
import type {
  DurableAttemptOutcomeDecision,
  RuntimeExecutionObservation,
} from '../../agent-operations-contracts/src/index.js';
import {
  FakeRuntimeExecutionObservationAdapter,
  InMemoryAgentOperationsStateStore,
  createExecutionDispatchIdempotencyKey,
} from '../../agent-operations-contracts/src/index.js';
import {
  ExecutionObservationService,
  ExecutionOutcomeService,
  ExecutionPlanningService,
  JobLifecycleService,
} from '../src/index.js';

const TIME = '2026-08-21T20:00:00.000Z';
const PROJECT_ID = 'agent-operations';
const RUNTIME_ID = 'engineering/coder';

async function harness(fixtures: readonly RuntimeExecutionObservation[] = []) {
  const store = new InMemoryAgentOperationsStateStore();
  await store.applyProjectConfiguration({
    project: { id: PROJECT_ID, name: 'Agent Operations', createdAt: TIME, updatedAt: TIME },
    repositories: [],
    checkoutBindings: [],
    runtimeAgentIds: [RUNTIME_ID],
  });
  const lifecycle = new JobLifecycleService(store, {
    now: () => new Date(TIME),
    jobIdFactory: () => 'job:observation',
    attemptIdFactory: () => 'attempt:observation',
  });
  const job = await lifecycle.createJob({
    projectId: PROJECT_ID,
    title: 'Observe one accepted execution',
    preferredRuntimeAgentId: RUNTIME_ID,
  });
  await lifecycle.markJobReady(job.id);
  const attempt = await lifecycle.createAttempt(job.id);
  const plan = await new ExecutionPlanningService(store, {
    now: () => new Date(TIME),
    planIdFactory: () => 'plan:observation',
  }).prepareExecutionPlan({
    projectId: PROJECT_ID,
    attemptId: attempt.id,
    instruction: 'Produce bounded completion evidence.',
    requestedPolicy: { version: 1, filesystem: 'read-only', network: 'deny', environment: 'empty' },
  });
  const prepared = {
    id: 'dispatch:observation',
    executionPlanId: plan.id,
    attemptId: attempt.id,
    jobId: job.id,
    runtimeAgentId: RUNTIME_ID,
    idempotencyKey: createExecutionDispatchIdempotencyKey(plan.id),
    status: 'prepared' as const,
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  };
  await store.createExecutionDispatch(prepared);
  const submitting = {
    ...prepared,
    status: 'submitting' as const,
    submittedAt: TIME,
    revision: 1,
  };
  await store.saveExecutionDispatchTransition(submitting, 0);
  const accepted = {
    ...submitting,
    status: 'accepted' as const,
    acceptedAt: TIME,
    resolvedAt: TIME,
    revision: 2,
    effectivePolicy: plan.requestedPolicy,
    effectiveCapabilities: plan.requestedCapabilities,
  };
  await store.saveExecutionDispatchTransition(accepted, 1);
  await lifecycle.startAttempt(attempt.id);
  const adapter = new FakeRuntimeExecutionObservationAdapter(fixtures);
  const observations = new ExecutionObservationService(store, adapter, () => new Date(TIME));
  const outcomes = new ExecutionOutcomeService(store, observations, {
    now: () => new Date(TIME),
    decisionIdFactory: () => 'outcome:observation',
  });
  return { store, lifecycle, job, attempt, plan, dispatch: accepted, adapter, observations, outcomes };
}

function exact(dispatchId = 'dispatch:observation'): RuntimeExecutionObservation {
  return {
    source: 'fake-codex',
    sourceEventId: 'turn:one',
    kind: 'turn-completed',
    correlation: 'exact',
    correlatedDispatchId: dispatchId,
    runtimeSessionId: 'thread:one',
    externalReference: 'turn:one',
    outputSummary: 'The runtime produced a bounded response.',
    observedAt: TIME,
  };
}

function idle(correlation: 'runtime-session' | 'agent-level' = 'agent-level'):
RuntimeExecutionObservation {
  return {
    source: 'fake-runtime',
    sourceEventId: `idle:${correlation}`,
    kind: 'runtime-idle',
    correlation,
    ...(correlation === 'runtime-session' ? { runtimeSessionId: 'session:one' } : {}),
    observedAt: TIME,
    message: 'Persistent agent became idle.',
  };
}

describe('ExecutionObservationService', () => {
  it('persists exact correlated turn completion without completing the Attempt', async () => {
    const setup = await harness([exact()]);
    const result = await setup.observations.observeAttemptExecution(setup.attempt.id);
    expect(result).toMatchObject({ inserted: 1, duplicates: 0, ignoredUnrelated: 0 });
    expect(result.detail).toMatchObject({
      state: 'completion-evidence',
      exactCompletionEvidence: true,
      outcome: 'awaiting-confirmation',
      attempt: { status: 'running' },
    });
    expect(result.detail.observations[0]).toMatchObject({
      dispatchId: setup.dispatch.id,
      correlation: 'exact',
      outputSummary: 'The runtime produced a bounded response.',
    });
  });

  it('bounds oversized historical tool output and records truncation', async () => {
    const setup = await harness([{
      ...exact(),
      toolOperations: [{
        namespace: 'test',
        operation: 'run',
        success: false,
        occurredAt: TIME,
        commandId: 'agent-operations-tests',
        stderr: 'x'.repeat(10_000),
      }],
    }]);

    const result = await setup.observations.observeAttemptExecution(setup.attempt.id);

    expect(result.detail.observations[0].toolOperations).toEqual([
      expect.objectContaining({ outputTruncated: true, stderr: 'x'.repeat(4_000) }),
    ]);
  });

  it('ignores an exact event for another Dispatch', async () => {
    const setup = await harness([exact('dispatch:unrelated')]);
    const result = await setup.observations.observeAttemptExecution(setup.attempt.id);
    expect(result).toMatchObject({ inserted: 0, duplicates: 0, ignoredUnrelated: 1 });
    expect(result.detail.observations).toEqual([]);
    expect(result.detail.exactCompletionEvidence).toBe(false);
  });

  it('keeps session and agent idle evidence weak and unresolved', async () => {
    const setup = await harness([idle('runtime-session'), idle('agent-level')]);
    const result = await setup.observations.observeAttemptExecution(setup.attempt.id);
    expect(result.detail).toMatchObject({
      state: 'still-running',
      exactCompletionEvidence: false,
      attempt: { status: 'running' },
    });
    expect(result.detail.observations.map(item => item.correlation))
      .toEqual(['agent-level', 'runtime-session']);
  });

  it('keeps running and output-available evidence below completion readiness', async () => {
    const setup = await harness([{
      source: 'fake-runtime',
      sourceEventId: 'running:one',
      kind: 'runtime-running',
      correlation: 'agent-level',
      observedAt: TIME,
    }, {
      source: 'fake-runtime',
      sourceEventId: 'output:one',
      kind: 'output-available',
      correlation: 'runtime-session',
      runtimeSessionId: 'session:one',
      outputSummary: 'Uncorrelated output exists.',
      observedAt: TIME,
    }]);
    const result = await setup.observations.observeAttemptExecution(setup.attempt.id);
    expect(result.detail).toMatchObject({
      state: 'still-running',
      exactCompletionEvidence: false,
      outcome: 'awaiting-confirmation',
      attempt: { status: 'running' },
    });
    expect(result.detail.observations.map(item => item.kind).sort())
      .toEqual(['output-available', 'runtime-running']);
  });

  it('models unavailable and unknown evidence as ambiguous without resolving an outcome', async () => {
    const setup = await harness([{
      source: 'fake-runtime',
      sourceEventId: 'unavailable:one',
      kind: 'runtime-unavailable',
      correlation: 'uncorrelated',
      observedAt: TIME,
    }, {
      source: 'fake-runtime',
      sourceEventId: 'unknown:one',
      kind: 'unknown',
      correlation: 'uncorrelated',
      observedAt: TIME,
    }]);
    const result = await setup.observations.observeAttemptExecution(setup.attempt.id);
    expect(result.detail).toMatchObject({
      state: 'ambiguous',
      exactCompletionEvidence: false,
      outcome: 'awaiting-confirmation',
      attempt: { status: 'running' },
    });
  });

  it('deduplicates a repeated external observation', async () => {
    const setup = await harness([exact()]);
    expect(await setup.observations.observeAttemptExecution(setup.attempt.id))
      .toMatchObject({ inserted: 1, duplicates: 0 });
    expect(await setup.observations.observeAttemptExecution(setup.attempt.id))
      .toMatchObject({ inserted: 0, duplicates: 1 });
    expect((await setup.observations.getAttemptExecutionDetail(setup.attempt.id)).observations)
      .toHaveLength(1);
  });

  it('fails closed on malformed observer output', async () => {
    const setup = await harness([{
      ...exact(),
      correlatedDispatchId: undefined,
    }]);
    await expect(setup.observations.observeAttemptExecution(setup.attempt.id))
      .rejects.toThrow('did not identify a Dispatch');
    expect(await setup.store.listExecutionObservationsForDispatch(setup.dispatch.id)).toEqual([]);
  });

  it('requires correlation to remain explicit', async () => {
    const malformed = {
      source: 'fake-runtime',
      sourceEventId: 'missing-correlation',
      kind: 'output-available',
      observedAt: TIME,
    } as unknown as RuntimeExecutionObservation;
    const setup = await harness([malformed]);
    await expect(setup.observations.observeAttemptExecution(setup.attempt.id))
      .rejects.toThrow('unsupported correlation');
    expect(await setup.store.listExecutionObservationsForDispatch(setup.dispatch.id)).toEqual([]);
  });

  it('distinguishes crash, unavailable, and ambiguous evidence without lifecycle mutation', async () => {
    const setup = await harness([{
      source: 'fake-runtime',
      sourceEventId: 'crash:one',
      kind: 'runtime-crashed',
      correlation: 'agent-level',
      observedAt: TIME,
    }]);
    let result = await setup.observations.observeAttemptExecution(setup.attempt.id);
    expect(result.detail.state).toBe('runtime-failure-evidence');
    expect(result.detail.attempt.status).toBe('running');
    setup.adapter.setObservations([{
      source: 'fake-runtime',
      sourceEventId: 'unavailable:one',
      kind: 'runtime-unavailable',
      correlation: 'uncorrelated',
      observedAt: TIME,
    }]);
    result = await setup.observations.observeAttemptExecution(setup.attempt.id);
    expect(result.detail.state).toBe('runtime-failure-evidence');
    expect(result.detail.outcome).toBe('awaiting-confirmation');
  });
});

describe('ExecutionOutcomeService', () => {
  it('human-confirms success after exact evidence, persists authority, and leaves Job ready', async () => {
    const setup = await harness([exact()]);
    await setup.observations.observeAttemptExecution(setup.attempt.id);
    const result = await setup.outcomes.confirmAttemptSucceeded(setup.attempt.id, {
      summary: 'Human verified the desired execution result.',
    });
    expect(result).toMatchObject({
      state: 'resolved',
      outcome: 'completed',
      attempt: { status: 'completed', summary: 'Human verified the desired execution result.' },
      job: { status: 'ready' },
      dispatch: { status: 'accepted' },
      outcomeDecision: {
        source: 'human',
        outcome: 'completed',
        overrideWithoutExactCompletionEvidence: false,
      },
    });
    const repeated = await setup.outcomes.confirmAttemptSucceeded(setup.attempt.id, {
      summary: 'Human verified the desired execution result.',
    });
    expect(repeated.attempt.revision).toBe(result.attempt.revision);
    const nextLifecycle = new JobLifecycleService(setup.store, {
      now: () => new Date(TIME),
      attemptIdFactory: () => 'attempt:second',
    });
    await expect(nextLifecycle.createAttempt(setup.job.id, { runtimeAgentId: RUNTIME_ID }))
      .resolves.toMatchObject({ sequence: 2, status: 'created' });
  });

  it('requires exact completion evidence or a deliberate success override', async () => {
    const setup = await harness([idle()]);
    await setup.observations.observeAttemptExecution(setup.attempt.id);
    await expect(setup.outcomes.confirmAttemptSucceeded(setup.attempt.id, { summary: ' ' }))
      .rejects.toThrow('summary is required');
    await expect(setup.outcomes.confirmAttemptSucceeded(setup.attempt.id, { summary: 'Reviewed.' }))
      .rejects.toThrow('exact turn-completion evidence');
    const result = await setup.outcomes.confirmAttemptSucceeded(setup.attempt.id, {
      summary: 'Human independently verified completion.',
      overrideWithoutExactCompletionEvidence: true,
    });
    expect(result.outcomeDecision?.overrideWithoutExactCompletionEvidence).toBe(true);
    expect(result.attempt.status).toBe('completed');
  });

  it('human-confirms failure from crash evidence without failing the Job or retrying', async () => {
    const setup = await harness([{
      source: 'fake-runtime',
      sourceEventId: 'crash:one',
      kind: 'runtime-crashed',
      correlation: 'agent-level',
      observedAt: TIME,
    }]);
    const observed = await setup.observations.observeAttemptExecution(setup.attempt.id);
    await expect(setup.outcomes.confirmAttemptFailed(setup.attempt.id, { reason: ' ' }))
      .rejects.toThrow('reason is required');
    const result = await setup.outcomes.confirmAttemptFailed(setup.attempt.id, {
      reason: 'Operator confirmed the runtime crash ended this effort.',
      evidenceObservationId: observed.detail.observations[0].id,
    });
    expect(result).toMatchObject({
      outcome: 'failed',
      attempt: { status: 'failed' },
      job: { status: 'ready' },
      dispatch: { status: 'accepted' },
      outcomeDecision: { source: 'human', outcome: 'failed' },
    });
    const repeated = await setup.outcomes.confirmAttemptFailed(setup.attempt.id, {
      reason: 'Operator confirmed the runtime crash ended this effort.',
      evidenceObservationId: observed.detail.observations[0].id,
    });
    expect(repeated.attempt.revision).toBe(result.attempt.revision);
    await expect(setup.outcomes.confirmAttemptSucceeded(setup.attempt.id, {
      summary: 'Conflicting decision.',
      overrideWithoutExactCompletionEvidence: true,
    })).rejects.toThrow('different Outcome Decision');
  });

  it('reconciles a persisted human decision without creating another decision', async () => {
    const setup = await harness([exact()]);
    await setup.observations.observeAttemptExecution(setup.attempt.id);
    const decision: DurableAttemptOutcomeDecision = {
      id: 'outcome:observation',
      attemptId: setup.attempt.id,
      dispatchId: setup.dispatch.id,
      outcome: 'completed',
      source: 'human',
      summary: 'Persisted before local lifecycle transition.',
      evidenceObservationId: (await setup.store.listExecutionObservationsForDispatch(setup.dispatch.id))[0].id,
      overrideWithoutExactCompletionEvidence: false,
      createdAt: TIME,
    };
    await setup.store.createAttemptOutcomeDecision(decision);
    const result = await setup.outcomes.confirmAttemptSucceeded(setup.attempt.id, {
      summary: 'Persisted before local lifecycle transition.',
    });
    expect(result.attempt.status).toBe('completed');
    expect(result.outcomeDecision).toEqual(decision);
  });
});
