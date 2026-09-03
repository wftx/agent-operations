import { describe, expect, it } from 'vitest';
import {
  DAILY_DRIVER_TRUST_POLICY,
  InMemoryAgentOperationsStateStore,
  createExecutionDispatchIdempotencyKey,
  type AgentRuntimeDetail,
  type AgentRuntimeAdapter,
  type RuntimeLifecycleAdapter,
} from '../../agent-operations-contracts/src/index.js';
import {
  RuntimeFreshnessService,
  type TrustProfileApplication,
} from '../src/index.js';
import { JobLifecycleService } from '../../agent-operations-core/src/index.js';

const time = '2026-09-02T12:00:00.000Z';
const jobId = 'job:freshness';
const agentId = 'agent-operations/ao-orchestrator';

describe('RuntimeFreshnessService', () => {
  it('detects stale source and tool identity, restarts safely, and verifies current identity', async () => {
    const store = await fixtureStore();
    let detail = runtimeDetail('sha256:old-tools', 'sha256:old-build');
    let restarts = 0;
    const runtime = fakeRuntime(() => detail);
    const lifecycle: RuntimeLifecycleAdapter = {
      start: async () => startResult(),
      restart: async () => {
        restarts += 1;
        detail = runtimeDetail('sha256:new-tools', 'sha256:new-build');
        return startResult();
      },
    };
    const service = new RuntimeFreshnessService(
      store, runtime, lifecycle, dailyDriverTrust(), {
        runtimeAgentId: agentId,
        expectedToolCatalogRevision: 'sha256:new-tools',
        expectedRevision: 'sha256:new-build',
      },
    );

    await expect(service.inspect()).resolves.toMatchObject({ state: 'stale-blocked' });
    await expect(service.ensureCurrentForJob(jobId)).resolves.toMatchObject({
      state: 'current',
      loadedToolCatalogRevision: 'sha256:new-tools',
      loadedRevision: 'sha256:new-build',
    });
    expect(restarts).toBe(1);
  });

  it('defers an unsafe restart while an accepted provider execution is active', async () => {
    const store = await fixtureStore();
    await seedAcceptedExecution(store);
    let restarts = 0;
    const service = new RuntimeFreshnessService(
      store,
      fakeRuntime(() => runtimeDetail('sha256:old-tools', 'sha256:old-build')),
      {
        start: async () => startResult(),
        restart: async () => { restarts += 1; return startResult(); },
      },
      dailyDriverTrust(),
      {
        runtimeAgentId: agentId,
        expectedToolCatalogRevision: 'sha256:new-tools',
        expectedRevision: 'sha256:new-build',
      },
    );

    await expect(service.ensureCurrentForJob(jobId)).resolves.toMatchObject({
      state: 'restart-pending',
      activeAcceptedWork: 1,
    });
    expect(restarts).toBe(0);
  });

  it('also defers restart while a submission outcome is uncertain', async () => {
    const store = await fixtureStore();
    await seedAcceptedExecution(store, 'uncertain');
    let restarts = 0;
    const service = new RuntimeFreshnessService(
      store,
      fakeRuntime(() => runtimeDetail('sha256:old-tools', 'sha256:old-build')),
      { start: async () => startResult(), restart: async () => { restarts += 1; return startResult(); } },
      dailyDriverTrust(),
      { runtimeAgentId: agentId, expectedToolCatalogRevision: 'sha256:new-tools', expectedRevision: 'sha256:new-build' },
    );

    await expect(service.ensureCurrentForJob(jobId)).resolves.toMatchObject({ state: 'restart-pending' });
    expect(restarts).toBe(0);
  });
});

async function fixtureStore() {
  const store = new InMemoryAgentOperationsStateStore();
  await store.applyProjectConfiguration({
    project: { id: 'project:freshness', name: 'Freshness', createdAt: time, updatedAt: time },
    repositories: [], checkoutBindings: [], runtimeAgentIds: [agentId],
  });
  await store.createJob({
    id: jobId, projectId: 'project:freshness', title: 'Fresh runtime', status: 'draft',
    revision: 0, createdAt: time, updatedAt: time,
  });
  await new JobLifecycleService(store, { now: () => new Date(time) }).markJobReady(jobId);
  return store;
}

async function seedAcceptedExecution(
  store: InMemoryAgentOperationsStateStore,
  terminalStatus: 'accepted' | 'uncertain' = 'accepted',
) {
  const attempt = await store.createAttempt({
    id: 'attempt:freshness', jobId, runtimeAgentId: agentId, executionRole: 'worker',
    status: 'created', revision: 0, createdAt: time, updatedAt: time,
  });
  await store.saveAttemptTransition({
    ...attempt, status: 'running', revision: 1, startedAt: time, updatedAt: time,
  }, 0);
  await store.createExecutionPlan({
    id: 'plan:freshness', attemptId: attempt.id, jobId, projectId: 'project:freshness',
    installationId: (await store.getInstallation()).id, runtimeAgentId: agentId,
    input: { version: 1, instruction: 'Observe active work.' },
    requestedPolicy: { version: 1, filesystem: 'read-only', network: 'deny', environment: 'empty' },
    requestedCapabilities: { version: 1, repositoryRead: false },
    jobRevisionAtPreparation: 1, attemptRevisionAtPreparation: 1, createdAt: time,
  });
  const prepared = {
    id: 'dispatch:freshness', executionPlanId: 'plan:freshness', attemptId: attempt.id,
    jobId, runtimeAgentId: agentId,
    idempotencyKey: createExecutionDispatchIdempotencyKey('plan:freshness'),
    status: 'prepared' as const, revision: 0, createdAt: time, updatedAt: time,
  };
  await store.createExecutionDispatch(prepared);
  const submitting = { ...prepared, status: 'submitting' as const, revision: 1, submittedAt: time };
  await store.saveExecutionDispatchTransition(submitting, 0);
  await store.saveExecutionDispatchTransition({
    ...submitting, status: terminalStatus, revision: 2, resolvedAt: time,
    ...(terminalStatus === 'accepted' ? {
      acceptedAt: time, externalReference: 'cortextos:codex-turn:v1:thread:turn',
      effectivePolicy: { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const },
      effectiveCapabilities: { version: 1 as const, repositoryRead: false },
    } : {}),
  }, 1);
}

function runtimeDetail(toolCatalogRevision: string, loadedRevision: string): AgentRuntimeDetail {
  return {
    id: agentId, name: 'ao-orchestrator', organization: 'agent-operations', provider: 'codex',
    enabled: true, configured: true, capabilities: ['exact-turn-correlation'],
    health: { state: 'running' }, observedAt: time, toolCatalogRevision, loadedRevision,
  };
}

function fakeRuntime(read: () => AgentRuntimeDetail): AgentRuntimeAdapter {
  return {
    listAgents: async () => [read()],
    getAgent: async () => read(),
    getHealth: async () => ({ state: 'available', observedAt: time, agentCount: 1 }),
  };
}

function dailyDriverTrust(): TrustProfileApplication {
  const effective = async () => ({ profile: null, policy: DAILY_DRIVER_TRUST_POLICY, source: 'global' as const });
  return { list: async () => [], save: async () => { throw new Error('not used'); }, effectiveForProject: effective, effectiveForJob: effective };
}

function startResult() {
  return {
    status: 'started' as const,
    instanceId: 'default',
    message: 'started',
    inventory: { configuredAgents: [], configuredCronCount: 0, configuredIntegrationCount: 0 },
  };
}
