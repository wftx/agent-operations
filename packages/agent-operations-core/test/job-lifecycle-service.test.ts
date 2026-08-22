import { describe, expect, it } from 'vitest';
import type { DurableProjectConfiguration } from '../../agent-operations-contracts/src/index.js';
import { InMemoryAgentOperationsStateStore } from '../../agent-operations-contracts/src/index.js';
import { JobLifecycleService } from '../src/index.js';

const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const PROJECT_ID = 'agent-operations';
const CODER = 'engineering/coder';
const SENIOR = 'engineering/senior-coder';
const BASE_TIME = Date.parse('2026-08-01T00:00:00.000Z');

function configuredState(): DurableProjectConfiguration {
  const timestamp = new Date(BASE_TIME).toISOString();
  return {
    project: { id: PROJECT_ID, name: 'Agent Operations', createdAt: timestamp, updatedAt: timestamp },
    repositories: [{
      id: REPOSITORY_ID,
      identityKind: 'remote',
      name: 'agent-operations',
      canonicalRemote: 'github.com/wftx/agent-operations',
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    checkoutBindings: [],
    runtimeAgentIds: [CODER, SENIOR],
  };
}

async function harness(): Promise<{
  store: InMemoryAgentOperationsStateStore;
  service: JobLifecycleService;
}> {
  const store = new InMemoryAgentOperationsStateStore();
  await store.applyProjectConfiguration(configuredState());
  let tick = 0;
  const jobIds = ['job:test-one', 'job:test-two', 'job:test-three'];
  const attemptIds = ['attempt:test-one', 'attempt:test-two', 'attempt:test-three'];
  return {
    store,
    service: new JobLifecycleService(store, {
      now: () => new Date(BASE_TIME + tick++ * 1_000),
      jobIdFactory: () => jobIds.shift()!,
      attemptIdFactory: () => attemptIds.shift()!,
    }),
  };
}

describe('JobLifecycleService', () => {
  it('creates a draft job with optional logical repository and preferred runtime references', async () => {
    const { service } = await harness();
    const job = await service.createJob({
      projectId: PROJECT_ID,
      title: '  Investigate issue #42  ',
      description: '  Find the root cause.  ',
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: CODER,
    });
    expect(job).toEqual({
      id: 'job:test-one',
      projectId: PROJECT_ID,
      title: 'Investigate issue #42',
      description: 'Find the root cause.',
      status: 'draft',
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: CODER,
      revision: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('requires an existing project and current project associations', async () => {
    const { service } = await harness();
    await expect(service.createJob({ projectId: 'missing', title: 'No project' }))
      .rejects.toThrow('Project not found');
    await expect(service.createJob({
      projectId: PROJECT_ID,
      title: 'Wrong repository',
      repositoryId: 'remote:github.com/example/other',
    })).rejects.toThrow('is not associated with project');
    await expect(service.createJob({
      projectId: PROJECT_ID,
      title: 'Wrong runtime',
      preferredRuntimeAgentId: 'engineering/missing',
    })).rejects.toThrow('is not associated with project');
  });

  it('keeps failed attempts separate from the job and permits a later successful attempt', async () => {
    const { service } = await harness();
    const draft = await service.createJob({
      projectId: PROJECT_ID,
      title: 'Fix issue #42',
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: CODER,
    });
    const ready = await service.markJobReady(draft.id);
    expect(ready.status).toBe('ready');

    const first = await service.createAttempt(draft.id);
    expect(first).toMatchObject({ sequence: 1, runtimeAgentId: CODER, status: 'created' });
    const runningFirst = await service.startAttempt(first.id);
    expect((await service.getJobDetail(draft.id)).effectiveStatus).toBe('in_progress');
    const failed = await service.failAttempt(runningFirst.id, 'Runtime crashed');
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'Runtime crashed' });
    expect((await service.getJobDetail(draft.id)).job.status).toBe('ready');

    const second = await service.createAttempt(draft.id, { runtimeAgentId: SENIOR });
    expect(second).toMatchObject({ sequence: 2, runtimeAgentId: SENIOR });
    await service.startAttempt(second.id);
    const completedAttempt = await service.completeAttempt(second.id, 'Fix implemented');
    expect(completedAttempt).toMatchObject({ status: 'completed', summary: 'Fix implemented' });
    const completedJob = await service.completeJob(draft.id);
    expect(completedJob.status).toBe('completed');

    const detail = await service.getJobDetail(draft.id);
    expect(detail.effectiveStatus).toBe('completed');
    expect(detail.attempts).toEqual([
      expect.objectContaining({ sequence: 1, runtimeAgentId: CODER, status: 'failed' }),
      expect.objectContaining({ sequence: 2, runtimeAgentId: SENIOR, status: 'completed' }),
    ]);
  });

  it('rejects invalid job transitions and protects terminal jobs', async () => {
    const { service } = await harness();
    const job = await service.createJob({ projectId: PROJECT_ID, title: 'Lifecycle' });
    await expect(service.completeJob(job.id)).rejects.toThrow('cannot transition from draft');
    await service.markJobReady(job.id);
    await expect(service.markJobReady(job.id)).rejects.toThrow('cannot transition from ready');
    await expect(service.completeJob(job.id)).rejects.toThrow('requires a completed attempt');
    await service.cancelJob(job.id);
    await expect(service.markJobReady(job.id)).rejects.toThrow('cannot transition from cancelled');
    await expect(service.createAttempt(job.id)).rejects.toThrow('must be ready');
  });

  it('enforces one active attempt and requires it to end before cancelling the job', async () => {
    const { service } = await harness();
    const job = await service.createJob({ projectId: PROJECT_ID, title: 'Cancel safely' });
    await service.markJobReady(job.id);
    const attempt = await service.createAttempt(job.id);
    await expect(service.createAttempt(job.id)).rejects.toThrow('already has an active attempt');
    await expect(service.cancelJob(job.id)).rejects.toThrow('while an attempt is active');
    const cancelledAttempt = await service.cancelAttempt(attempt.id);
    expect(cancelledAttempt.status).toBe('cancelled');
    const cancelledJob = await service.cancelJob(job.id);
    expect(cancelledJob.status).toBe('cancelled');
  });

  it('protects terminal attempts from further transitions', async () => {
    const { service } = await harness();
    const job = await service.createJob({ projectId: PROJECT_ID, title: 'Attempt terminality' });
    await service.markJobReady(job.id);
    const attempt = await service.createAttempt(job.id);
    await service.startAttempt(attempt.id);
    await service.failAttempt(attempt.id, 'Expected failure');
    await expect(service.startAttempt(attempt.id)).rejects.toThrow('cannot transition from failed');
    await expect(service.completeAttempt(attempt.id, 'Too late')).rejects.toThrow('cannot transition from failed');
    await expect(service.cancelAttempt(attempt.id)).rejects.toThrow('cannot transition from failed');
  });
});
