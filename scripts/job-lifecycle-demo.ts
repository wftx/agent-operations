import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DurableProjectConfiguration } from '../packages/agent-operations-contracts/src/index.js';
import { JobLifecycleService } from '../packages/agent-operations-core/src/index.js';
import { SqliteAgentOperationsStateStore } from '../packages/sqlite-state-adapter/src/index.js';

async function main(): Promise<void> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'agent-operations-job-demo-'));
  const databasePath = join(temporaryDirectory, 'state.db');
  let store: SqliteAgentOperationsStateStore | undefined;
  try {
    store = SqliteAgentOperationsStateStore.open({
      databasePath,
      installationLabel: 'Disposable job lifecycle demo',
    });
    const now = new Date().toISOString();
    const configuration: DurableProjectConfiguration = {
      project: { id: 'demo-project', name: 'Demo Project', createdAt: now, updatedAt: now },
      repositories: [{
        id: 'remote:github.com/example/demo',
        identityKind: 'remote',
        name: 'demo',
        canonicalRemote: 'github.com/example/demo',
        createdAt: now,
        updatedAt: now,
      }],
      checkoutBindings: [],
      runtimeAgentIds: ['engineering/coder', 'engineering/senior-coder'],
    };
    await store.applyProjectConfiguration(configuration);
    const lifecycle = new JobLifecycleService(store);
    const job = await lifecycle.createJob({
      projectId: 'demo-project',
      title: 'Investigate and fix issue #42',
      description: 'Demonstrate durable work history without executing anything.',
      repositoryId: 'remote:github.com/example/demo',
      preferredRuntimeAgentId: 'engineering/coder',
    });
    await lifecycle.markJobReady(job.id);
    const first = await lifecycle.createAttempt(job.id);
    await lifecycle.startAttempt(first.id);
    await lifecycle.failAttempt(first.id, 'Simulated runtime crash');
    const second = await lifecycle.createAttempt(job.id, { runtimeAgentId: 'engineering/senior-coder' });
    await lifecycle.startAttempt(second.id);
    await lifecycle.completeAttempt(second.id, 'Simulated fix implemented');
    await lifecycle.completeJob(job.id);
    await store.close();
    store = undefined;

    const reopened = SqliteAgentOperationsStateStore.open({ databasePath });
    store = reopened;
    const durableDetail = await new JobLifecycleService(reopened).getJobDetail(job.id);
    console.log(JSON.stringify({
      title: 'Agent Operations Durable Job History',
      reopened: true,
      detail: durableDetail,
    }, null, 2));
  } finally {
    if (store) await store.close().catch(() => undefined);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
