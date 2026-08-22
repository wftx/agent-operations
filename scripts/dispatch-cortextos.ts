import { CortextOSExecutionAdapter } from '../packages/cortextos-execution-adapter/src/index.js';
import { CortextOSRuntimeAdapter } from '../packages/cortextos-adapter/src/index.js';
import { GitRepositoryAdapter } from '../packages/git-adapter/src/index.js';
import {
  ExecutionPreflightService,
  ManualDispatchService,
} from '../packages/agent-operations-core/src/index.js';
import { SqliteAgentOperationsStateStore } from '../packages/sqlite-state-adapter/src/index.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const planId = args.find(value => value.startsWith('plan:'));
  const execute = args.includes('--execute');
  const confirmationIndex = args.indexOf('--confirm');
  const confirmed = confirmationIndex >= 0 && args[confirmationIndex + 1] === 'DISPATCH';
  if (!planId || !execute || !confirmed) {
    throw new Error(
      'Real dispatch requires: npm run dev:dispatch-cortextos -- <plan-id> --execute --confirm DISPATCH',
    );
  }

  const store = SqliteAgentOperationsStateStore.open();
  try {
    const runtime = new CortextOSRuntimeAdapter();
    const preflight = new ExecutionPreflightService(store, runtime, new GitRepositoryAdapter());
    const service = new ManualDispatchService(store, preflight, new CortextOSExecutionAdapter());
    const result = await service.dispatchExecutionPlan(planId);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'blocked' || result.status === 'uncertain') process.exitCode = 2;
    else if (result.status === 'rejected') process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
