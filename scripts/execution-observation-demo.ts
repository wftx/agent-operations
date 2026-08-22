import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DurableExecutionDispatch,
  DurableProjectConfiguration,
  RuntimeExecutionObservation,
} from '../packages/agent-operations-contracts/src/index.js';
import {
  FakeRuntimeExecutionObservationAdapter,
  createExecutionDispatchIdempotencyKey,
} from '../packages/agent-operations-contracts/src/index.js';
import {
  ExecutionObservationService,
  ExecutionOutcomeService,
  ExecutionPlanningService,
  JobLifecycleService,
} from '../packages/agent-operations-core/src/index.js';
import { SqliteAgentOperationsStateStore } from '../packages/sqlite-state-adapter/src/index.js';

const PROJECT_ID = 'execution-observation-demo';
const RUNTIME_ID = 'engineering/coder';

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agent-operations-observation-demo-'));
  let store: SqliteAgentOperationsStateStore | undefined;
  try {
    const now = new Date().toISOString();
    store = SqliteAgentOperationsStateStore.open({
      databasePath: join(directory, 'state.db'),
      installationIdFactory: () => 'installation:execution-observation-demo',
      installationLabel: 'Disposable observation demo',
    });
    const configuration: DurableProjectConfiguration = {
      project: { id: PROJECT_ID, name: 'Execution Observation Demo', createdAt: now, updatedAt: now },
      repositories: [],
      checkoutBindings: [],
      runtimeAgentIds: [RUNTIME_ID],
    };
    await store.applyProjectConfiguration(configuration);

    const jobIds = ['job:exact', 'job:idle', 'job:crash'];
    const attemptIds = ['attempt:exact', 'attempt:idle', 'attempt:crash'];
    const planIds = ['plan:exact', 'plan:idle', 'plan:crash'];
    const lifecycle = new JobLifecycleService(store, {
      jobIdFactory: () => jobIds.shift()!,
      attemptIdFactory: () => attemptIds.shift()!,
    });
    const planning = new ExecutionPlanningService(store, { planIdFactory: () => planIds.shift()! });
    const attempts = [];
    for (const label of ['exact completion', 'weak idle', 'runtime crash']) {
      const job = await lifecycle.createJob({
        projectId: PROJECT_ID,
        title: `Demonstrate ${label}`,
        preferredRuntimeAgentId: RUNTIME_ID,
      });
      await lifecycle.markJobReady(job.id);
      const attempt = await lifecycle.createAttempt(job.id);
      const plan = await planning.prepareExecutionPlan({
        projectId: PROJECT_ID,
        attemptId: attempt.id,
        instruction: `Demonstrate ${label} without a real runtime.`,
      });
      await acceptAndStart(store, lifecycle, plan, now);
      attempts.push(attempt.id);
    }

    const exactAdapter = new FakeRuntimeExecutionObservationAdapter([fixture(
      'turn:demo',
      'turn-completed',
      'exact',
      now,
      'dispatch:exact',
    )]);
    const exactObservations = new ExecutionObservationService(store, exactAdapter);
    const exactBefore = await exactObservations.observeAttemptExecution(attempts[0]);
    const exactAfter = await new ExecutionOutcomeService(store, exactObservations, {
      decisionIdFactory: () => 'outcome:exact',
    }).confirmAttemptSucceeded(attempts[0], {
      summary: 'Human confirmed that the exact completed turn satisfied this Attempt.',
    });

    const idleAdapter = new FakeRuntimeExecutionObservationAdapter([fixture(
      'idle:demo',
      'runtime-idle',
      'agent-level',
      now,
    )]);
    const idleObservations = new ExecutionObservationService(store, idleAdapter);
    const idle = await idleObservations.observeAttemptExecution(attempts[1]);

    const crashAdapter = new FakeRuntimeExecutionObservationAdapter([fixture(
      'crash:demo',
      'runtime-crashed',
      'agent-level',
      now,
    )]);
    const crashObservations = new ExecutionObservationService(store, crashAdapter);
    const crashBefore = await crashObservations.observeAttemptExecution(attempts[2]);
    const crashAfter = await new ExecutionOutcomeService(store, crashObservations, {
      decisionIdFactory: () => 'outcome:crash',
    }).confirmAttemptFailed(attempts[2], {
      reason: 'Human confirmed the observed runtime crash ended this Attempt.',
      evidenceObservationId: crashBefore.detail.observations[0].id,
    });

    console.log(JSON.stringify({
      title: 'Agent Operations Execution Observation and Outcome Authority',
      exactCompletion: {
        observed: summarize(exactBefore.detail),
        afterHumanConfirmation: summarize(exactAfter),
      },
      weakIdle: {
        observed: summarize(idle.detail),
        completionInferred: false,
      },
      runtimeCrash: {
        observed: summarize(crashBefore.detail),
        afterHumanConfirmation: summarize(crashAfter),
      },
      realRuntimeContacted: false,
      note: 'All runtime observations were deterministic fakes.',
    }, null, 2));
  } finally {
    if (store) await store.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function acceptAndStart(
  store: SqliteAgentOperationsStateStore,
  lifecycle: JobLifecycleService,
  plan: { id: string; attemptId: string; jobId: string; runtimeAgentId: string },
  timestamp: string,
): Promise<void> {
  const suffix = plan.id.split(':')[1];
  const prepared: DurableExecutionDispatch = {
    id: `dispatch:${suffix}`,
    executionPlanId: plan.id,
    attemptId: plan.attemptId,
    jobId: plan.jobId,
    runtimeAgentId: plan.runtimeAgentId,
    idempotencyKey: createExecutionDispatchIdempotencyKey(plan.id),
    status: 'prepared',
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.createExecutionDispatch(prepared);
  const submitting: DurableExecutionDispatch = {
    ...prepared,
    status: 'submitting',
    submittedAt: timestamp,
    revision: 1,
  };
  await store.saveExecutionDispatchTransition(submitting, 0);
  await store.saveExecutionDispatchTransition({
    ...submitting,
    status: 'accepted',
    acceptedAt: timestamp,
    resolvedAt: timestamp,
    revision: 2,
  }, 1);
  await lifecycle.startAttempt(plan.attemptId);
}

function fixture(
  sourceEventId: string,
  kind: RuntimeExecutionObservation['kind'],
  correlation: RuntimeExecutionObservation['correlation'],
  observedAt: string,
  correlatedDispatchId?: string,
): RuntimeExecutionObservation {
  return {
    source: 'fake-observer',
    sourceEventId,
    kind,
    correlation,
    observedAt,
    ...(correlatedDispatchId ? { correlatedDispatchId } : {}),
    ...(kind === 'turn-completed' ? { outputSummary: 'Bounded fake output summary.' } : {}),
  };
}

function summarize(detail: {
  state: string;
  exactCompletionEvidence: boolean;
  outcome: string;
  attempt: { status: string };
  observations: ReadonlyArray<{ kind: string; correlation: string }>;
}) {
  return {
    state: detail.state,
    attemptStatus: detail.attempt.status,
    exactCompletionEvidence: detail.exactCompletionEvidence,
    outcome: detail.outcome,
    observations: detail.observations.map(item => ({ kind: item.kind, correlation: item.correlation })),
  };
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
