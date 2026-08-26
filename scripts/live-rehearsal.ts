import { CortextOSRuntimeAdapter } from '../packages/cortextos-adapter/src/index.js';
import { CortextOSExecutionAdapter } from '../packages/cortextos-execution-adapter/src/index.js';
import { CortextOSExecutionObserver } from '../packages/cortextos-execution-observer/src/index.js';
import {
  CortextOSRehearsalSafetyInspector,
  LIVE_REHEARSAL_CONFIRMATION,
  LiveRehearsalOperations,
  runLiveRehearsalExecution,
  type LiveRehearsalPreview,
} from '../packages/agent-operations-rehearsal/src/index.js';
import { GitRepositoryAdapter } from '../packages/git-adapter/src/index.js';
import { SqliteAgentOperationsStateStore } from '../packages/sqlite-state-adapter/src/index.js';

interface ParsedArguments {
  execute: boolean;
  confirmation?: string;
  confirmSuccessAttemptId?: string;
  confirmFailureAttemptId?: string;
  failureReason?: string;
  completeJobId?: string;
  inspectAttemptId?: string;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const runtime = new CortextOSRuntimeAdapter();
  const safety = new CortextOSRehearsalSafetyInspector();

  if (args.confirmSuccessAttemptId || args.confirmFailureAttemptId
    || args.completeJobId || args.inspectAttemptId) {
    await runPostDispatchAction(args, runtime);
    return;
  }

  let store: SqliteAgentOperationsStateStore | undefined;
  try {
    const result = await runLiveRehearsalExecution({
      execute: args.execute,
      confirmation: args.confirmation,
      runtimes: runtime,
      safetyInspector: safety,
      operationsFactory: async () => {
        store = SqliteAgentOperationsStateStore.open();
        return createOperations(store, runtime);
      },
    });
    printPreview(result.preview);
    if (result.status === 'preview') {
      console.log('\nNo dispatch occurred. To authorize the one live submission:');
      console.log(`npm run dev:live-rehearsal -- --execute --confirm ${LIVE_REHEARSAL_CONFIRMATION}`);
      return;
    }
    if (result.status === 'blocked') {
      console.log(`\nREHEARSAL BLOCKED\n${result.discovery.reason}\nNo dispatch occurred.`);
      return;
    }
    if (!result.run) throw new Error('Live rehearsal returned no durable run detail');
    printRun(result.run);
  } finally {
    if (store) await store.close().catch(() => undefined);
  }
}

