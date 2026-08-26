import { describe, expect, it } from 'vitest';
import type {
  AgentOperationsStateStore,
  AgentRuntimeAdapter,
  DurableProjectConfiguration,
  RepositoryInventoryAdapter,
  RepositorySummary,
  RuntimeState,
} from '../../agent-operations-contracts/src/index.js';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  InMemoryAgentOperationsStateStore,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import {
  ExecutionPlanningService,
  ExecutionPreflightService,
  JobLifecycleService,
} from '../src/index.js';

const TIME = '2026-08-21T13:00:00.000Z';
const INSTALLATION_ID = 'installation:preflight';
const PROJECT_ID = 'agent-operations';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'engineering/coder';
const PATH = '/fixtures/agent-operations';
const BINDING_ID = createRepositoryCheckoutBindingId(INSTALLATION_ID, PATH);

function configuration(runtimeIds: readonly string[] = [RUNTIME_ID]): DurableProjectConfiguration {
  return {
    project: { id: PROJECT_ID, name: 'Agent Operations', createdAt: TIME, updatedAt: TIME },
    repositories: [{
      id: REPOSITORY_ID,
      identityKind: 'remote',
      name: 'agent-operations',
      canonicalRemote: 'github.com/wftx/agent-operations',
      createdAt: TIME,
      updatedAt: TIME,
    }],
    checkoutBindings: [{
      id: BINDING_ID,
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      canonicalPath: PATH,
      availability: 'available',
      firstSeenAt: TIME,
      lastSeenAt: TIME,
    }],
    runtimeAgentIds: runtimeIds,
  };
}

function runtime(
  state: RuntimeState = 'running',
  provider: 'codex' | 'unknown' = 'codex',
  workingDirectory: string | null = PATH,
) {
  return new FakeAgentRuntimeAdapter([{
    id: RUNTIME_ID,
    name: 'coder',
    organization: 'engineering',
    provider,
    enabled: true,
    configured: true,
    capabilities: ['session-resume', 'filesystem-read-only', 'network-denial', 'environment-empty'],
    health: { state },
    observedAt: TIME,
    ...(workingDirectory ? { workingDirectory } : {}),
  }]);
}

function repository(overrides: Partial<RepositorySummary> = {}): FakeRepositoryInventoryAdapter {
  return new FakeRepositoryInventoryAdapter([{
    id: REPOSITORY_ID,
    identityKind: 'remote',
    name: 'agent-operations',
    checkoutPath: PATH,
    repositoryRoot: PATH,
    availability: 'available',
    branch: 'main',
    detachedHead: false,
    headCommit: '1111111111111111111111111111111111111111',
    workingTree: 'clean',
    remotes: [],
    observedAt: TIME,
    ...overrides,
  }]);
}

async function prepared() {
  const store = new InMemoryAgentOperationsStateStore({
    installation: { id: INSTALLATION_ID, createdAt: TIME },
  });
  await store.applyProjectConfiguration(configuration());
  const lifecycle = new JobLifecycleService(store, {
    now: () => new Date(TIME),
    jobIdFactory: () => 'job:preflight',
    attemptIdFactory: () => 'attempt:preflight',
  });
  const job = await lifecycle.createJob({
    projectId: PROJECT_ID,
    title: 'Inspect the repository',
    repositoryId: REPOSITORY_ID,
    preferredRuntimeAgentId: RUNTIME_ID,
  });
  await lifecycle.markJobReady(job.id);
  const attempt = await lifecycle.createAttempt(job.id);
  const plan = await new ExecutionPlanningService(store, {
    now: () => new Date(TIME),
    planIdFactory: () => 'plan:preflight',
  }).prepareExecutionPlan({
    projectId: PROJECT_ID,
    attemptId: attempt.id,
    instruction: 'Inspect the failing test.',
    requestedPolicy: { version: 1, filesystem: 'read-only', network: 'deny', environment: 'empty' },
  });
  return { store, lifecycle, job, attempt, plan };
}

