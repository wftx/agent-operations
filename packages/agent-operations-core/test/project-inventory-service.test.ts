import { describe, expect, it } from 'vitest';
import type {
  AgentOperationsConfiguration,
  AgentRuntimeAdapter,
} from '../../agent-operations-contracts/src/index.js';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  createRepositoryInventoryFixtures,
} from '../../agent-operations-contracts/src/index.js';
import {
  ProjectInventoryService,
  parseAgentOperationsConfiguration,
} from '../src/index.js';

const OBSERVED_AT = '2026-04-05T06:07:08.000Z';

describe('Agent Operations configuration', () => {
  it('parses a minimal versioned configuration and rejects duplicate project IDs', () => {
    expect(parseAgentOperationsConfiguration({
      version: 1,
      projects: [{ id: 'one', name: 'One', repositories: [{ path: '.' }] }],
    })).toEqual({
      version: 1,
      projects: [{ id: 'one', name: 'One', repositories: [{ path: '.' }], runtimeAgentIds: [] }],
    });
    expect(() => parseAgentOperationsConfiguration({
      version: 1,
      projects: [
        { id: 'same', name: 'One' },
        { id: 'same', name: 'Two' },
      ],
    })).toThrow('Duplicate Agent Operations project ID: same');
  });
});

describe('ProjectInventoryService', () => {
  function service(
    repositories = new FakeRepositoryInventoryAdapter(),
    runtimes: AgentRuntimeAdapter = new FakeAgentRuntimeAdapter(),
  ): ProjectInventoryService {
    return new ProjectInventoryService(repositories, runtimes, {
      now: () => new Date(OBSERVED_AT),
    });
  }

  it('combines one project, repository, and available runtime through contracts only', async () => {
    const config: AgentOperationsConfiguration = {
      version: 1,
      projects: [{
        id: 'research',
        name: 'Research',
        repositories: [{ path: '/fixtures/clean' }],
        runtimeAgentIds: ['research/researcher'],
      }],
    };
    expect(await service().listProjects(config, '/ignored')).toEqual([
      expect.objectContaining({
        id: 'research',
        state: 'available',
        observedAt: OBSERVED_AT,
        repositories: [expect.objectContaining({
          configuredPath: '/fixtures/clean',
          state: 'available',
          repository: expect.objectContaining({ branch: 'main', workingTree: 'clean' }),
        })],
        runtimes: [expect.objectContaining({
          agentId: 'research/researcher',
          state: 'available',
          runtime: expect.objectContaining({ provider: 'claude' }),
        })],
      }),
    ]);
  });

  it('supports multiple repositories without requiring runtime associations', async () => {
    const config: AgentOperationsConfiguration = {
      version: 1,
      projects: [{
        id: 'multi',
        name: 'Multiple Repositories',
        repositories: [{ path: '/fixtures/clean' }, { path: '/fixtures/dirty' }],
        runtimeAgentIds: [],
      }],
    };
    const [project] = await service().listProjects(config, '/ignored');
    expect(project.repositories).toHaveLength(2);
    expect(project.runtimes).toEqual([]);
    expect(project.state).toBe('available');
  });

  it('resolves repository paths relative to the configuration directory', async () => {
    const config: AgentOperationsConfiguration = {
      version: 1,
      projects: [{
        id: 'portable',
        name: 'Portable Paths',
        repositories: [{ path: 'clean' }],
        runtimeAgentIds: [],
      }],
    };
    const [project] = await service().listProjects(config, '/fixtures');
    expect(project.repositories[0]).toMatchObject({
      configuredPath: 'clean',
      resolvedPath: '/fixtures/clean',
      state: 'available',
    });
  });

  it('reports unavailable repository and runtime associations without losing the project', async () => {
    const config: AgentOperationsConfiguration = {
      version: 1,
      projects: [{
        id: 'degraded',
        name: 'Degraded Project',
        repositories: [{ path: '/fixtures/unavailable' }],
        runtimeAgentIds: ['operations/missing'],
      }],
    };
    const [project] = await service().listProjects(config, '/ignored');
    expect(project.state).toBe('degraded');
    expect(project.repositories[0].state).toBe('unavailable');
    expect(project.runtimes[0]).toMatchObject({
      agentId: 'operations/missing',
      state: 'unavailable',
      runtime: null,
    });
  });

  it('isolates repository adapter failures so other observations survive', async () => {
    const fixtures = createRepositoryInventoryFixtures();
    const repositoryAdapter = new FakeRepositoryInventoryAdapter(
      fixtures,
      new Map([['/fixtures/broken', 'simulated Git failure']]),
    );
    const config: AgentOperationsConfiguration = {
      version: 1,
      projects: [{
        id: 'partial',
        name: 'Partial Failure',
        repositories: [{ path: '/fixtures/broken' }, { path: '/fixtures/clean' }],
        runtimeAgentIds: ['research/researcher'],
      }],
    };
    const [project] = await service(repositoryAdapter).listProjects(config, '/ignored');
    expect(project.state).toBe('degraded');
    expect(project.repositories[0]).toMatchObject({ state: 'unavailable', repository: null });
    expect(project.repositories[1].state).toBe('available');
    expect(project.runtimes[0].state).toBe('available');
  });

  it('turns runtime inventory failure into unavailable associations without losing repositories', async () => {
    const failingRuntime: AgentRuntimeAdapter = {
      listAgents: async () => { throw new Error('runtime offline'); },
      getAgent: async () => null,
      getHealth: async () => ({
        state: 'unavailable',
        observedAt: OBSERVED_AT,
        agentCount: 0,
      }),
    };
    const config: AgentOperationsConfiguration = {
      version: 1,
      projects: [{
        id: 'runtime-failure',
        name: 'Runtime Failure',
        repositories: [{ path: '/fixtures/clean' }],
        runtimeAgentIds: ['research/researcher'],
      }],
    };
    const [project] = await service(new FakeRepositoryInventoryAdapter(), failingRuntime)
      .listProjects(config, '/ignored');
    expect(project.repositories[0].state).toBe('available');
    expect(project.runtimes[0].reason).toContain('Runtime inventory failed: runtime offline');
    expect(project.state).toBe('degraded');
  });
});
