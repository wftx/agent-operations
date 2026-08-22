import { describe, expect, it } from 'vitest';
import type {
  AgentOperationsConfiguration,
  AgentRuntimeAdapter,
} from '../../agent-operations-contracts/src/index.js';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  InMemoryAgentOperationsStateStore,
} from '../../agent-operations-contracts/src/index.js';
import { AgentOperationsStateSyncService } from '../src/index.js';

const PROJECT_TIME = '2026-07-08T09:10:11.000Z';
const REPOSITORY_TIME = '2026-01-01T00:00:00.000Z';

function configuration(
  repositoryPath = '/fixtures/clean',
  runtimeAgentIds: readonly string[] = ['research/researcher'],
): AgentOperationsConfiguration {
  return {
    version: 1,
    projects: [{
      id: 'ao',
      name: 'Agent Operations',
      repositories: [{ path: repositoryPath }],
      runtimeAgentIds,
    }],
  };
}

function service(
  store: InMemoryAgentOperationsStateStore,
  repositories = new FakeRepositoryInventoryAdapter(),
  runtimes: AgentRuntimeAdapter = new FakeAgentRuntimeAdapter(),
): AgentOperationsStateSyncService {
  return new AgentOperationsStateSyncService(repositories, runtimes, store, {
    now: () => new Date(PROJECT_TIME),
  });
}

describe('AgentOperationsStateSyncService', () => {
  it('persists configured state and normalized repository/runtime observations explicitly', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const result = await service(store).sync(configuration(), '/ignored');
    expect(result).toMatchObject({
      installation: { id: 'installation:test' },
      persistedRepositoryObservations: 1,
      persistedRuntimeObservations: 1,
    });
    expect(await store.getProject('ao')).toMatchObject({
      id: 'ao',
      name: 'Agent Operations',
      createdAt: PROJECT_TIME,
    });
    expect(await store.listProjectRepositoryIds('ao')).toEqual(['remote:github.com/example/clean']);
    expect(await store.listProjectRuntimeAgentIds('ao')).toEqual(['research/researcher']);

    const [binding] = await store.listCheckoutBindings('remote:github.com/example/clean');
    expect(binding).toMatchObject({
      installationId: 'installation:test',
      canonicalPath: '/fixtures/clean',
    });
    expect(await store.getLatestRepositoryObservation(binding.id)).toMatchObject({
      branch: 'main',
      workingTree: 'clean',
      observedAt: REPOSITORY_TIME,
    });
    expect(await store.getLatestRuntimeObservation('ao', 'research/researcher')).toMatchObject({
      associationState: 'available',
      provider: 'claude',
      runtimeState: 'running',
      lastHeartbeat: REPOSITORY_TIME,
      observedAt: PROJECT_TIME,
    });
  });

  it('stores useful project state when repository inspection fails completely', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const repositories = new FakeRepositoryInventoryAdapter(
      [],
      new Map([['/fixtures/broken', 'simulated Git failure']]),
    );
    const result = await service(store, repositories).sync(configuration('/fixtures/broken', []), '/ignored');
    expect(result.projects[0].state).toBe('degraded');
    expect(await store.getProject('ao')).not.toBeNull();
    expect(await store.listProjectRepositoryIds('ao')).toEqual([]);
    expect(await store.listCheckoutBindings()).toEqual([]);
    expect(result.persistedRepositoryObservations).toBe(0);
  });

  it('retains an unavailable repository summary as a durable observation', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const result = await service(store).sync(configuration('/fixtures/unavailable', []), '/ignored');
    expect(result.persistedRepositoryObservations).toBe(1);
    const [repositoryId] = await store.listProjectRepositoryIds('ao');
    const [binding] = await store.listCheckoutBindings(repositoryId);
    expect(await store.getLatestRepositoryObservation(binding.id)).toMatchObject({
      repositoryId,
      availability: 'unavailable',
      workingTree: 'unknown',
      reason: 'Fixture path is unavailable',
      observedAt: REPOSITORY_TIME,
    });
  });

  it('stores repository state and an unavailable runtime observation when runtime inventory fails', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const failingRuntime: AgentRuntimeAdapter = {
      listAgents: async () => { throw new Error('runtime offline'); },
      getAgent: async () => null,
      getHealth: async () => ({
        state: 'unavailable',
        agentCount: 0,
        observedAt: PROJECT_TIME,
      }),
    };
    const result = await service(store, new FakeRepositoryInventoryAdapter(), failingRuntime)
      .sync(configuration(), '/ignored');
    expect(result.persistedRepositoryObservations).toBe(1);
    expect(await store.listProjectRepositoryIds('ao')).toHaveLength(1);
    expect(await store.getLatestRuntimeObservation('ao', 'research/researcher')).toEqual({
      projectId: 'ao',
      agentId: 'research/researcher',
      associationState: 'unavailable',
      reason: 'Runtime inventory failed: runtime offline',
      observedAt: PROJECT_TIME,
    });
  });

  it('surfaces persistence failure instead of pretending a sync succeeded', async () => {
    const store = new InMemoryAgentOperationsStateStore({ failOperations: ['apply-configuration'] });
    await expect(service(store).sync(configuration(), '/ignored'))
      .rejects.toThrow('Simulated persistence failure: apply-configuration');
  });
});
