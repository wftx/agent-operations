import { describe, expect, it } from 'vitest';
import type {
  DurableProjectConfiguration,
  RepositoryCheckoutBinding,
} from '../../agent-operations-contracts/src/index.js';
import {
  InMemoryAgentOperationsStateStore,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import { ExecutionPlanningService, JobLifecycleService } from '../src/index.js';

const TIME = '2026-08-21T12:00:00.000Z';
const INSTALLATION_ID = 'installation:planning';
const PROJECT_ID = 'agent-operations';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'engineering/coder';

function binding(path: string, repositoryId = REPOSITORY_ID): RepositoryCheckoutBinding {
  return {
    id: createRepositoryCheckoutBindingId(INSTALLATION_ID, path),
    repositoryId,
    installationId: INSTALLATION_ID,
    canonicalPath: path,
    availability: 'available',
    firstSeenAt: TIME,
    lastSeenAt: TIME,
  };
}

function configuration(checkouts: readonly RepositoryCheckoutBinding[] = [binding('/repos/ao')]): DurableProjectConfiguration {
  return {
    project: { id: PROJECT_ID, name: 'Agent Operations', createdAt: TIME, updatedAt: TIME },
    repositories: [{
      id: REPOSITORY_ID,
      identityKind: 'remote',
      name: 'agent-operations',
      canonicalRemote: 'github.com/wftx/agent-operations',
      createdAt: TIME,
      updatedAt: TIME,
    }],
    checkoutBindings: checkouts,
    runtimeAgentIds: [RUNTIME_ID],
  };
}

async function harness(checkouts?: readonly RepositoryCheckoutBinding[]): Promise<{
  store: InMemoryAgentOperationsStateStore;
  lifecycle: JobLifecycleService;
  planning: ExecutionPlanningService;
}> {
  const store = new InMemoryAgentOperationsStateStore({
    installation: { id: INSTALLATION_ID, createdAt: TIME },
  });
  await store.applyProjectConfiguration(configuration(checkouts));
  return {
    store,
    lifecycle: new JobLifecycleService(store, {
      now: () => new Date(TIME),
      jobIdFactory: () => 'job:planning',
      attemptIdFactory: () => 'attempt:planning',
    }),
    planning: new ExecutionPlanningService(store, {
      now: () => new Date(TIME),
      planIdFactory: () => 'plan:planning',
    }),
  };
}

async function readyAttempt(
  lifecycle: JobLifecycleService,
  options: { repository?: boolean; runtime?: boolean } = {},
) {
  const repositoryId = options.repository === false ? undefined : REPOSITORY_ID;
  const runtimeAgentId = options.runtime === false ? undefined : RUNTIME_ID;
  const job = await lifecycle.createJob({
    projectId: PROJECT_ID,
    title: 'Investigate issue #42',
    ...(repositoryId ? { repositoryId } : {}),
    ...(runtimeAgentId ? { preferredRuntimeAgentId: runtimeAgentId } : {}),
  });
  await lifecycle.markJobReady(job.id);
  return lifecycle.createAttempt(job.id);
}

describe('ExecutionPlanningService', () => {
  it('prepares one immutable plan from actual Attempt assignment and captures revisions', async () => {
    const { store, lifecycle, planning } = await harness();
    const attempt = await readyAttempt(lifecycle);
    const plan = await planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: '  Investigate the failing test.  ',
    });
    expect(plan).toEqual({
      id: 'plan:planning',
      attemptId: attempt.id,
      jobId: attempt.jobId,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      runtimeAgentId: RUNTIME_ID,
      repositoryId: REPOSITORY_ID,
      checkoutBindingId: binding('/repos/ao').id,
      input: { version: 1, instruction: 'Investigate the failing test.' },
      jobRevisionAtPreparation: 1,
      attemptRevisionAtPreparation: 0,
      createdAt: TIME,
    });
    expect(await store.getExecutionPlanForAttempt(attempt.id)).toEqual(plan);
    const copy = await store.getExecutionPlan(plan.id);
    (copy!.input as { instruction: string }).instruction = 'mutated';
    expect((await store.getExecutionPlan(plan.id))?.input.instruction).toBe('Investigate the failing test.');
  });

  it('supports repository-free plans without a checkout', async () => {
    const { lifecycle, planning } = await harness();
    const attempt = await readyAttempt(lifecycle, { repository: false });
    const plan = await planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: 'Analyze the durable model.',
    });
    expect(plan.repositoryId).toBeUndefined();
    expect(plan.checkoutBindingId).toBeUndefined();
  });

  it('requires explicit selection when a repository has multiple installation-local checkouts', async () => {
    const first = binding('/repos/ao-one');
    const second = binding('/repos/ao-two');
    const { lifecycle, planning } = await harness([first, second]);
    const attempt = await readyAttempt(lifecycle);
    await expect(planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: 'Inspect.',
    })).rejects.toThrow('multiple checkouts');
    const plan = await planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      checkoutBindingId: second.id,
      instruction: 'Inspect.',
    });
    expect(plan.checkoutBindingId).toBe(second.id);
  });

  it('rejects zero or invalid checkout selection', async () => {
    const noCheckout = await harness([]);
    const attempt = await readyAttempt(noCheckout.lifecycle);
    await expect(noCheckout.planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: 'Inspect.',
    })).rejects.toThrow('has no checkout');

    const selected = await harness([binding('/repos/ao')]);
    const selectedAttempt = await readyAttempt(selected.lifecycle);
    await expect(selected.planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: selectedAttempt.id,
      checkoutBindingId: 'checkout:not-configured',
      instruction: 'Inspect.',
    })).rejects.toThrow('is not configured');
  });

  it('requires ready Job, created Attempt, actual runtime, expected project, and non-empty input', async () => {
    const notReady = await harness();
    const notReadyAttempt = await readyAttempt(notReady.lifecycle);
    const currentJob = (await notReady.store.getJob(notReadyAttempt.jobId))!;
    await notReady.store.saveJobTransition({ ...currentJob, status: 'cancelled', revision: 2 }, 1);
    await expect(notReady.planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: notReadyAttempt.id,
      instruction: 'Inspect.',
    })).rejects.toThrow('must be ready');

    const { lifecycle, planning } = await harness();
    const draft = await lifecycle.createJob({ projectId: PROJECT_ID, title: 'Draft', preferredRuntimeAgentId: RUNTIME_ID });
    await expect(planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: 'attempt:missing',
      instruction: 'Inspect.',
    })).rejects.toThrow('Attempt not found');
    await lifecycle.markJobReady(draft.id);
    const attempt = await lifecycle.createAttempt(draft.id);
    await expect(planning.prepareExecutionPlan({
      projectId: 'wrong-project',
      attemptId: attempt.id,
      instruction: 'Inspect.',
    })).rejects.toThrow('Project not found');
    await lifecycle.startAttempt(attempt.id);
    await expect(planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: 'Inspect.',
    })).rejects.toThrow('must be created');

    const unassigned = await harness();
    const unassignedAttempt = await readyAttempt(unassigned.lifecycle, { repository: false, runtime: false });
    await expect(unassigned.planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: unassignedAttempt.id,
      instruction: 'Inspect.',
    })).rejects.toThrow('requires an actual runtime assignment');

    const blank = await harness();
    const blankAttempt = await readyAttempt(blank.lifecycle);
    await expect(blank.planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: blankAttempt.id,
      instruction: '   ',
    })).rejects.toThrow('Execution instruction is required');
  });

  it('rejects a second plan for one Attempt and exposes no update API', async () => {
    const { store, lifecycle, planning } = await harness();
    const attempt = await readyAttempt(lifecycle);
    await planning.prepareExecutionPlan({ projectId: PROJECT_ID, attemptId: attempt.id, instruction: 'Inspect.' });
    await expect(planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: 'Try again.',
    })).rejects.toThrow('already has an Execution Plan');
    expect('updateExecutionPlan' in store).toBe(false);
    expect('saveExecutionPlanTransition' in store).toBe(false);
  });
});
