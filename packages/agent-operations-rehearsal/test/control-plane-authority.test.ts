import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  FakeRuntimeExecutionAdapter,
  FakeRuntimeExecutionObservationAdapter,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import {
  ExecutionObservationService,
  ExecutionOutcomeService,
  ExecutionPlanningService,
  ExecutionPreflightService,
  JobLifecycleService,
  ManualDispatchService,
} from '../../agent-operations-core/src/index.js';
import { SqliteAgentOperationsStateStore } from '../../sqlite-state-adapter/src/index.js';

const TIME = '2026-08-26T22:00:00.000Z';
const INSTALLATION_ID = 'installation:control-plane-authority';
const PROJECT_ID = 'control-plane-authority';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'agent-operations/rehearsal';
const POLICY = {
  version: 1 as const,
  filesystem: 'read-only' as const,
  network: 'deny' as const,
  environment: 'empty' as const,
};
const CAPABILITIES = { version: 1 as const, repositoryRead: true };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Agent Operations control-plane authority', () => {
  it('persists the complete AO chain while the external repository runtime stays restricted', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'ao-control-plane-authority-'));
    roots.push(fixture);
    const checkout = join(fixture, 'checkout');
    const databasePath = join(fixture, 'control-plane', 'state.db');
    mkdirSync(checkout);
    const canonicalCheckout = realpathSync(checkout);
    const bindingId = createRepositoryCheckoutBindingId(INSTALLATION_ID, canonicalCheckout);
    let store = SqliteAgentOperationsStateStore.open({
      databasePath,
      installationIdFactory: () => INSTALLATION_ID,
      now: () => new Date(TIME),
    });
    await store.applyProjectConfiguration({
      project: { id: PROJECT_ID, name: 'Control-plane authority', createdAt: TIME, updatedAt: TIME },
      repositories: [{
        id: REPOSITORY_ID,
        identityKind: 'remote',
        name: 'agent-operations',
        canonicalRemote: 'github.com/wftx/agent-operations',
        createdAt: TIME,
        updatedAt: TIME,
      }],
      checkoutBindings: [{
        id: bindingId,
        repositoryId: REPOSITORY_ID,
        installationId: INSTALLATION_ID,
        canonicalPath: canonicalCheckout,
        availability: 'available',
        firstSeenAt: TIME,
        lastSeenAt: TIME,
      }],
      runtimeAgentIds: [RUNTIME_ID],
    });
    const lifecycle = new JobLifecycleService(store, {
      now: () => new Date(TIME),
      jobIdFactory: () => 'job:control-plane-authority',
      attemptIdFactory: () => 'attempt:control-plane-authority',
    });
    const draft = await lifecycle.createJob({
      projectId: PROJECT_ID,
      title: 'Inspect repository without exposing AO state',
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: RUNTIME_ID,
    });
    const job = await lifecycle.markJobReady(draft.id);
    const attempt = await lifecycle.createAttempt(job.id);
    const plan = await new ExecutionPlanningService(store, {
      now: () => new Date(TIME),
      planIdFactory: () => 'plan:control-plane-authority',
    }).prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: 'Read one known non-secret source file.',
      checkoutBindingId: bindingId,
      requestedPolicy: POLICY,
      requestedCapabilities: CAPABILITIES,
    });
    const runtime = new FakeAgentRuntimeAdapter([{
      id: RUNTIME_ID,
      name: 'rehearsal',
      organization: 'agent-operations',
      provider: 'codex',
      enabled: true,
      configured: true,
      capabilities: [
        'exact-turn-correlation',
        'execution-working-directory',
        'repository-read-tools',
        'filesystem-read-only',
        'network-denial',
        'environment-empty',
      ],
      health: { state: 'running' },
      observedAt: TIME,
    }]);
    const repositories = new FakeRepositoryInventoryAdapter([{
      id: REPOSITORY_ID,
      identityKind: 'remote',
      name: 'agent-operations',
      checkoutPath: canonicalCheckout,
      repositoryRoot: canonicalCheckout,
      availability: 'available',
      branch: 'main',
      detachedHead: false,
      headCommit: '1111111111111111111111111111111111111111',
      workingTree: 'clean',
      remotes: [{
        name: 'origin',
        fetchUrl: 'https://github.com/wftx/agent-operations',
        identity: {
          host: 'github.com',
          repositoryPath: 'wftx/agent-operations',
          canonical: 'github.com/wftx/agent-operations',
        },
      }],
      primaryRemote: {
        name: 'origin',
        fetchUrl: 'https://github.com/wftx/agent-operations',
        identity: {
          host: 'github.com',
          repositoryPath: 'wftx/agent-operations',
          canonical: 'github.com/wftx/agent-operations',
        },
      },
      observedAt: TIME,
    }]);
    const execution = new FakeRuntimeExecutionAdapter({
      status: 'accepted',
      externalReference: 'cortextos:codex-turn:v1:thread-control:turn-control',
    });
    const dispatched = await new ManualDispatchService(
      store,
      new ExecutionPreflightService(store, runtime, repositories, () => new Date(TIME)),
      execution,
      { now: () => new Date(TIME), dispatchIdFactory: () => 'dispatch:control-plane-authority' },
    ).dispatchExecutionPlan(plan.id);
    expect(dispatched).toMatchObject({
      status: 'accepted',
      attemptRunning: true,
      dispatch: {
        status: 'accepted',
        effectivePolicy: POLICY,
        effectiveCapabilities: CAPABILITIES,
      },
    });
    const providerRequest = execution.requests[0];
    expect(providerRequest).toMatchObject({
      requestedPolicy: POLICY,
      requestedCapabilities: CAPABILITIES,
      executionContext: {
        workingDirectory: canonicalCheckout,
        repositoryReadRoot: canonicalCheckout,
      },
    });
    expect(JSON.stringify(providerRequest)).not.toContain(databasePath);
    expect(databasePath.startsWith(`${canonicalCheckout}/`)).toBe(false);

    const observationService = new ExecutionObservationService(
      store,
      new FakeRuntimeExecutionObservationAdapter([{
        source: 'fake-codex-turn',
        sourceEventId: 'turn-control',
        kind: 'turn-completed',
        correlation: 'exact',
        correlatedDispatchId: dispatched.dispatch!.id,
        runtimeSessionId: 'thread-control',
        externalReference: 'turn-control',
        outputSummary: 'Read-only repository inspection completed.',
        executionContext: {
          workingDirectory: canonicalCheckout,
          repositoryReadRoot: canonicalCheckout,
        },
        effectivePolicy: POLICY,
        effectiveCapabilities: CAPABILITIES,
        observedAt: TIME,
      }]),
      () => new Date(TIME),
    );
    const observed = await observationService.observeAttemptExecution(attempt.id);
    expect(observed).toMatchObject({ inserted: 1, detail: { exactCompletionEvidence: true } });
    const outcome = await new ExecutionOutcomeService(store, observationService, {
      now: () => new Date(TIME),
      decisionIdFactory: () => 'outcome:control-plane-authority',
    }).confirmAttemptSucceeded(attempt.id, {
      summary: 'Human verified the bounded repository result.',
    });
    expect(outcome).toMatchObject({
      attempt: { status: 'completed' },
      job: { status: 'ready' },
      outcomeDecision: { source: 'human', outcome: 'completed' },
    });
    await lifecycle.completeJob(job.id);
    await store.close();

    store = SqliteAgentOperationsStateStore.open({ databasePath });
    expect(await store.getExecutionDispatch(dispatched.dispatch!.id)).toMatchObject({ status: 'accepted' });
    expect(await store.listExecutionObservationsForDispatch(dispatched.dispatch!.id)).toHaveLength(1);
    expect(await store.getAttemptOutcomeDecision(attempt.id)).toMatchObject({ outcome: 'completed' });
    expect(await store.getAttempt(attempt.id)).toMatchObject({ status: 'completed' });
    expect(await store.getJob(job.id)).toMatchObject({ status: 'completed' });
    await store.close();
  });
});