async function runPostDispatchAction(
  args: ParsedArguments,
  runtime: CortextOSRuntimeAdapter,
): Promise<void> {
  if (args.inspectAttemptId) {
    const store = SqliteAgentOperationsStateStore.open();
    try {
      const detail = await createOperations(store, runtime).getExecutionDetail(args.inspectAttemptId);
      console.log(JSON.stringify(detail, null, 2));
    } finally {
      await store.close();
    }
    return;
  }
  if (args.confirmation !== LIVE_REHEARSAL_CONFIRMATION) {
    throw new Error(`Post-dispatch mutation requires --confirm ${LIVE_REHEARSAL_CONFIRMATION}`);
  }
  const store = SqliteAgentOperationsStateStore.open();
  try {
    const operations = createOperations(store, runtime);
    if (args.confirmSuccessAttemptId) {
      const detail = await operations.confirmSuccess(args.confirmSuccessAttemptId);
      console.log('Human success confirmation recorded. Job remains separate.');
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    if (args.confirmFailureAttemptId) {
      const detail = await operations.confirmFailure(
        args.confirmFailureAttemptId,
        args.failureReason ?? '',
      );
      console.log('Human failure confirmation recorded. No retry occurred.');
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    if (args.completeJobId) {
      console.log(JSON.stringify(await operations.completeJob(args.completeJobId), null, 2));
    }
  } finally {
    await store.close();
  }
}

function createOperations(
  store: SqliteAgentOperationsStateStore,
  runtime: CortextOSRuntimeAdapter,
): LiveRehearsalOperations {
  return new LiveRehearsalOperations(
    store,
    runtime,
    new GitRepositoryAdapter(),
    new CortextOSExecutionAdapter(),
    new CortextOSExecutionObserver(),
  );
}

function printPreview(preview: LiveRehearsalPreview): void {
  console.log(preview.title);
  console.log(`\nRuntime agent:\n  ${preview.runtimeAgentId ?? 'none safely available'}`);
  console.log(`Provider:\n  ${preview.provider ?? 'none'}`);
  console.log('\nRepository:\n  none');
  console.log(`\nInstruction:\n${indent(preview.instruction)}`);
  console.log(`\nWill contact real CortextOS runtime:\n  ${preview.willContactRealRuntime ? 'yes' : 'no'}`);
  console.log('\nWill mutate Git:\n  no');
  console.log('\nWill write files through the runtime:\n  instruction explicitly forbids it');
  console.log('\nRequested runtime policy:');
  console.log(`  filesystem: ${preview.requestedPolicy.filesystem}`);
  console.log(`  network: ${preview.requestedPolicy.network}`);
  console.log(`  environment: ${preview.requestedPolicy.environment}`);
  console.log(`\nPolicy enforceable:\n  ${preview.policyEnforceable ? 'yes' : 'no'}`);
  console.log('\nEffective runtime policy:');
  console.log(preview.effectivePolicy
    ? `  filesystem: ${preview.effectivePolicy.filesystem}\n  network: ${preview.effectivePolicy.network}\n  environment: ${preview.effectivePolicy.environment}`
    : '  unavailable');
  console.log('\nWill automatically infer success:\n  no');
  console.log('\nOutcome authority:\n  human confirmation');
  console.log(`\nExecution authorized:\n  ${preview.executionAuthorized ? 'true' : 'false'}`);
  console.log(`\nSafety conditions satisfied:\n  ${preview.safetyConditionsSatisfied ? 'true' : 'false'}`);
  console.log(`\nDiscovery:\n  ${preview.discoveryReason}`);
}

function printRun(run: NonNullable<Awaited<ReturnType<typeof runLiveRehearsalExecution>>['run']>): void {
  console.log('\nLIVE REHEARSAL RESULT');
  console.log(`Project: ${run.projectId}`);
  console.log(`Job: ${run.job.id} (${run.job.status})`);
  console.log(`Attempt: ${run.attempt.id} (${run.attempt.status})`);
  console.log(`Plan: ${run.plan.id}`);
  console.log(`Dispatch: ${run.dispatch?.id ?? 'none'} (${run.dispatch?.status ?? 'not created'})`);
  console.log(`Preflight: ${run.preflight.status}`);
  console.log(`Requested policy: ${formatPolicy(run.preflight.requestedPolicy)}`);
  console.log(`Effective policy: ${formatPolicy(run.preflight.effectivePolicy)}`);
  console.log(`Real adapter invoked: ${run.dispatchOutcome.adapterInvoked ? 'yes' : 'no'}`);
  console.log('Automatic retries: 0');
  console.log('Git mutations: 0');
  if (run.executionDetail) {
    console.log(`Runtime evidence: ${run.executionDetail.observations
      .map(item => `${item.kind}/${item.correlation}`).join(', ') || 'none'}`);
  }
  if (run.dispatchOutcome.status === 'accepted' && run.attempt.status === 'running') {
    console.log(`\nAttempt is still running in AO.\nExpected response:\n  AGENT_OPERATIONS_REHEARSAL_OK ${run.nonce}`);
    console.log('\nAfter human verification, confirm success with:');
    console.log(`npm run dev:live-rehearsal -- --confirm-success ${run.attempt.id} --confirm ${LIVE_REHEARSAL_CONFIRMATION}`);
    console.log('\nThen complete the Job separately with:');
    console.log(`npm run dev:live-rehearsal -- --complete-job ${run.job.id} --confirm ${LIVE_REHEARSAL_CONFIRMATION}`);
  }
}

function parseArguments(values: readonly string[]): ParsedArguments {
  const valueAfter = (flag: string): string | undefined => {
    const index = values.indexOf(flag);
    return index >= 0 ? values[index + 1] : undefined;
  };
  return {
    execute: values.includes('--execute'),
    ...(valueAfter('--confirm') ? { confirmation: valueAfter('--confirm') } : {}),
    ...(valueAfter('--confirm-success')
      ? { confirmSuccessAttemptId: valueAfter('--confirm-success') }
      : {}),
    ...(valueAfter('--confirm-failure')
      ? { confirmFailureAttemptId: valueAfter('--confirm-failure') }
      : {}),
    ...(valueAfter('--reason') ? { failureReason: valueAfter('--reason') } : {}),
    ...(valueAfter('--complete-job') ? { completeJobId: valueAfter('--complete-job') } : {}),
    ...(valueAfter('--inspect-attempt') ? { inspectAttemptId: valueAfter('--inspect-attempt') } : {}),
  };
}

function indent(value: string): string {
  return value.split('\n').map(line => `  ${line}`).join('\n');
}

function formatPolicy(policy: LiveRehearsalPreview['effectivePolicy']): string {
  return policy
    ? `filesystem=${policy.filesystem}, network=${policy.network}, environment=${policy.environment}`
    : 'unspecified/unavailable';
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
