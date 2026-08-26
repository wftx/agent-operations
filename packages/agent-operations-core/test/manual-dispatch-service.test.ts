import { describe, expect, it } from 'vitest';
import type {
  DurableExecutionDispatch,
  DurableProjectConfiguration,
  RuntimeDispatchResult,
} from '../../agent-operations-contracts/src/index.js';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  FakeRuntimeExecutionAdapter,
  InMemoryAgentOperationsStateStore,
  createExecutionDispatchIdempotencyKey,
} from '../../agent-operations-contracts/src/index.js';
import {
  ExecutionPlanningService,
  ExecutionPreflightService,
  JobLifecycleService,
  ManualDispatchService,
} from '../src/index.js';

const TIME = '2026-08-21T15:00:00.000Z';
const PROJECT_ID = 'agent-operations';
const RUNTIME_ID = 'engineering/coder';

function configuration(): DurableProjectConfiguration {
  return {
    project: { id: PROJECT_ID, name: 'Agent Operations', createdAt: TIME, updatedAt: TIME },
    repositories: [],
    checkoutBindings: [],
    runtimeAgentIds: [RUNTIME_ID],
  };
}

function runtime(state: 'running' | 'stopped' = 'running') {
  return new FakeAgentRuntimeAdapter([{
    id: RUNTIME_ID,
    name: 'coder',
    organization: 'engineering',
    provider: 'codex',
    enabled: true,
    configured: true,
    capabilities: ['filesystem-read-only', 'network-denial', 'environment-empty'],
    health: { state },
    observedAt: TIME,
  }]);
}

async function harness(
  result: RuntimeDispatchResult = { status: 'accepted', externalReference: 'external:one' },
) {
  const store = new InMemoryAgentOperationsStateStore();
  await store.applyProjectConfiguration(configuration());
  const lifecycle = new JobLifecycleService(store, {
    now: () => new Date(TIME),
    jobIdFactory: () => 'job:manual',
    attemptIdFactory: () => 'attempt:manual',
  });
  const job = await lifecycle.createJob({
    projectId: PROJECT_ID,
    title: 'Manual runtime work',
    preferredRuntimeAgentId: RUNTIME_ID,
  });
  await lifecycle.markJobReady(job.id);
  const attempt = await lifecycle.createAttempt(job.id);
  const plan = await new ExecutionPlanningService(store, {
    now: () => new Date(TIME),
    planIdFactory: () => 'plan:manual',
  }).prepareExecutionPlan({
    projectId: PROJECT_ID,
    attemptId: attempt.id,
    instruction: 'Perform exactly one manual action.',
    requestedPolicy: { version: 1, filesystem: 'read-only', network: 'deny', environment: 'empty' },
  });
  const execution = new FakeRuntimeExecutionAdapter(result);
  const preflight = new ExecutionPreflightService(
    store,
    runtime(),
    new FakeRepositoryInventoryAdapter([]),
    () => new Date(TIME),
  );
  const service = new ManualDispatchService(store, preflight, execution, {
    now: () => new Date(TIME),
    dispatchIdFactory: () => 'dispatch:manual',
  });
  return { store, lifecycle, job, attempt, plan, execution, service };
}

function preparedDispatch(planId = 'plan:manual'): DurableExecutionDispatch {
  return {
    id: 'dispatch:manual',
    executionPlanId: planId,
    attemptId: 'attempt:manual',
    jobId: 'job:manual',
    runtimeAgentId: RUNTIME_ID,
    idempotencyKey: createExecutionDispatchIdempotencyKey(planId),
    status: 'prepared',
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  };
}

async function moveToSubmitting(
  store: InMemoryAgentOperationsStateStore,
  dispatch: DurableExecutionDispatch,
): Promise<DurableExecutionDispatch> {
  const submitting = {
    ...dispatch,
    status: 'submitting' as const,
    submittedAt: TIME,
    revision: 1,
    updatedAt: TIME,
  };
  await store.saveExecutionDispatchTransition(submitting, 0);
  return submitting;
}

