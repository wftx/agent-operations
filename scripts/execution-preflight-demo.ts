import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRuntimeDetail,
  DurableProjectConfiguration,
  RepositorySummary,
} from '../packages/agent-operations-contracts/src/index.js';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  createRepositoryCheckoutBindingId,
} from '../packages/agent-operations-contracts/src/index.js';
import {
  ExecutionPlanningService,
  ExecutionPreflightService,
  JobLifecycleService,
} from '../packages/agent-operations-core/src/index.js';
import { SqliteAgentOperationsStateStore } from '../packages/sqlite-state-adapter/src/index.js';

const INSTALLATION_ID = 'installation:execution-preflight-demo';
const PROJECT_ID = 'demo-project';
const REPOSITORY_ID = 'remote:github.com/example/demo';
const RUNTIME_ID = 'engineering/coder';

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agent-operations-execution-preflight-demo-'));
  const databasePath = join(directory, 'state.db');
  let store: SqliteAgentOperationsStateStore | undefined;
  try {
    store = SqliteAgentOperationsStateStore.open({
      databasePath,
      installationIdFactory: () => INSTALLATION_ID,
      installationLabel: 'Disposable execution preflight demo',
    });
    const now = new Date().toISOString();
    const checkoutPath = join(directory, 'demo-checkout');
    const checkoutBindingId = createRepositoryCheckoutBindingId(INSTALLATION_ID, checkoutPath);
    const configuration: DurableProjectConfiguration = {
      project: { id: PROJECT_ID, name: 'Demo Project', createdAt: now, updatedAt: now },
      repositories: [{
        id: REPOSITORY_ID,
        identityKind: 'remote',
        name: 'demo',
        canonicalRemote: 'github.com/example/demo',
        createdAt: now,
        updatedAt: now,
      }],
      checkoutBindings: [{
        id: checkoutBindingId,
        repositoryId: REPOSITORY_ID,
        installationId: INSTALLATION_ID,
        canonicalPath: checkoutPath,
        availability: 'available',
        firstSeenAt: now,
        lastSeenAt: now,
      }],
      runtimeAgentIds: [RUNTIME_ID],
    };
    await store.applyProjectConfiguration(configuration);

    const lifecycle = new JobLifecycleService(store);
    const job = await lifecycle.createJob({
      projectId: PROJECT_ID,
      title: 'Investigate issue #42',
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: RUNTIME_ID,
    });
    await lifecycle.markJobReady(job.id);
    const attempt = await lifecycle.createAttempt(job.id);
    const plan = await new ExecutionPlanningService(store).prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: 'Investigate the failing test and identify the root cause.',
    });

    const observedRepository: RepositorySummary = {
      id: REPOSITORY_ID,
      identityKind: 'remote',
      name: 'demo',
      checkoutPath,
      repositoryRoot: checkoutPath,
      availability: 'available',
      branch: 'main',
      detachedHead: false,
      headCommit: '1111111111111111111111111111111111111111',
      workingTree: 'clean',
      remotes: [],
      observedAt: now,
    };
    const repositoryAdapter = new FakeRepositoryInventoryAdapter([observedRepository]);
    const runningRuntime = runtimeFixture(now, 'running');
    const ready = await new ExecutionPreflightService(
      store,
      new FakeAgentRuntimeAdapter([runningRuntime]),
      repositoryAdapter,
    ).preflight(plan.id);
    const blocked = await new ExecutionPreflightService(
      store,
      new FakeAgentRuntimeAdapter([runtimeFixture(now, 'stopped')]),
      repositoryAdapter,
    ).preflight(plan.id);

    console.log(JSON.stringify({
      title: 'Agent Operations Execution Planning and Preflight',
      plan,
      ready,
      blocked,
      executionPerformed: false,
      note: 'Phase 8 stops before dispatch.',
    }, null, 2));
  } finally {
    if (store) await store.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
}

function runtimeFixture(observedAt: string, state: 'running' | 'stopped'): AgentRuntimeDetail {
  return {
    id: RUNTIME_ID,
    name: 'coder',
    organization: 'engineering',
    provider: 'codex',
    enabled: true,
    configured: true,
    capabilities: ['session-resume'],
    health: { state },
    observedAt,
  };
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
