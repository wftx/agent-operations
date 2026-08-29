import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_READ_EXECUTION_CAPABILITIES,
  RESTRICTED_TEXT_EXECUTION_POLICY,
  createExecutionDispatchIdempotencyKey,
  createRepositoryCheckoutBindingId,
  InMemoryAgentOperationsStateStore,
} from '../../agent-operations-contracts/src/index.js';
import {
  ExecutionPlanningService,
  JobLifecycleService,
  type OrchestrationPreview,
  type OrchestrationReadModel,
  type TimedOutExecutionReconciliation,
} from '../../agent-operations-core/src/index.js';
import {
  OPERATOR_READ_ONLY_DEFAULTS,
  OPERATOR_ISOLATED_WRITE_DEFAULTS,
  OperatorApplicationService,
  type OperatorNotificationEvent,
  type OperatorNotifier,
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
    private readonly result: 'PASS' | 'ESCALATED' | readonly ('PASS' | 'ESCALATED')[] = 'PASS',
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

  async reconcileTimedOutExecution(): Promise<TimedOutExecutionReconciliation> {
    throw new Error('No timed-out execution is configured for this test');
  }

  async runJob(jobId: string): Promise<OrchestrationReadModel> {
    this.runCalls += 1;
    const selected = Array.isArray(this.result)
      ? this.result[Math.min(this.runCalls - 1, this.result.length - 1)]
      : this.result;
    if (this.gate) await this.gate;
    const lifecycle = new JobLifecycleService(this.store, { now: () => new Date(TIME) });
    const workerCreated = await lifecycle.createAttempt(jobId, { executionRole: 'worker' });
    const workerRunning = await lifecycle.startAttempt(workerCreated.id);
    const worker = await lifecycle.completeAttempt(workerRunning.id, `Bounded Worker result ${this.runCalls} recorded.`);
    const reviewerCreated = await lifecycle.createAttempt(jobId, { executionRole: 'reviewer' });
    const reviewerRunning = await lifecycle.startAttempt(reviewerCreated.id);
    const reviewer = await lifecycle.completeAttempt(reviewerRunning.id, `Reviewer decision: ${selected}.`);
    const review = {
      id: `review:${jobId}:${this.runCalls}`,
      jobId,
      workerAttemptId: worker.id,
      reviewerAttemptId: reviewer.id,
      reviewerRuntimeAgentId: RUNTIME_ID,
      decision: selected === 'PASS' ? 'PASS' as const : 'ESCALATE' as const,
      summary: selected === 'PASS' ? 'Acceptance criteria satisfied.' : 'Human judgment is required.',
      createdAt: TIME,
    };
    await this.store.createAttemptReview(review);
    if (selected === 'ESCALATED') {
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
    const job = selected === 'PASS'
      ? await lifecycle.completeJob(jobId)
      : (await this.store.getJob(jobId))!;
    return {
      job,
      workerAttempts: [worker],
      reviewerAttempts: [reviewer],
      reviews: [review],
      escalations: await this.store.listEscalations(jobId),
      needsHuman: selected === 'ESCALATED',
      finalDecision: selected,
    };
  }
}

class RecordingNotifier implements OperatorNotifier {
  readonly events: OperatorNotificationEvent[] = [];
  constructor(private readonly failure?: string) {}

  async notify(event: OperatorNotificationEvent) {
    this.events.push(event);
    if (this.failure) throw new Error(this.failure);
    return { status: 'sent' as const };
  }
}

class LateCompletionOrchestration implements OperatorOrchestrationPort {
  reconcileCalls = 0;
  runCalls = 0;

  constructor(private readonly store: InMemoryAgentOperationsStateStore) {}

  async preview(): Promise<OrchestrationPreview> {
    throw new Error('Preview is not used by the late reconciliation fixture');
  }

  async reconcileTimedOutExecution(escalationId: string): Promise<TimedOutExecutionReconciliation> {
    this.reconcileCalls += 1;
    const escalation = (await this.store.getEscalation(escalationId))!;
    const attempt = (await this.store.getAttempt(escalation.attemptId!))!;
    const plan = (await this.store.getExecutionPlanForAttempt(attempt.id))!;
    const dispatch = (await this.store.getExecutionDispatchForPlan(plan.id))!;
    await new JobLifecycleService(this.store, { now: () => new Date(TIME) })
      .completeAttempt(attempt.id, 'Late exact Worker completion was imported.');
    return {
      status: 'completed', jobId: attempt.jobId, attemptId: attempt.id,
      dispatchId: dispatch.id, resultText: 'Bounded late Worker result.',
      inserted: 1, duplicates: 0, ignoredUnrelated: 0, alreadyReconciled: false,
    };
  }

  async runJob(jobId: string): Promise<OrchestrationReadModel> {
    this.runCalls += 1;
    const lifecycle = new JobLifecycleService(this.store, { now: () => new Date(TIME) });
    const job = await lifecycle.completeJob(jobId);
    return {
      job,
      workerAttempts: (await this.store.listAttemptsForJob(jobId))
        .filter(attempt => attempt.executionRole === 'worker'),
      reviewerAttempts: [],
      reviews: [],
      escalations: await this.store.listEscalations(jobId),
      needsHuman: false,
      finalDecision: 'PASS',
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

  it('previews isolated write authority without creating a Job or workspace', async () => {
    const store = await configuredStore();
    const orchestration = new FakeOrchestration(store);
    const application = new OperatorApplicationService(store, orchestration);
    const preview = await application.previewTask({
      ...INPUT,
      executionMode: 'repository-write-isolated',
    });
    expect(preview).toMatchObject({
      executionMode: 'repository-write-isolated',
      defaults: OPERATOR_ISOLATED_WRITE_DEFAULTS,
      executionAuthorized: false,
    });
    expect(await store.listJobs()).toEqual([]);
    expect(await store.listRepositoryWorkspaces()).toEqual([]);
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
    expect(orchestration.previewCalls).toBe(0);
    expect(orchestration.runCalls).toBe(1);
    expect((await application.listJobs('done'))[0]).toMatchObject({
      orchestrationState: 'Completed',
      workerAttemptCount: 1,
      workerExecutionCount: 0,
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

    expect((await application.listJobs()).find(item => item.job.id === draft.id)?.orchestrationState).toBe('Accepted');
    const running = await application.listJobs('running');
    expect(running.find(item => item.job.id === ready.id)).toMatchObject({
      job: { id: ready.id },
      currentRole: 'reviewer',
      orchestrationState: 'Preparing Reviewer',
    });
    expect(running.find(item => item.job.id === workerReady.id)).toMatchObject({
      currentRole: 'worker',
      orchestrationState: 'Preparing Worker',
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
    expect(first.status).toBe('pending');
    await expect(application.runOperatorJob({ ...INPUT, task: 'A second Job' }))
      .rejects.toThrow('already running');
    release();
    expect((await application.waitForRun(first.jobId)).status).toBe('done');
    expect(await store.listJobs()).toHaveLength(1);
  });

  it('persists guidance, resolves Needs Me, and continues only through a fresh Worker Attempt', async () => {
    const store = await configuredStore();
    const notifier = new RecordingNotifier();
    const orchestration = new FakeOrchestration(store, ['ESCALATED', 'PASS']);
    const application = new OperatorApplicationService(store, orchestration, {
      now: () => new Date(TIME), notifier,
    });
    const started = await application.runOperatorJob(INPUT);
    expect((await application.waitForRun(started.jobId)).status).toBe('needs-human');
    const escalation = (await store.listEscalations(started.jobId, true))[0];

    const continued = await application.provideGuidanceAndContinue(
      escalation.id,
      'Use the documented persistence contract as authoritative.',
    );
    expect(continued.status).toBe('pending');
    expect((await application.waitForRun(started.jobId)).status).toBe('done');

    const attempts = await store.listAttemptsForJob(started.jobId);
    expect(attempts.filter(attempt => attempt.executionRole === 'worker')).toHaveLength(2);
    expect(await store.getEscalation(escalation.id)).toMatchObject({ resolvedAt: TIME });
    expect(await store.listHumanGuidance(started.jobId)).toEqual([
      expect.objectContaining({
        escalationId: escalation.id,
        instruction: 'Use the documented persistence contract as authoritative.',
      }),
    ]);
    expect(notifier.events.map(event => event.kind)).toEqual(['needs_human', 'job_completed']);
    application.startRunner();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(notifier.events.map(event => event.kind)).toEqual(['needs_human', 'job_completed']);
  });

  it('does not charge two preflight-only policy blocks and resumes through a fresh Worker Attempt', async () => {
    const store = await configuredStore();
    const lifecycle = new JobLifecycleService(store, {
      now: () => new Date(TIME),
      jobIdFactory: () => 'job:policy-blocked',
    });
    const draft = await lifecycle.createJob({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: RUNTIME_ID,
      title: 'Resume after runtime recovery',
      description: INPUT.task,
      acceptanceCriteria: INPUT.acceptanceCriteria,
      automaticReadOnlyCompletion: true,
    });
    const job = await lifecycle.markJobReady(draft.id);
    const firstBlockedAttempt = await lifecycle.createAttempt(job.id, {
      runtimeAgentId: RUNTIME_ID,
      executionRole: 'worker',
    });
    const planning = new ExecutionPlanningService(store, {
      now: () => new Date(TIME),
      planIdFactory: (() => { let sequence = 0; return () => `plan:policy-blocked:${++sequence}`; })(),
    });
    const firstPlan = await planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: firstBlockedAttempt.id,
      instruction: 'Read the repository without mutation.',
      requestedPolicy: RESTRICTED_TEXT_EXECUTION_POLICY,
      requestedCapabilities: REPOSITORY_READ_EXECUTION_CAPABILITIES,
    });
    await lifecycle.cancelAttempt(firstBlockedAttempt.id);
    const secondBlockedAttempt = await lifecycle.createAttempt(job.id, {
      runtimeAgentId: RUNTIME_ID,
      executionRole: 'worker',
    });
    const secondPlan = await planning.prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: secondBlockedAttempt.id,
      instruction: 'Read the repository without mutation.',
      requestedPolicy: RESTRICTED_TEXT_EXECUTION_POLICY,
      requestedCapabilities: REPOSITORY_READ_EXECUTION_CAPABILITIES,
    });
    await lifecycle.cancelAttempt(secondBlockedAttempt.id);
    await store.createEscalation({
      id: 'escalation:policy-blocked',
      jobId: job.id,
      attemptId: secondBlockedAttempt.id,
      reason: 'policy_blocked',
      summary: 'Runtime was unavailable before Dispatch.',
      createdAt: TIME,
    });
    const pending = {
      id: 'operator-run:policy-blocked', jobId: job.id, status: 'pending' as const, revision: 0,
      createdAt: TIME, updatedAt: TIME,
    };
    await store.createOperatorRun(pending);
    await store.saveOperatorRunTransition({
      ...pending, status: 'running', revision: 1, startedAt: TIME,
    }, 0);
    await store.saveOperatorRunTransition({
      ...pending, status: 'needs_human', revision: 2, startedAt: TIME, finishedAt: TIME,
    }, 1);
    const application = new OperatorApplicationService(
      store,
      new FakeOrchestration(store),
      { now: () => new Date(TIME) },
    );

    const blockedDetail = await application.getJobDetail(job.id);
    expect(blockedDetail.summary).toMatchObject({
      workerAttemptCount: 2,
      workerExecutionCount: 0,
    });
    expect(blockedDetail.workerAttempts.map(story => story.attempt.id))
      .toEqual([firstBlockedAttempt.id, secondBlockedAttempt.id]);
    expect(blockedDetail.escalationActions['escalation:policy-blocked'])
      .toEqual(['provide-guidance', 'cancel-job']);
    const continued = await application.provideGuidanceAndContinue(
      'escalation:policy-blocked',
      'The runtime is now available. Continue under the original read-only policy.',
    );
    expect(continued.status).toBe('pending');
    expect((await application.waitForRun(job.id)).status).toBe('done');

    const attempts = await store.listAttemptsForJob(job.id);
    expect(attempts.filter(attempt => attempt.executionRole === 'worker')).toHaveLength(3);
    expect(attempts[0]).toMatchObject({ id: firstBlockedAttempt.id, status: 'cancelled' });
    expect(attempts[1]).toMatchObject({ id: secondBlockedAttempt.id, status: 'cancelled' });
    expect(await store.getExecutionPlan(firstPlan.id)).toMatchObject({
      id: firstPlan.id,
      attemptId: firstBlockedAttempt.id,
    });
    expect(await store.getExecutionPlan(secondPlan.id)).toMatchObject({
      id: secondPlan.id,
      attemptId: secondBlockedAttempt.id,
    });
    expect(await store.getExecutionDispatchForPlan(firstPlan.id)).toBeNull();
    expect(await store.getExecutionDispatchForPlan(secondPlan.id)).toBeNull();
    expect(await store.getEscalation('escalation:policy-blocked')).toMatchObject({ resolvedAt: TIME });
  });

  it('cancels an eligible Needs Me Job while preserving resolved escalation history', async () => {
    const store = await configuredStore();
    const application = new OperatorApplicationService(
      store,
      new FakeOrchestration(store, 'ESCALATED'),
      { now: () => new Date(TIME) },
    );
    const started = await application.runOperatorJob(INPUT);
    expect((await application.waitForRun(started.jobId)).status).toBe('needs-human');
    const escalation = (await store.listEscalations(started.jobId, true))[0];

    const cancelled = await application.cancelEscalatedJob(escalation.id);

    expect(cancelled.status).toBe('cancelled');
    expect(await store.getJob(started.jobId)).toMatchObject({ status: 'cancelled' });
    expect(await store.getEscalation(escalation.id)).toMatchObject({ resolvedAt: TIME });
    expect(await application.listJobs('needs-human')).toEqual([]);
    expect((await application.getJobDetail(started.jobId)).escalationActions[escalation.id]).toEqual([]);
    await expect(application.provideGuidanceAndContinue(escalation.id, 'Too late.'))
      .rejects.toThrow('already resolved');
  });

  it.each([
    ['observation timeout', 'observation_timeout' as const, 'Observation timed out.'],
    [
      'known oversized observation failure',
      'runtime_failure' as const,
      'Runtime observation failed: Observation text exceeds 4000 characters',
    ],
  ])('atomically resolves a late exact %s, resumes the same run, and is idempotent', async (
    _label,
    reason,
    summary,
  ) => {
    const store = await configuredStore();
    const lifecycle = new JobLifecycleService(store, {
      now: () => new Date(TIME), jobIdFactory: () => 'job:late',
    });
    const job = await lifecycle.markJobReady((await lifecycle.createJob({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: RUNTIME_ID,
      title: 'Late execution reconciliation',
      description: INPUT.task,
      acceptanceCriteria: INPUT.acceptanceCriteria,
      automaticReadOnlyCompletion: true,
    })).id);
    const attempt = await lifecycle.createAttempt(job.id, {
      runtimeAgentId: RUNTIME_ID, executionRole: 'worker',
    });
    const plan = await new ExecutionPlanningService(store, {
      now: () => new Date(TIME), planIdFactory: () => 'plan:late',
    }).prepareExecutionPlan({
      projectId: PROJECT_ID,
      attemptId: attempt.id,
      instruction: 'Read the repository.',
      requestedPolicy: RESTRICTED_TEXT_EXECUTION_POLICY,
      requestedCapabilities: REPOSITORY_READ_EXECUTION_CAPABILITIES,
    });
    await lifecycle.startAttempt(attempt.id);
    const prepared = {
      id: 'dispatch:late', executionPlanId: plan.id, attemptId: attempt.id, jobId: job.id,
      runtimeAgentId: RUNTIME_ID, idempotencyKey: createExecutionDispatchIdempotencyKey(plan.id),
      status: 'prepared' as const, revision: 0, createdAt: TIME, updatedAt: TIME,
    };
    await store.createExecutionDispatch(prepared);
    const submitting = {
      ...prepared, status: 'submitting' as const, revision: 1, submittedAt: TIME,
    };
    await store.saveExecutionDispatchTransition(submitting, 0);
    await store.saveExecutionDispatchTransition({
      ...submitting,
      status: 'accepted',
      revision: 2,
      effectivePolicy: RESTRICTED_TEXT_EXECUTION_POLICY,
      effectiveCapabilities: REPOSITORY_READ_EXECUTION_CAPABILITIES,
      externalReference: 'cortextos:codex-turn:v1:thread:turn',
      acceptedAt: TIME,
      resolvedAt: TIME,
    }, 1);
    await store.createEscalation({
      id: 'escalation:late', jobId: job.id, attemptId: attempt.id,
      reason, summary, createdAt: TIME,
    });
    const run = {
      id: 'operator-run:late', jobId: job.id, status: 'pending' as const, revision: 0,
      createdAt: TIME, updatedAt: TIME,
    };
    await store.createOperatorRun(run);
    await store.saveOperatorRunTransition({ ...run, status: 'running', revision: 1, startedAt: TIME }, 0);
    await store.saveOperatorRunTransition({
      ...run, status: 'needs_human', revision: 2, startedAt: TIME, finishedAt: TIME,
    }, 1);
    const orchestration = new LateCompletionOrchestration(store);
    const application = new OperatorApplicationService(store, orchestration, { now: () => new Date(TIME) });

    expect((await application.getJobDetail(job.id)).escalationActions['escalation:late'])
      .toEqual(['reconcile-execution']);
    await application.reconcileTimedOutExecution('escalation:late');
    expect((await application.waitForRun(job.id)).status).toBe('done');
    expect(await store.getEscalation('escalation:late')).toMatchObject({
      resolvedAt: TIME,
      resolutionSummary: expect.stringContaining('no task was resent'),
    });
    expect((await store.listAttemptsForJob(job.id)).filter(value => value.executionRole === 'worker'))
      .toHaveLength(1);
    expect(orchestration.reconcileCalls).toBe(1);
    expect(orchestration.runCalls).toBe(1);

    expect((await application.reconcileTimedOutExecution('escalation:late')).status).toBe('done');
    expect(orchestration.reconcileCalls).toBe(1);
    expect(orchestration.runCalls).toBe(1);
  });

  it('records notification failure without changing successful Job truth', async () => {
    const store = await configuredStore();
    const notifier = new RecordingNotifier('Telegram offline');
    const application = new OperatorApplicationService(store, new FakeOrchestration(store), {
      now: () => new Date(TIME), notifier,
    });
    const started = await application.runOperatorJob(INPUT);
    expect((await application.waitForRun(started.jobId)).status).toBe('done');
    expect(await store.getJob(started.jobId)).toMatchObject({ status: 'completed' });
    expect(await store.listOperatorNotificationDeliveries(started.jobId)).toEqual([
      expect.objectContaining({ status: 'failed', message: 'Telegram offline' }),
    ]);
  });

  it('records Needs Me notification failure without resolving or changing the escalation', async () => {
    const store = await configuredStore();
    const application = new OperatorApplicationService(
      store,
      new FakeOrchestration(store, 'ESCALATED'),
      { now: () => new Date(TIME), notifier: new RecordingNotifier('Telegram offline') },
    );
    const started = await application.runOperatorJob(INPUT);
    expect((await application.waitForRun(started.jobId)).status).toBe('needs-human');

    expect(await store.getJob(started.jobId)).toMatchObject({ status: 'ready' });
    expect(await store.listEscalations(started.jobId, true)).toHaveLength(1);
    expect(await store.listOperatorNotificationDeliveries(started.jobId)).toEqual([
      expect.objectContaining({ kind: 'needs_human', status: 'failed', message: 'Telegram offline' }),
    ]);
  });

  it('does not duplicate a claimed completion notification after application restart', async () => {
    const store = await configuredStore();
    const firstNotifier = new RecordingNotifier();
    const first = new OperatorApplicationService(store, new FakeOrchestration(store), {
      now: () => new Date(TIME), notifier: firstNotifier,
    });
    const started = await first.runOperatorJob(INPUT);
    expect((await first.waitForRun(started.jobId)).status).toBe('done');
    expect(firstNotifier.events.map(event => event.kind)).toEqual(['job_completed']);

    const restartedNotifier = new RecordingNotifier();
    const restarted = new OperatorApplicationService(store, new FakeOrchestration(store), {
      now: () => new Date(TIME), notifier: restartedNotifier,
    });
    restarted.startRunner();
    expect((await restarted.waitForRun(started.jobId)).status).toBe('done');
    expect(restartedNotifier.events).toEqual([]);
    expect(await store.listOperatorNotificationDeliveries(started.jobId)).toHaveLength(1);
  });

  it('resumes a durably accepted pending Operator Run when a new application instance starts', async () => {
    const store = await configuredStore();
    const lifecycle = new JobLifecycleService(store, {
      now: () => new Date(TIME),
      jobIdFactory: () => 'job:restart',
    });
    const draft = await lifecycle.createJob({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: RUNTIME_ID,
      title: 'Resume after restart',
      description: 'Resume from durable Operator state.',
      acceptanceCriteria: 'Complete through Reviewer PASS.',
      automaticReadOnlyCompletion: true,
    });
    const job = await lifecycle.markJobReady(draft.id);
    await store.createOperatorRun({
      id: 'operator-run:restart', jobId: job.id, status: 'pending', revision: 0,
      createdAt: TIME, updatedAt: TIME,
    });

    const orchestration = new FakeOrchestration(store);
    const restarted = new OperatorApplicationService(store, orchestration, { now: () => new Date(TIME) });
    restarted.startRunner();
    expect((await restarted.waitForRun(job.id)).status).toBe('done');
    expect(orchestration.runCalls).toBe(1);
    expect(await store.getJob(job.id)).toMatchObject({ status: 'completed' });
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
