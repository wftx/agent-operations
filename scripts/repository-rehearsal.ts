import { CortextOSRuntimeAdapter } from '../packages/cortextos-adapter/src/index.js';
import {
  CortextOSRehearsalSafetyInspector,
  REPOSITORY_REHEARSAL_CHECKOUT,
  REPOSITORY_REHEARSAL_CONFIRMATION,
  RepositoryRehearsalOperations,
  discoverLiveRehearsalCandidate,
} from '../packages/agent-operations-rehearsal/src/index.js';
import { GitRepositoryAdapter } from '../packages/git-adapter/src/index.js';
import { SqliteAgentOperationsStateStore } from '../packages/sqlite-state-adapter/src/index.js';

async function main(): Promise<void> {
  const values = process.argv.slice(2);
  if (values.includes('--execute')) throw new Error('Repository preview does not support --execute');
  const prepare = values.includes('--prepare');
  const confirmation = valueAfter(values, '--confirm');
  if (!prepare || confirmation !== REPOSITORY_REHEARSAL_CONFIRMATION) {
    throw new Error(`Repository preview preparation requires --prepare --confirm ${REPOSITORY_REHEARSAL_CONFIRMATION}`);
  }

  const runtimes = new CortextOSRuntimeAdapter();
  const discovery = await discoverLiveRehearsalCandidate(
    runtimes,
    new CortextOSRehearsalSafetyInspector(),
  );
  if (!discovery.candidate) throw new Error(`No safe runtime candidate: ${discovery.reason}`);

  const store = SqliteAgentOperationsStateStore.open();
  try {
    const prepared = await new RepositoryRehearsalOperations(
      store,
      new GitRepositoryAdapter(),
      runtimes,
    ).prepare(discovery.candidate.runtime);
    console.log('AGENT OPERATIONS REPOSITORY REHEARSAL PREVIEW');
    console.log(`Repository:\n  ${prepared.plan.repositoryId}`);
    console.log(`Checkout:\n  ${prepared.repository.repositoryRoot}`);
    console.log(`Repository identity:\n  ${prepared.preflight.checks.some(item => item.code === 'repository-identity-valid' && item.severity === 'pass') ? 'verified' : 'not verified'}`);
    console.log(`Execution CWD:\n  ${prepared.preflight.executionContext?.workingDirectory ?? 'unavailable'}`);
    console.log(`CWD binding:\n  ${prepared.preflight.checks.some(item => item.code === 'runtime-checkout-match' && item.severity === 'pass') ? 'verified' : 'not verified'}`);
    console.log(`Requested policy:\n  ${formatPolicy(prepared.preflight.requestedPolicy)}`);
    console.log(`Effective policy:\n  ${formatPolicy(prepared.preflight.effectivePolicy)}`);
    console.log(`Repository capability:\n  ${prepared.preflight.effectiveCapabilities?.repositoryRead ? 'read-only reader' : 'unavailable'}`);
    console.log(`Reader root:\n  ${prepared.preflight.executionContext?.repositoryReadRoot ?? 'unavailable'}`);
    console.log('Arbitrary shell:\n  disabled');
    console.log('Writes:\n  unavailable');
    console.log(`Exact correlation:\n  ${prepared.preflight.checks.some(item => item.code === 'runtime-exact-turn-correlation-supported') ? 'available' : 'unavailable'}`);
    console.log(`Dispatchable:\n  ${prepared.preflight.dispatchable ? 'yes' : 'no'}`);
    console.log('Execution authorized:\n  false');
    console.log('Repository-bound live Dispatches performed:\n  0');
    console.log('Additional live repository Dispatches:\n  0');
    console.log(`Plan:\n  ${prepared.plan.id}`);
    console.log(`Instruction:\n  ${prepared.plan.input.instruction}`);
    if (prepared.repository.repositoryRoot !== REPOSITORY_REHEARSAL_CHECKOUT) {
      throw new Error('Canonical repository checkout differs from the configured rehearsal target');
    }
  } finally {
    await store.close();
  }
}

function valueAfter(values: readonly string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}

function formatPolicy(policy: { filesystem: string; network: string; environment: string } | null): string {
  return policy ? `${policy.filesystem} / ${policy.network} / ${policy.environment}` : 'unavailable';
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
