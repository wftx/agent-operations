import { describe, expect, it } from 'vitest';
import type {
  DurableProjectConfiguration,
  DurableRepositoryObservation,
} from '../src/index.js';
import {
  InMemoryAgentOperationsStateStore,
  createRepositoryCheckoutBindingId,
} from '../src/index.js';

const TIME = '2026-05-06T07:08:09.000Z';

function configuredState(installationId = 'installation:test'): DurableProjectConfiguration {
  return {
    project: { id: 'ao', name: 'Agent Operations', createdAt: TIME, updatedAt: TIME },
    repositories: [{
      id: 'remote:github.com/wftx/agent-operations',
      identityKind: 'remote',
      name: 'agent-operations',
      canonicalRemote: 'github.com/wftx/agent-operations',
      createdAt: TIME,
      updatedAt: TIME,
    }],
    checkoutBindings: [{
      id: createRepositoryCheckoutBindingId(installationId, '/repos/agent-operations'),
      repositoryId: 'remote:github.com/wftx/agent-operations',
      installationId,
      canonicalPath: '/repos/agent-operations',
      availability: 'available',
      firstSeenAt: TIME,
      lastSeenAt: TIME,
    }],
    runtimeAgentIds: ['operations/agent'],
  };
}

describe('Agent Operations persistence contracts', () => {
  it('creates deterministic checkout IDs scoped by installation and canonical path', () => {
    const one = createRepositoryCheckoutBindingId('installation:one', '/repos/ao');
    expect(one).toBe(createRepositoryCheckoutBindingId('installation:one', '/repos/ao'));
    expect(one).not.toBe(createRepositoryCheckoutBindingId('installation:two', '/repos/ao'));
    expect(one).not.toBe(createRepositoryCheckoutBindingId('installation:one', '/repos/other'));
    expect(one).toMatch(/^checkout:[a-f0-9]{64}$/);
  });

  it('keeps configured identity separate from optional observed state', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const configured = configuredState();
    await store.applyProjectConfiguration(configured);
    expect(await store.getLatestRepositoryObservation(configured.checkoutBindings[0].id)).toBeNull();

    const observation: DurableRepositoryObservation = {
      repositoryId: configured.repositories[0].id,
      checkoutBindingId: configured.checkoutBindings[0].id,
      availability: 'degraded',
      detachedHead: false,
      workingTree: 'unknown',
      observedAt: TIME,
    };
    await store.recordRepositoryObservation(observation);
    expect(await store.getRepository(configured.repositories[0].id)).toEqual(configured.repositories[0]);
    expect(await store.getLatestRepositoryObservation(configured.checkoutBindings[0].id)).toEqual(observation);
  });
});

describe('InMemoryAgentOperationsStateStore', () => {
  it('persists associations and returns defensive copies', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const configured = configuredState();
    await store.applyProjectConfiguration(configured);
    const projects = await store.listProjects();
    (projects[0] as { name: string }).name = 'mutated';
    expect((await store.getProject('ao'))?.name).toBe('Agent Operations');
    expect(await store.listProjectRepositoryIds('ao')).toEqual([configured.repositories[0].id]);
    expect(await store.listProjectRuntimeAgentIds('ao')).toEqual(['operations/agent']);
  });

  it('supports multiple checkout bindings for one portable repository', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const configured = configuredState();
    await store.applyProjectConfiguration({
      ...configured,
      checkoutBindings: [
        ...configured.checkoutBindings,
        {
          ...configured.checkoutBindings[0],
          id: createRepositoryCheckoutBindingId('installation:test', '/repos/agent-operations-two'),
          canonicalPath: '/repos/agent-operations-two',
        },
      ],
    });
    expect(await store.listCheckoutBindings(configured.repositories[0].id)).toHaveLength(2);
  });

  it('rejects identity conflicts, unknown associations, and simulated failures', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const configured = configuredState();
    await store.applyProjectConfiguration(configured);
    await expect(store.recordRuntimeObservation({
      projectId: 'ao',
      agentId: 'unknown/agent',
      associationState: 'unavailable',
      observedAt: TIME,
    })).rejects.toThrow('Unknown project runtime association');

    await expect(store.applyProjectConfiguration({
      ...configured,
      repositories: [{ ...configured.repositories[0], canonicalRemote: 'github.com/other/repository' }],
    })).rejects.toThrow('inconsistent canonical identity');

    const failing = new InMemoryAgentOperationsStateStore({ failOperations: ['apply-configuration'] });
    await expect(failing.applyProjectConfiguration(configured))
      .rejects.toThrow('Simulated persistence failure: apply-configuration');
    expect(await failing.listProjects()).toEqual([]);
  });
});