describe('ManualDispatchService', () => {
  it('persists acceptance, invokes exactly once, and only then starts the Attempt', async () => {
    const { store, attempt, plan, execution, service } = await harness();
    const result = await service.dispatchExecutionPlan(plan.id);
    expect(result).toMatchObject({
      status: 'accepted',
      adapterInvoked: true,
      attemptRunning: true,
      requiresReconciliation: false,
      dispatch: {
        id: 'dispatch:manual',
        executionPlanId: plan.id,
        idempotencyKey: 'dispatch-plan:plan:manual',
        status: 'accepted',
        externalReference: 'external:one',
        effectivePolicy: plan.requestedPolicy,
        revision: 2,
      },
    });
    expect(execution.callCount).toBe(1);
    expect(execution.requests[0]).toMatchObject({
      runtimeAgentId: RUNTIME_ID,
      executionPlanId: plan.id,
      input: { version: 1, instruction: 'Perform exactly one manual action.' },
      requestedPolicy: plan.requestedPolicy,
    });
    expect(await store.getAttempt(attempt.id)).toMatchObject({ status: 'running', revision: 1 });

    const repeated = await service.dispatchExecutionPlan(plan.id);
    expect(repeated).toMatchObject({ status: 'accepted', adapterInvoked: false, attemptRunning: true });
    expect(execution.callCount).toBe(1);
  });

  it('persists explicit rejection, leaves Attempt created, and never resubmits the Plan', async () => {
    const setup = await harness({ status: 'rejected' as const, externalReference: 'external:one' });
    const result = await setup.service.dispatchExecutionPlan(setup.plan.id);
    expect(result).toMatchObject({ status: 'rejected', adapterInvoked: true, attemptRunning: false });
    expect(await setup.store.getAttempt(setup.attempt.id)).toMatchObject({ status: 'created', revision: 0 });
    expect((await setup.store.getExecutionDispatchForPlan(setup.plan.id))?.externalReference)
      .toBe('external:one');
    const repeated = await setup.service.dispatchExecutionPlan(setup.plan.id);
    expect(repeated).toMatchObject({ status: 'rejected', adapterInvoked: false });
    expect(setup.execution.callCount).toBe(1);
  });

  it('models unsupported policy, conflict, and stricter accepted enforcement without fake submission leakage', async () => {
    const unsupported = await harness();
    unsupported.execution.rejectUnsupportedPolicy();
    let result = await unsupported.service.dispatchExecutionPlan(unsupported.plan.id);
    expect(result).toMatchObject({ status: 'rejected', adapterInvoked: true, attemptRunning: false });
    expect(unsupported.execution.submissionCount).toBe(0);
    expect(await unsupported.store.getAttempt(unsupported.attempt.id)).toMatchObject({ status: 'created' });

    const conflict = await harness();
    conflict.execution.rejectPolicyConflict();
    result = await conflict.service.dispatchExecutionPlan(conflict.plan.id);
    expect(result).toMatchObject({ status: 'rejected', adapterInvoked: true, attemptRunning: false });
    expect(conflict.execution.submissionCount).toBe(0);

    const stricter = await harness();
    stricter.execution.acceptWithEffectivePolicy({
      version: 1,
      filesystem: 'none',
      network: 'deny',
      environment: 'empty',
    });
    result = await stricter.service.dispatchExecutionPlan(stricter.plan.id);
    expect(result).toMatchObject({
      status: 'accepted',
      dispatch: {
        effectivePolicy: { version: 1, filesystem: 'none', network: 'deny', environment: 'empty' },
      },
    });
    expect(stricter.execution.submissionCount).toBe(1);
  });

  it('persists uncertain results and thrown ambiguity without starting or resubmitting', async () => {
    const uncertain = await harness({ status: 'uncertain' as const, externalReference: 'external:one' });
    let result = await uncertain.service.dispatchExecutionPlan(uncertain.plan.id);
    expect(result).toMatchObject({ status: 'uncertain', adapterInvoked: true, attemptRunning: false });
    result = await uncertain.service.dispatchExecutionPlan(uncertain.plan.id);
    expect(result).toMatchObject({ status: 'uncertain', adapterInvoked: false });
    expect(uncertain.execution.callCount).toBe(1);

    const thrown = await harness();
    thrown.execution.setError(new Error('acknowledgement lost'));
    result = await thrown.service.dispatchExecutionPlan(thrown.plan.id);
    expect(result).toMatchObject({ status: 'uncertain', adapterInvoked: true, attemptRunning: false });
    expect(result.dispatch?.message).toContain('acknowledgement lost');
    expect(await thrown.store.getAttempt(thrown.attempt.id)).toMatchObject({ status: 'created' });
  });

  it('creates no Dispatch and no effect when immediate Preflight blocks', async () => {
    const setup = await harness();
    const blockedPreflight = new ExecutionPreflightService(
      setup.store,
      runtime('stopped'),
      new FakeRepositoryInventoryAdapter([]),
    );
    const service = new ManualDispatchService(setup.store, blockedPreflight, setup.execution);
    const result = await service.dispatchExecutionPlan(setup.plan.id);
    expect(result).toMatchObject({ status: 'blocked', dispatch: null, adapterInvoked: false });
    expect(await setup.store.getExecutionDispatchForPlan(setup.plan.id)).toBeNull();
    expect(setup.execution.callCount).toBe(0);
    expect(await setup.store.getAttempt(setup.attempt.id)).toMatchObject({ status: 'created' });
  });

  it('blocks resubmission of a crash-window submitting Dispatch', async () => {
    const setup = await harness();
    const dispatch = preparedDispatch();
    await setup.store.createExecutionDispatch(dispatch);
    await moveToSubmitting(setup.store, dispatch);
    const result = await setup.service.dispatchExecutionPlan(setup.plan.id);
    expect(result).toMatchObject({ status: 'uncertain', adapterInvoked: false, attemptRunning: false });
    expect(result.dispatch?.status).toBe('submitting');
    expect(setup.execution.callCount).toBe(0);
  });

  it('reconciles accepted Dispatch/local-state lag without an external call', async () => {
    const setup = await harness();
    const prepared = preparedDispatch();
    await setup.store.createExecutionDispatch(prepared);
    const submitting = await moveToSubmitting(setup.store, prepared);
    const accepted: DurableExecutionDispatch = {
      ...submitting,
      status: 'accepted',
      acceptedAt: TIME,
      resolvedAt: TIME,
      revision: 2,
      effectivePolicy: setup.plan.requestedPolicy,
    };
    await setup.store.saveExecutionDispatchTransition(accepted, 1);

    const repeated = await setup.service.dispatchExecutionPlan(setup.plan.id);
    expect(repeated).toMatchObject({
      status: 'accepted',
      adapterInvoked: false,
      attemptRunning: false,
      requiresReconciliation: true,
    });
    const reconciled = await setup.service.reconcileAcceptedDispatch(accepted.id);
    expect(reconciled).toMatchObject({
      status: 'accepted',
      adapterInvoked: false,
      attemptRunning: true,
      requiresReconciliation: false,
    });
    expect(setup.execution.callCount).toBe(0);
  });

  it('allows one caller to claim a prepared crash-before-call record', async () => {
    const setup = await harness();
    await setup.store.createExecutionDispatch(preparedDispatch());
    const result = await setup.service.dispatchExecutionPlan(setup.plan.id);
    expect(result).toMatchObject({ status: 'accepted', adapterInvoked: true, attemptRunning: true });
    expect(setup.execution.callCount).toBe(1);
  });
});
