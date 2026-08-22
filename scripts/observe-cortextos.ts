import { ExecutionObservationService } from '../packages/agent-operations-core/src/index.js';
import { CortextOSExecutionObserver } from '../packages/cortextos-execution-observer/src/index.js';
import { SqliteAgentOperationsStateStore } from '../packages/sqlite-state-adapter/src/index.js';

async function main(): Promise<void> {
  const dispatchId = process.argv.slice(2).find(value => value.startsWith('dispatch:'));
  if (!dispatchId) {
    throw new Error('Usage: npm run dev:observe-cortextos -- <dispatch-id>');
  }
  const store = SqliteAgentOperationsStateStore.open();
  try {
    const dispatch = await store.getExecutionDispatch(dispatchId);
    if (!dispatch) throw new Error(`Execution Dispatch not found: ${dispatchId}`);
    const service = new ExecutionObservationService(store, new CortextOSExecutionObserver());
    console.log(JSON.stringify(await service.observeAttemptExecution(dispatch.attemptId), null, 2));
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