function withOverrides(
  store: AgentOperationsStateStore,
  overrides: Partial<AgentOperationsStateStore>,
): AgentOperationsStateStore {
  return new Proxy(store, {
    get(target, property) {
      const override = Reflect.get(overrides, property);
      if (override !== undefined) return typeof override === 'function' ? override.bind(overrides) : override;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function codes(result: { checks: readonly { code: string }[] }): string[] {
  return result.checks.map(check => check.code);
}

describe('ExecutionPreflightService', () => {
  it('is dispatchable on current durable, running-runtime, and matching-repository state', async () => {
    const { store, plan } = await prepared();
    const result = await new ExecutionPreflightService(store, runtime(), repository(), () => new Date(TIME))
      .preflight(plan.id);
    expect(result).toMatchObject({ status: 'ready', dispatchable: true, checkedAt: TIME });
    expect(codes(result)).toEqual(expect.arrayContaining([
      'job-ready',
      'attempt-created',
      'runtime-running',
      'checkout-available',
      'repository-identity-valid',
    ]));
  });

  it('warns without blocking for dirty and detached checkouts', async () => {
    const { store, plan } = await prepared();
    const result = await new ExecutionPreflightService(
      store,
      runtime(),
      repository({ workingTree: 'dirty', detachedHead: true, branch: undefined }),
      () => new Date(TIME),
    ).preflight(plan.id);
    expect(result).toMatchObject({ status: 'warning', dispatchable: true });
    expect(codes(result)).toEqual(expect.arrayContaining(['working-tree-dirty', 'detached-head']));
  });

  it('shows requested and effective policy, including a safe stricter provider result', async () => {
    const { store, plan } = await prepared();
    const widerPlan = {
      ...plan,
      requestedPolicy: {
        version: 1 as const,
        filesystem: 'workspace-write' as const,
        network: 'allow' as const,
        environment: 'minimal' as const,
      },
    };
    const result = await new ExecutionPreflightService(
      withOverrides(store, { getExecutionPlan: async () => widerPlan }),
      runtime(),
      repository(),
      () => new Date(TIME),
    ).preflight(plan.id);
    expect(result).toMatchObject({
      dispatchable: true,
      requestedPolicy: widerPlan.requestedPolicy,
      effectivePolicy: { version: 1, filesystem: 'read-only', network: 'allow', environment: 'empty' },
    });
    expect(codes(result)).toContain('runtime-policy-supported');
  });

  it('blocks legacy unspecified and unsupported policy without dispatch', async () => {
    const legacy = await prepared();
    const { requestedPolicy: _ignored, ...legacyPlan } = legacy.plan;
    let result = await new ExecutionPreflightService(
      withOverrides(legacy.store, { getExecutionPlan: async () => legacyPlan }),
      runtime(),
      repository(),
    ).preflight(legacy.plan.id);
    expect(result.dispatchable).toBe(false);
    expect(codes(result)).toContain('runtime-policy-unspecified');

    const unsupported = await prepared();
    result = await new ExecutionPreflightService(
      unsupported.store,
      new FakeAgentRuntimeAdapter([{
        id: RUNTIME_ID,
        name: 'coder',
        organization: 'engineering',
        provider: 'codex',
        enabled: true,
        configured: true,
        capabilities: ['session-resume'],
        health: { state: 'running' },
        observedAt: TIME,
        workingDirectory: PATH,
      }]),
      repository(),
    ).preflight(unsupported.plan.id);
    expect(result.dispatchable).toBe(false);
    expect(codes(result)).toContain('runtime-policy-unsupported');
  });

  it('blocks repository work when runtime checkout compatibility cannot be proven', async () => {
    const unavailable = await prepared();
    let result = await new ExecutionPreflightService(
      unavailable.store,
      runtime('running', 'codex', null),
      repository(),
    ).preflight(unavailable.plan.id);
    expect(codes(result)).toContain('runtime-working-directory-unavailable');
    expect(result.dispatchable).toBe(false);

    const mismatch = await prepared();
    result = await new ExecutionPreflightService(
      mismatch.store,
      runtime('running', 'codex', '/fixtures/wrong-checkout'),
      repository(),
    ).preflight(mismatch.plan.id);
    expect(codes(result)).toContain('runtime-checkout-mismatch');
    expect(result.dispatchable).toBe(false);
  });

  it.each(['starting', 'stopped', 'degraded', 'unknown'] as const)(
    'blocks when the runtime is %s',
    async state => {
      const { store, plan } = await prepared();
      const result = await new ExecutionPreflightService(store, runtime(state), repository()).preflight(plan.id);
      expect(result).toMatchObject({ status: 'blocked', dispatchable: false });
      expect(codes(result)).toContain(`runtime-${state}`);
    },
  );

  it('blocks unavailable inventory, missing runtime, unknown provider, and removed association', async () => {
    const unavailable = await prepared();
    const unavailableAdapter = new FakeAgentRuntimeAdapter([], {
      state: 'unavailable', observedAt: TIME, agentCount: 0, reason: 'No daemon',
    });
    let result = await new ExecutionPreflightService(unavailable.store, unavailableAdapter, repository())
      .preflight(unavailable.plan.id);
    expect(codes(result)).toContain('runtime-adapter-unavailable');

    const missing = await prepared();
    result = await new ExecutionPreflightService(missing.store, new FakeAgentRuntimeAdapter([]), repository())
      .preflight(missing.plan.id);
    expect(codes(result)).toContain('runtime-missing');

    const unknown = await prepared();
    result = await new ExecutionPreflightService(unknown.store, runtime('running', 'unknown'), repository())
      .preflight(unknown.plan.id);
    expect(codes(result)).toContain('runtime-provider-unknown');
    expect(result.dispatchable).toBe(false);

    const removed = await prepared();
    await removed.store.applyProjectConfiguration(configuration([]));
    result = await new ExecutionPreflightService(removed.store, runtime(), repository()).preflight(removed.plan.id);
    expect(codes(result)).toContain('runtime-not-associated');
    expect(result.dispatchable).toBe(false);
  });

  it('blocks running runtimes that are unconfigured or explicitly disabled', async () => {
    for (const runtimeState of [
      { configured: false, enabled: true, code: 'runtime-not-configured' },
      { configured: true, enabled: false, code: 'runtime-disabled' },
    ] as const) {
      const { store, plan } = await prepared();
      const adapter = new FakeAgentRuntimeAdapter([{
        id: RUNTIME_ID,
        name: 'coder',
        organization: 'engineering',
        provider: 'codex',
        configured: runtimeState.configured,
        enabled: runtimeState.enabled,
        capabilities: [],
        health: { state: 'running' },
        observedAt: TIME,
      }]);
      const result = await new ExecutionPreflightService(store, adapter, repository()).preflight(plan.id);
      expect(codes(result)).toContain(runtimeState.code);
      expect(result.dispatchable).toBe(false);
    }
  });

  it('blocks runtime adapter exceptions', async () => {
    const { store, plan } = await prepared();
    const throwing: AgentRuntimeAdapter = {
      listAgents: async () => { throw new Error('offline'); },
      getAgent: async () => { throw new Error('offline'); },
      getHealth: async () => { throw new Error('offline'); },
    };
    const result = await new ExecutionPreflightService(store, throwing, repository()).preflight(plan.id);
    expect(codes(result)).toContain('runtime-adapter-unavailable');
    expect(result.dispatchable).toBe(false);
  });

  it.each([
    ['unavailable', 'checkout-unavailable'],
    ['not-a-repository', 'checkout-not-git'],
    ['degraded', 'repository-observation-unavailable'],
  ] as const)('blocks repository availability %s', async (availability, code) => {
    const { store, plan } = await prepared();
    const result = await new ExecutionPreflightService(store, runtime(), repository({ availability }))
      .preflight(plan.id);
    expect(codes(result)).toContain(code);
    expect(result.dispatchable).toBe(false);
  });

  it('blocks missing binding, wrong binding scope, repository mismatch, and observation exceptions', async () => {
    const missing = await prepared();
    let result = await new ExecutionPreflightService(
      withOverrides(missing.store, { listCheckoutBindings: async () => [] }),
      runtime(),
      repository(),
    ).preflight(missing.plan.id);
    expect(codes(result)).toContain('checkout-missing');

    const scoped = await prepared();
    result = await new ExecutionPreflightService(withOverrides(scoped.store, {
      listCheckoutBindings: async () => [{
        ...(await scoped.store.listCheckoutBindings())[0],
        installationId: 'installation:other',
        repositoryId: 'remote:github.com/example/other',
      }],
    }), runtime(), repository()).preflight(scoped.plan.id);
    expect(codes(result)).toEqual(expect.arrayContaining([
      'checkout-wrong-installation',
      'checkout-repository-mismatch',
    ]));

    const mismatch = await prepared();
    result = await new ExecutionPreflightService(
      mismatch.store,
      runtime(),
      repository({ id: 'remote:github.com/example/wrong' }),
    ).preflight(mismatch.plan.id);
    expect(codes(result)).toContain('repository-identity-mismatch');

    const failed = await prepared();
    const throws: RepositoryInventoryAdapter = {
      inspectRepository: async () => { throw new Error('Git unavailable'); },
    };
    result = await new ExecutionPreflightService(failed.store, runtime(), throws).preflight(failed.plan.id);
    expect(codes(result)).toContain('repository-observation-unavailable');
    expect(result.dispatchable).toBe(false);
  });

  it('fails closed when lifecycle or preparation revisions change', async () => {
    const changed = await prepared();
    await changed.lifecycle.startAttempt(changed.attempt.id);
    const result = await new ExecutionPreflightService(changed.store, runtime(), repository())
      .preflight(changed.plan.id);
    expect(codes(result)).toEqual(expect.arrayContaining([
      'attempt-not-created',
      'plan-attempt-revision-stale',
    ]));
    expect(result.dispatchable).toBe(false);

    const jobChanged = await prepared();
    await jobChanged.store.saveJobTransition({
      ...(await jobChanged.store.getJob(jobChanged.job.id))!,
      status: 'cancelled',
      revision: 2,
      updatedAt: TIME,
    }, 1);
    const jobResult = await new ExecutionPreflightService(jobChanged.store, runtime(), repository())
      .preflight(jobChanged.plan.id);
    expect(codes(jobResult)).toEqual(expect.arrayContaining(['job-not-ready', 'plan-job-revision-stale']));
    expect(jobResult.dispatchable).toBe(false);

    const completed = await prepared();
    await completed.lifecycle.startAttempt(completed.attempt.id);
    await completed.lifecycle.completeAttempt(completed.attempt.id, 'Done');
    await completed.lifecycle.completeJob(completed.job.id);
    const completedResult = await new ExecutionPreflightService(completed.store, runtime(), repository())
      .preflight(completed.plan.id);
    expect(codes(completedResult)).toEqual(expect.arrayContaining([
      'job-not-ready',
      'attempt-not-created',
      'plan-job-revision-stale',
      'plan-attempt-revision-stale',
    ]));
    expect(completedResult.dispatchable).toBe(false);

    const staleOnly = await prepared();
    const staleJob = (await staleOnly.store.getJob(staleOnly.job.id))!;
    await staleOnly.store.saveJobTransition({ ...staleJob, title: 'Changed title', revision: 2 }, 1);
    const staleResult = await new ExecutionPreflightService(staleOnly.store, runtime(), repository())
      .preflight(staleOnly.plan.id);
    expect(codes(staleResult)).toContain('plan-job-revision-stale');
    expect(codes(staleResult)).toContain('job-ready');
    expect(staleResult.dispatchable).toBe(false);
  });

  it('fails closed when durable Job or Attempt disappears from the read boundary', async () => {
    const missingJob = await prepared();
    let result = await new ExecutionPreflightService(withOverrides(missingJob.store, {
      getJob: async () => null,
    }), runtime(), repository()).preflight(missingJob.plan.id);
    expect(codes(result)).toContain('job-missing');

    const missingAttempt = await prepared();
    result = await new ExecutionPreflightService(withOverrides(missingAttempt.store, {
      getAttempt: async () => null,
    }), runtime(), repository()).preflight(missingAttempt.plan.id);
    expect(codes(result)).toContain('attempt-missing');
    expect(result.dispatchable).toBe(false);
  });
});
