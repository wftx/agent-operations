import { describe, expect, it } from 'vitest';
import {
  createRepositoryCheckoutBindingId,
  InMemoryAgentOperationsStateStore,
} from '../../agent-operations-contracts/src/index.js';
import {
  JobLifecycleService,
  type OrchestrationPreview,
  type OrchestrationReadModel,
} from '../../agent-operations-core/src/index.js';
import {
  OPERATOR_READ_ONLY_DEFAULTS,
  OperatorApplicationService,
  type OperatorOrchestrationPort,
  type OperatorTaskInput,
} from '../src/index.js';

const TIME = '2026-08-27T06:00:00.000Z';
const PROJECT_ID = 'project:ao';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'agent-operations/rehearsal';
const INPUT: OperatorTaskInput = {
  projectId: PROJECT_ID,
  repositoryId: REPOSITORY_ID,
  task: 'Find where execution reviews are stored.',
  acceptanceCriteria: 'Identify the authoritative file and all three review decisions.',
};

class FakeOrchestration implements OperatorOrchestrationPort {
  previewCalls = 0;
  runCalls = 0;

  constructor(
    private readonly store: InMemoryAgentOperationsStateStore,
    private readonly result: 'PASS' | 'ESCALATED' = 'PASS',
    private readonly gate?: Promise<void>,
  ) {}

  async preview(jobId: string): Promise<OrchestrationPreview> {
    this.previewCalls += 1;
    const job = (await this.store.getJob(jobId))!;
    return {
      job,
      repositoryId: job.repositoryId ?? null,
      workerRuntimeAgentId: RUNTIME_ID,
      reviewerRuntimeAgentId: RUNTIME_ID,
      policy: OPERATOR_READ_ONLY_DEFAULTS.policy,
      repositoryRead: true,
      maxWorkerAttempts: 2,
      maxReviewerPassesPerAttempt: 1,
      autoCompleteAllowed: true,
      escalationEnabled: true,
      executionAuthorized: false,
      eligible: true,
      findings: [],
    };
  }

  async runJob(jobId: string): Promise<OrchestrationReadModel> {
    this.runCalls += 1;
    if (this.gate) await this.gate;
    const lifecycle = new JobLifecycleService(this.store, { now: () => new Date(TIME) });
    const workerCreated = await lifecycle.createAttempt(jobId, { executionRole: 'worker' });
    const workerRunning = await lifecycle.startAttempt(workerCreated.id);
    const worker = await lifecycle.completeAttempt(workerRunning.id, 'Bounded Worker result recorded.');
    const reviewerCreated = await lifecycle.createAttempt(jobId, { executionRole: 'reviewer' });
    const reviewerRunning = await lifecycle.startAttempt(reviewerCreated.id);
    const reviewer = await lifecycle.completeAttempt(reviewerRunning.id, `Reviewer decision: ${this.result}.`);
    const review = {
      id: `review:${jobId}`,
      jobId,
      workerAttemptId: worker.id,
      reviewerAttemptId: reviewer.id,
      reviewerRuntimeAgentId: RUNTIME_ID,
      decision: this.result === 'PASS' ? 'PASS' as const : 'ESCALATE' as const,
      summary: this.result === 'PASS' ? 'Acceptance criteria satisfied.' : 'Human judgment is required.',
      createdAt: TIME,
    };
    await this.store.createAttemptReview(review);
    if (this.result === 'ESCALATED') {
      await this.store.createEscalation({
        id: `escalation:${jobId}`,
        jobId,
        attemptId: worker.id,
        reviewId: review.id,
        reason: 'human_judgment_required',
        summary: 'Choose whether to revise the task.',
        createdAt: TIME,
      });
    }
    const job = this.result === 'PASS'
      ? await lifecycle.completeJob(jobId)
      : (await this.store.getJob(jobId))!;
    return {
      job,
      workerAttempts: [worker],
      reviewerAttempts: [reviewer],
      reviews: [review],
      escalations: await this.store.listEscalations(jobId),
      needsHuman: this.result === 'ESCALATED',
      finalDecision: this.result,
    };
  }
}

