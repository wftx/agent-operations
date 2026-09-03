import { describe, expect, it } from 'vitest';
import {
  InMemoryAgentOperationsStateStore,
  createExecutionDispatchIdempotencyKey,
} from '../../agent-operations-contracts/src/index.js';
import { JobLifecycleService } from '../../agent-operations-core/src/index.js';
import { DailyDriverMetricsService } from '../src/index.js';

const time = '2026-09-02T12:00:00.000Z';
const projectId = 'project:metrics';
const runtimeId = 'agent-operations/rehearsal';

describe('DailyDriverMetricsService', () => {
  it('counts submissions, revisions, recoveries, and human work once from durable truth', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    await store.applyProjectConfiguration({
      project: { id: projectId, name: 'Metrics', createdAt: time, updatedAt: time },
      repositories: [], checkoutBindings: [], runtimeAgentIds: [runtimeId],
    });
    const lifecycle = new JobLifecycleService(store, { now: () => new Date(time) });
    const autonomous = await lifecycle.createJob({ projectId, title: 'Autonomous' });
    await lifecycle.markJobReady(autonomous.id);
    const autonomousWorker = await lifecycle.startAttempt((await lifecycle.createAttempt(autonomous.id, {
      runtimeAgentId: runtimeId, executionRole: 'worker',
    })).id);
    await lifecycle.completeAttempt(autonomousWorker.id, 'Autonomous bounded result');
    await lifecycle.completeJob(autonomous.id);

    const guided = await lifecycle.createJob({ projectId, title: 'Guided' });
    await lifecycle.markJobReady(guided.id);
    const worker = await lifecycle.startAttempt((await lifecycle.createAttempt(guided.id, {
      runtimeAgentId: runtimeId, executionRole: 'worker',
    })).id);
    await store.createExecutionPlan({
      id: 'plan:metrics', attemptId: worker.id, jobId: guided.id, projectId,
      installationId: (await store.getInstallation()).id, runtimeAgentId: runtimeId,
      input: { version: 1, instruction: 'Measure durable work.' },
      requestedPolicy: { version: 1, filesystem: 'read-only', network: 'deny', environment: 'empty' },
      requestedCapabilities: { version: 1, repositoryRead: false },
      jobRevisionAtPreparation: 1, attemptRevisionAtPreparation: 1, createdAt: time,
    });
    const prepared = {
      id: 'dispatch:metrics', executionPlanId: 'plan:metrics', attemptId: worker.id,
      jobId: guided.id, runtimeAgentId: runtimeId,
      idempotencyKey: createExecutionDispatchIdempotencyKey('plan:metrics'),
      status: 'prepared' as const, revision: 0, createdAt: time, updatedAt: time,
    };
    await store.createExecutionDispatch(prepared);
    const submitting = { ...prepared, status: 'submitting' as const, submittedAt: time, revision: 1 };
    await store.saveExecutionDispatchTransition(submitting, 0);
    await store.saveExecutionDispatchTransition({
      ...submitting, status: 'accepted', revision: 2, acceptedAt: time, resolvedAt: time,
      externalReference: 'cortextos:codex-turn:v1:thread:turn',
      effectivePolicy: { version: 1, filesystem: 'read-only', network: 'deny', environment: 'empty' },
      effectiveCapabilities: { version: 1, repositoryRead: false },
    }, 1);
    await lifecycle.completeAttempt(worker.id, 'Worker result');
    const reviewer = await lifecycle.startAttempt((await lifecycle.createAttempt(guided.id, {
      runtimeAgentId: runtimeId, executionRole: 'reviewer',
    })).id);
    await lifecycle.completeAttempt(reviewer.id, 'Reviewer result');
    await store.createAttemptReview({
      id: 'review:metrics', jobId: guided.id, workerAttemptId: worker.id,
      reviewerAttemptId: reviewer.id, reviewerRuntimeAgentId: runtimeId,
      decision: 'REVISION_REQUIRED', summary: 'One correction.', feedback: 'Correct it.', createdAt: time,
    });
    await store.createEscalation({
      id: 'escalation:recovery', jobId: guided.id, attemptId: worker.id,
      reason: 'observation_timeout', summary: 'Late exact result.', createdAt: time,
    });
    await store.resolveEscalation('escalation:recovery', time, 'Reconciled exact result.');
    await store.createEscalation({
      id: 'escalation:human', jobId: guided.id, attemptId: worker.id, reviewId: 'review:metrics',
      reason: 'human_judgment_required', summary: 'Choose one behavior.', createdAt: time,
    });
    await store.createHumanGuidanceAndResolveEscalation({
      id: 'guidance:metrics', jobId: guided.id, escalationId: 'escalation:human',
      instruction: 'Use the documented behavior.', createdAt: time,
    }, time);
    await lifecycle.completeJob(guided.id);

    const metrics = await new DailyDriverMetricsService(store).read();
    expect(metrics).toMatchObject({
      jobsCreated: 2,
      jobsCompleted: 2,
      autonomousCompletions: 1,
      jobsRequiringHumanIntervention: 1,
      humanInterventionCount: 1,
      workerExecutions: 1,
      reviewerRevisionCount: 1,
      reviewerRevisionRate: 1,
      recoveryCount: 1,
      providerSubmissions: 1,
      duplicateDispatchCount: 0,
    });
    expect(metrics.needsMeCategories).toEqual({ machineResolvable: 1, operatorResolvable: 1, terminal: 0 });
  });
});
