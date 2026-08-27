import { CortextOSRuntimeAdapter } from '../packages/cortextos-adapter/src/index.js';
import { CortextOSExecutionAdapter } from '../packages/cortextos-execution-adapter/src/index.js';
import { CortextOSExecutionObserver } from '../packages/cortextos-execution-observer/src/index.js';
import { GitRepositoryAdapter } from '../packages/git-adapter/src/index.js';
import { OrchestrationService } from '../packages/agent-operations-core/src/index.js';
import { SqliteAgentOperationsStateStore } from '../packages/sqlite-state-adapter/src/index.js';

async function main(): Promise<void> {
  const values = process.argv.slice(2);
  const execute = values.includes('--execute');
  const confirmationIndex = values.indexOf('--confirm');
  const confirmation = confirmationIndex >= 0 ? values[confirmationIndex + 1] : undefined;
  const supportedFlags = new Set(['--execute', '--confirm']);
  for (const value of values) {
    if (value.startsWith('--') && !supportedFlags.has(value)) {
      throw new Error(`Unsupported orchestration option: ${value}`);
    }
  }
  const positionals = values.filter((value, index) => {
    if (value === '--execute') return false;
    if (value === '--confirm') return false;
    if (index > 0 && values[index - 1] === '--confirm') return false;
    return true;
  });
  const jobId = positionals[0]?.trim();
  if (!jobId || positionals.length !== 1) {
    throw new Error(
      'Usage: npm run dev:orchestrate -- <job-id> [--execute --confirm ORCHESTRATE]',
    );
  }
  if (execute && confirmation !== 'ORCHESTRATE') {
    throw new Error('Live orchestration requires --execute --confirm ORCHESTRATE');
  }
  if (!execute && confirmation !== undefined) {
    throw new Error('--confirm is valid only with --execute');
  }

  const store = SqliteAgentOperationsStateStore.open();
  try {
    const service = new OrchestrationService(
      store,
      new CortextOSRuntimeAdapter(),
      new GitRepositoryAdapter(),
      new CortextOSExecutionAdapter(),
      new CortextOSExecutionObserver(),
    );
    const preview = await service.preview(jobId);
    console.log('ORCHESTRATION PLAN');
    console.log(`\nJob:\n  ${preview.job.id}\n  ${preview.job.title}`);
    console.log(`\nRepository:\n  ${preview.repositoryId ?? 'none'}`);
    console.log(`\nWorker:\n  ${preview.workerRuntimeAgentId ?? 'unconfigured'} (worker role)`);
    console.log(`\nReviewer:\n  ${preview.reviewerRuntimeAgentId ?? 'unconfigured'} (reviewer role)`);
    console.log('\nWorker policy:\n  read-only / deny / empty\n  repository-read enabled');
    console.log('\nReviewer policy:\n  read-only / deny / empty\n  repository-read enabled');
    console.log(`\nMax worker attempts:\n  ${preview.maxWorkerAttempts}`);
    console.log(`\nReviewer passes per attempt:\n  ${preview.maxReviewerPassesPerAttempt}`);
    console.log(`\nAuto-complete allowed:\n  ${preview.autoCompleteAllowed ? 'yes, read-only reviewed Job' : 'no'}`);
    console.log('\nEscalation:\n  enabled');
    console.log(`\nEligible:\n  ${preview.eligible ? 'yes' : 'no'}`);
    if (preview.findings.length) {
      console.log(`\nFindings:\n${preview.findings.map(finding => `  - ${finding}`).join('\n')}`);
    }
    console.log(`\nExecution authorized:\n  ${execute ? 'true' : 'false'}`);
    console.log('\nDispatches created by preview:\n  0');
    if (!execute) return;
    if (!preview.eligible) {
      throw new Error('Live orchestration is blocked because the preview is not eligible');
    }

    const result = await service.runJob(jobId);
    console.log('\nORCHESTRATION RESULT');
    console.log(`\nFinal decision:\n  ${result.finalDecision}`);
    console.log(`\nJob status:\n  ${result.job.status}`);
    console.log(`\nWorker Attempts:\n  ${result.workerAttempts.length}`);
    console.log(`\nReviewer Attempts:\n  ${result.reviewerAttempts.length}`);
    console.log(`\nReviews:\n  ${result.reviews.length}`);
    console.log(`\nNeeds human:\n  ${result.needsHuman ? 'yes' : 'no'}`);
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
