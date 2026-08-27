import { describe, expect, it } from 'vitest';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  InMemoryAgentOperationsStateStore,
} from '../../agent-operations-contracts/src/index.js';
import {
  REPOSITORY_REHEARSAL_CHECKOUT,
  REPOSITORY_REHEARSAL_ID,
  REPOSITORY_REHEARSAL_POLICY,
  RepositoryRehearsalOperations,
  repositoryRehearsalInstruction,
} from '../src/index.js';

const TIME = '2026-08-26T18:00:00.000Z';
const INSTALLATION_ID = 'installation:41a0c98f-fbb0-4da2-af23-48027df4497d';
const RUNTIME_ID = 'agent-operations/rehearsal';

function runtimes() {
  return new FakeAgentRuntimeAdapter([{
    id: RUNTIME_ID,
    name: 'rehearsal',
    organization: 'agent-operations',
    provider: 'codex',
    enabled: true,
    configured: true,
    capabilities: [
      'session-resume',
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
}

function repositories(id = REPOSITORY_REHEARSAL_ID) {
  return new FakeRepositoryInventoryAdapter([{
    id,
    identityKind: id.startsWith('remote:') ? 'remote' : 'local',
    name: 'agent-operations',
    checkoutPath: REPOSITORY_REHEARSAL_CHECKOUT,
    repositoryRoot: REPOSITORY_REHEARSAL_CHECKOUT,
    availability: 'available',
    branch: 'main',
    detachedHead: false,
    headCommit: '1111111111111111111111111111111111111111',
    workingTree: 'dirty',
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
}

describe('RepositoryRehearsalOperations', () => {
  it('prepares one dispatchable read-only repository Plan without a Dispatch', async () => {
    const store = new InMemoryAgentOperationsStateStore({
      installation: { id: INSTALLATION_ID, createdAt: TIME },
    });
    const runtime = (await runtimes().getAgent(RUNTIME_ID))!;
    const prepared = await new RepositoryRehearsalOperations(
      store,
      repositories(),
      runtimes(),
      {
        now: () => new Date(TIME),
        jobIdFactory: () => 'job:repository-rehearsal',
        attemptIdFactory: () => 'attempt:repository-rehearsal',
        planIdFactory: () => 'plan:repository-rehearsal',
      },
    ).prepare(runtime);

    expect(prepared.plan).toMatchObject({
      repositoryId: REPOSITORY_REHEARSAL_ID,
      installationId: INSTALLATION_ID,
      requestedPolicy: REPOSITORY_REHEARSAL_POLICY,
      input: { instruction: repositoryRehearsalInstruction() },
    });
    expect(prepared.preflight).toMatchObject({
      dispatchable: true,
      executionContext: { workingDirectory: REPOSITORY_REHEARSAL_CHECKOUT },
      effectivePolicy: REPOSITORY_REHEARSAL_POLICY,
    });
    expect(prepared.preflight.status).toBe('warning');
    expect(await store.getExecutionDispatchForPlan(prepared.plan.id)).toBeNull();
  });

  it('refuses to create durable work for a mismatched repository identity', async () => {
    const store = new InMemoryAgentOperationsStateStore({
      installation: { id: INSTALLATION_ID, createdAt: TIME },
    });
    const runtime = (await runtimes().getAgent(RUNTIME_ID))!;
    await expect(new RepositoryRehearsalOperations(
      store,
      repositories('remote:github.com/other/repository'),
      runtimes(),
    ).prepare(runtime)).rejects.toThrow('Repository identity mismatch');
    expect(await store.listProjects()).toEqual([]);
  });
});
