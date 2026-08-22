import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DurableProjectConfiguration } from '../packages/agent-operations-contracts/src/index.js';
import {
  FakeAgentRuntimeAdapter,
  FakeRepositoryInventoryAdapter,
  FakeRuntimeExecutionAdapter,
} from '../packages/agent-operations-contracts/src/index.js';
import {
  ExecutionPlanningService,
  ExecutionPreflightService,
  JobLifecycleService,
  ManualDispatchService,
} from '../packages/agent-operations-core/src/index.js';
import { SqliteAgentOperationsStateStore } from '../packages/sqlite-state-adapter/src/index.js';

const PROJECT_ID = 'manual-dispatch-demo';
const RUNTIME_ID = 'engineering/coder';

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agent-operations-manual-dispatch-demo-'));
  const databasePath = join(directory, 'state.db');
  let store: SqliteAgentOperationsStateStore | undefined;
  try {
    store = SqliteAgentOperationsStateStore.open({
      databasePath,
      installationIdFactory: () => 'installation:manual-dispatch-demo',
      installationLabel: 'Disposable manual dispatch demo',
    });
    const now = new Date().toISOString();
    const configuration: DurableProjectConfiguration = {
      project: { id: PROJECT_ID, name: 'Manual Dispatch Demo', createdAt: now, updatedAt: now },
      repositories: [],
      checkoutBindings: [],
      runtimeAgentIds: [RUNTIME_ID],
    };
    await store.applyProjectConfiguration(configuration);

    const jobIds = ['job:demo-accepted', 'job:demo-rejected', 'job:demo-uncertain'];
    const attemptIds = ['attempt:demo-accepted', 'attempt:demo-rejected', 'attempt:demo-uncertain'];
    const planIds = ['plan:demo-accepted', 'plan:demo-rejected', 'plan:demo-uncertain'];
    const lifecycle = new JobLifecycleService(store, {
      jobIdFactory: () => jobIds.shift()!,
      attemptIdFactory: () => attemptIds.shift()!,
    });
    const planning = new ExecutionPlanningService(store, { planIdFactory: () => planIds.shift()! });
    const plans = [];
    for (const label of ['accepted', 'rejected', 'uncertain']) {
      const job = await lifecycle.createJob({
        projectId: PROJECT_ID,
        title: `Demonstrate ${label} manual dispatch`,
        preferredRuntimeAgentId: RUNTIME_ID,
      });
      await lifecycle.markJobReady(job.id);
      const attempt = await lifecycle.createAttempt(job.id);
      plans.push(await planning.prepareExecutionPlan({
        projectId: PROJECT_ID,
        attemptId: attempt.id,
        instruction: `Demonstrate the ${label} result without contacting a real runtime.`,
      }));
    }

    const runtime = new FakeAgentRuntimeAdapter([{
      id: RUNTIME_ID,
      name: 'coder',
      organization: 'engineering',
      provider: 'codex',
      enabled: true,
      configured: true,
      capabilities: [],
      health: { state: 'running' },
      observedAt: now,
    }]);
    const preflight = new ExecutionPreflightService(store, runtime, new FakeRepositoryInventoryAdapter([]));
    const acceptedAdapter = new FakeRuntimeExecutionAdapter({ status: 'accepted', message: 'Fake runtime accepted.' });
    const rejectedAdapter = new FakeRuntimeExecutionAdapter({ status: 'rejected', message: 'Fake runtime rejected.' });
    const uncertainAdapter = new FakeRuntimeExecutionAdapter({ status: 'uncertain', message: 'Fake acknowledgement lost.' });
    const acceptedService = new ManualDispatchService(store, preflight, acceptedAdapter, {
      dispatchIdFactory: () => 'dispatch:demo-accepted',
    });
    const rejectedService = new ManualDispatchService(store, preflight, rejectedAdapter, {
      dispatchIdFactory: () => 'dispatch:demo-rejected',
    });
    const uncertainService = new ManualDispatchService(store, preflight, uncertainAdapter, {
      dispatchIdFactory: () => 'dispatch:demo-uncertain',
    });

    const accepted = await acceptedService.dispatchExecutionPlan(plans[0].id);
    const acceptedRepeated = await acceptedService.dispatchExecutionPlan(plans[0].id);
    const rejected = await rejectedService.dispatchExecutionPlan(plans[1].id);
    const rejectedRepeated = await rejectedService.dispatchExecutionPlan(plans[1].id);
    const uncertain = await uncertainService.dispatchExecutionPlan(plans[2].id);
    const uncertainRepeated = await uncertainService.dispatchExecutionPlan(plans[2].id);

    console.log(JSON.stringify({
      title: 'Agent Operations Manual Dispatch Boundary',
      accepted,
      acceptedRepeated,
      rejected,
      rejectedRepeated,
      uncertain,
      uncertainRepeated,
      adapterCalls: {
        accepted: acceptedAdapter.callCount,
        rejected: rejectedAdapter.callCount,
        uncertain: uncertainAdapter.callCount,
      },
      realRuntimeContacted: false,
      note: 'Every adapter was fake. Repeated calls did not resubmit.',
    }, null, 2));
  } finally {
    if (store) await store.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