describe('OperatorApplicationService', () => {
  it('validates task intake and exposes immutable read-only defaults without mutation', async () => {
    const store = await configuredStore();
    const orchestration = new FakeOrchestration(store);
    const application = new OperatorApplicationService(store, orchestration);

    const preview = await application.previewTask(INPUT);

    expect(preview).toMatchObject({
      project: { id: PROJECT_ID },
      repository: { id: REPOSITORY_ID },
      runtimeAgentId: RUNTIME_ID,
      defaults: {
        policy: { filesystem: 'read-only', network: 'deny', environment: 'empty' },
        capabilities: { repositoryRead: true },
        maxWorkerAttempts: 2,
        reviewerEnabled: true,
        automaticReadOnlyCompletion: true,
      },
      executionAuthorized: false,
    });
    expect(await store.listJobs()).toEqual([]);
    expect(orchestration.previewCalls).toBe(0);
    expect(orchestration.runCalls).toBe(0);
  });

  it.each([
    [{ ...INPUT, task: '' }, 'Task is required'],
    [{ ...INPUT, acceptanceCriteria: '' }, 'Acceptance criteria is required'],
    [{ ...INPUT, projectId: 'project:missing' }, 'Project not found'],
    [{ ...INPUT, repositoryId: 'remote:github.com/other/repo' }, 'is not configured'],
  ])('rejects invalid intake before creating a Job', async (input, expected) => {
    const store = await configuredStore();
    const application = new OperatorApplicationService(store, new FakeOrchestration(store));
    await expect(application.runOperatorJob(input)).rejects.toThrow(expected);
    expect(await store.listJobs()).toEqual([]);
  });

  it('creates one ready Job with safe defaults and invokes fake orchestration only on Run', async () => {
    const store = await configuredStore();
    const orchestration = new FakeOrchestration(store);
    const application = new OperatorApplicationService(store, orchestration, { now: () => new Date(TIME) });

    const started = await application.runOperatorJob(INPUT);
    const finished = await application.waitForRun(started.jobId);
    const job = (await store.getJob(started.jobId))!;

    expect(finished.status).toBe('done');
    expect(job).toMatchObject({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      description: INPUT.task,
      acceptanceCriteria: INPUT.acceptanceCriteria,
      preferredRuntimeAgentId: RUNTIME_ID,
      automaticReadOnlyCompletion: true,
      status: 'completed',
    });
    expect(orchestration.previewCalls).toBe(1);
    expect(orchestration.runCalls).toBe(1);
    expect((await application.listJobs('done'))[0]).toMatchObject({
      orchestrationState: 'Done',
      workerAttemptCount: 1,
      latestReviewDecision: 'PASS',
      needsHuman: false,
    });
  });

  it('surfaces durable escalations in Needs Me and excludes them from Done', async () => {
    const store = await configuredStore();
    const application = new OperatorApplicationService(store, new FakeOrchestration(store, 'ESCALATED'), { now: () => new Date(TIME) });
    const started = await application.runOperatorJob(INPUT);
    expect((await application.waitForRun(started.jobId)).status).toBe('needs-human');

    const needsMe = await application.listJobs('needs-human');
    expect(needsMe).toHaveLength(1);
    expect(needsMe[0]).toMatchObject({ orchestrationState: 'Needs Me', needsHuman: true });
    expect(await application.listJobs('done')).toEqual([]);
    const detail = await application.getJobDetail(started.jobId);
    expect(detail.escalations[0]).toMatchObject({
      reason: 'human_judgment_required',
      summary: 'Choose whether to revise the task.',
    });
    expect(detail.finalReview).toMatchObject({ decision: 'ESCALATE' });
  });

  it('reports new and running durable Jobs without invoking orchestration', async () => {
    const store = await configuredStore();
    const orchestration = new FakeOrchestration(store);
    const lifecycle = new JobLifecycleService(store, { now: () => new Date(TIME) });
    const draft = await lifecycle.createJob({ projectId: PROJECT_ID, title: 'New Job' });
    const ready = await lifecycle.markJobReady((await lifecycle.createJob({ projectId: PROJECT_ID, title: 'Running Job' })).id);
    const attempt = await lifecycle.createAttempt(ready.id, { executionRole: 'reviewer' });
    await lifecycle.startAttempt(attempt.id);
    const workerReady = await lifecycle.markJobReady((await lifecycle.createJob({ projectId: PROJECT_ID, title: 'Worker Job' })).id);
    const workerAttempt = await lifecycle.createAttempt(workerReady.id, { executionRole: 'worker' });
    await lifecycle.startAttempt(workerAttempt.id);
    const application = new OperatorApplicationService(store, orchestration);

    expect((await application.listJobs()).find(item => item.job.id === draft.id)?.orchestrationState).toBe('New');
    const running = await application.listJobs('running');
    expect(running.find(item => item.job.id === ready.id)).toMatchObject({
      job: { id: ready.id },
      currentRole: 'reviewer',
      orchestrationState: 'Reviewer running',
    });
    expect(running.find(item => item.job.id === workerReady.id)).toMatchObject({
      currentRole: 'worker',
      orchestrationState: 'Worker running',
    });
    expect(orchestration.previewCalls).toBe(0);
    expect(orchestration.runCalls).toBe(0);
  });

  it('refuses a second operator run while the first orchestration is active', async () => {
    const store = await configuredStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const application = new OperatorApplicationService(
      store,
      new FakeOrchestration(store, 'PASS', gate),
      { now: () => new Date(TIME) },
    );

    const first = await application.runOperatorJob(INPUT);
    await expect(application.runOperatorJob({ ...INPUT, task: 'A second Job' }))
      .rejects.toThrow('already running');
    release();
    expect((await application.waitForRun(first.jobId)).status).toBe('done');
    expect(await store.listJobs()).toHaveLength(1);
  });
});

async function configuredStore(): Promise<InMemoryAgentOperationsStateStore> {
  const store = new InMemoryAgentOperationsStateStore({
    installation: { id: 'installation:test', createdAt: TIME },
  });
  await store.applyProjectConfiguration({
    project: { id: PROJECT_ID, name: 'Agent Operations', createdAt: TIME, updatedAt: TIME },
    repositories: [{
      id: REPOSITORY_ID,
      identityKind: 'remote',
      name: 'agent-operations',
      canonicalRemote: 'github.com/wftx/agent-operations',
      createdAt: TIME,
      updatedAt: TIME,
    }],
    checkoutBindings: [{
      id: createRepositoryCheckoutBindingId('installation:test', '/tmp/agent-operations-test'),
      repositoryId: REPOSITORY_ID,
      installationId: 'installation:test',
      canonicalPath: '/tmp/agent-operations-test',
      availability: 'available',
      firstSeenAt: TIME,
      lastSeenAt: TIME,
    }],
    runtimeAgentIds: [RUNTIME_ID],
  });
  return store;
}
