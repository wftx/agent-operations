import { describe, expect, it, vi } from 'vitest';
import type {
  OperatorApplication,
  OperatorJobDetail,
  OperatorProjectOption,
  InputApplication,
} from '../src/index.js';
import { OrchestratorToolApplicationService } from '../src/index.js';

const TIME = '2026-08-31T12:00:00.000Z';
const PROJECT: OperatorProjectOption = {
  project: { id: 'project:duck-face', name: 'Duck Face Event Co.', createdAt: TIME, updatedAt: TIME },
  repositories: [{
    id: 'remote:github.com/example/duck-face',
    identityKind: 'remote',
    name: 'duck-face',
    canonicalRemote: 'github.com/example/duck-face',
    createdAt: TIME,
    updatedAt: TIME,
  }],
  runtimeAgentIds: ['agent-operations/rehearsal'],
  runnable: true,
};

describe('OrchestratorToolApplicationService', () => {
  it('lists and resolves Projects through the read-only Operator application boundary', async () => {
    const operator = fakeOperator();
    const tools = new OrchestratorToolApplicationService(operator);

    const list = await tools.execute({ name: 'ao.projects.list', arguments: {} });
    const get = await tools.execute({ name: 'ao.projects.get', arguments: { projectId: PROJECT.project.id } });

    expect(list).toMatchObject({ ok: true, relatedJobIds: [] });
    expect(list.data).toEqual([expect.objectContaining({ projectId: PROJECT.project.id, name: PROJECT.project.name })]);
    expect(get.data).toEqual(expect.objectContaining({ projectId: PROJECT.project.id }));
    expect(operator.runOperatorJob).not.toHaveBeenCalled();
  });

  it('creates a Job only through runOperatorJob and returns a structured Job link', async () => {
    const operator = fakeOperator();
    const tools = new OrchestratorToolApplicationService(operator);
    const result = await tools.execute({
      name: 'ao.jobs.create',
      arguments: {
        projectId: PROJECT.project.id,
        title: 'Inspect Mirror X image wiring',
        task: 'Inspect the Mirror X page and report whether the local image is wired correctly.',
        acceptanceCriteria: 'Verify the page source and local optimized asset reference.',
        executionMode: 'repository-read-only',
        reviewerRequired: true,
        maxWorkerAttempts: 2,
      },
    });

    expect(operator.runOperatorJob).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT.project.id,
      repositoryId: PROJECT.repositories[0]!.id,
      title: 'Inspect Mirror X image wiring',
      executionMode: 'repository-read-only',
    }));
    expect(result).toEqual({
      ok: true,
      data: { jobId: 'job:created', status: 'pending', link: '/jobs/job%3Acreated' },
      relatedJobIds: ['job:created'],
    });
  });

  it('rejects an unknown Project and attempts to weaken fixed review budgets', async () => {
    const operator = fakeOperator();
    const tools = new OrchestratorToolApplicationService(operator);
    const unknown = await tools.execute({
      name: 'ao.jobs.create',
      arguments: validCreate({ projectId: 'project:missing' }),
    });
    const weakened = await tools.execute({
      name: 'ao.jobs.create',
      arguments: validCreate({ maxWorkerAttempts: 3, reviewerRequired: false }),
    });

    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(weakened).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(operator.runOperatorJob).not.toHaveBeenCalled();
  });

  it('derives Job status from current AO truth', async () => {
    const operator = fakeOperator();
    const tools = new OrchestratorToolApplicationService(operator);
    const result = await tools.execute({ name: 'ao.jobs.status', arguments: { jobId: 'job:created' } });

    expect(operator.getJobDetail).toHaveBeenCalledWith('job:created');
    expect(result).toMatchObject({
      ok: true,
      data: { jobId: 'job:created', state: 'Needs Me', needsHuman: true },
      relatedJobIds: ['job:created'],
    });
  });

  it('lists Input metadata and attaches exact Input IDs to Job creation', async () => {
    const operator = fakeOperator();
    const inputs = fakeInputs();
    const tools = new OrchestratorToolApplicationService(operator, inputs);
    const listed = await tools.execute({ name: 'ao.inputs.list', arguments: { projectId: PROJECT.project.id } });
    const created = await tools.execute({
      name: 'ao.jobs.create',
      arguments: validCreate({ inputIds: ['input:brief'] }),
    });
    expect(listed).toMatchObject({ ok: true, data: [{ id: 'input:brief', displayName: 'brief.pdf' }] });
    expect(operator.runOperatorJob).toHaveBeenCalledWith(expect.objectContaining({ inputIds: ['input:brief'] }));
    expect(created.ok).toBe(true);
  });

  it('returns bounded Input metadata without exposing its physical storage reference', async () => {
    const tools = new OrchestratorToolApplicationService(fakeOperator(), fakeInputs());
    const result = await tools.execute({ name: 'ao.inputs.get', arguments: { inputId: 'input:brief' } });

    expect(result).toMatchObject({ ok: true, data: { id: 'input:brief', sha256: 'a'.repeat(64) } });
    expect(result.data).not.toHaveProperty('storageReference');
    expect(result.data).not.toHaveProperty('path');
  });
});

function validCreate(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT.project.id,
    title: 'Inspect Mirror X',
    task: 'Inspect Mirror X.',
    acceptanceCriteria: 'Report the source truth.',
    executionMode: 'repository-read-only',
    reviewerRequired: true,
    maxWorkerAttempts: 2,
    ...overrides,
  };
}

function fakeOperator(): OperatorApplication {
  const detail = {
    summary: {
      job: { id: 'job:created', projectId: PROJECT.project.id, title: 'Inspect Mirror X', description: 'Inspect.', status: 'ready' },
      orchestrationState: 'Needs Me',
      currentStage: 'Needs Me',
      needsHuman: true,
      latestReviewDecision: 'ESCALATE',
    },
    acceptanceCriteria: 'Report the source truth.',
  } as unknown as OperatorJobDetail;
  return {
    startRunner() {},
    listProjects: vi.fn(async () => [PROJECT]),
    getRuntimeStatus: vi.fn(),
    startRuntime: vi.fn(),
    previewTask: vi.fn(),
    runOperatorJob: vi.fn(async () => ({ jobId: 'job:created', status: 'pending' as const, startedAt: TIME })),
    waitForRun: vi.fn(),
    provideGuidanceAndContinue: vi.fn(),
    authorizeOneMoreWorkerAttempt: vi.fn(),
    reconcileTimedOutExecution: vi.fn(),
    cancelEscalatedJob: vi.fn(),
    listJobs: vi.fn(async () => []),
    getJobDetail: vi.fn(async () => detail),
  };
}

function fakeInputs(): InputApplication {
  const metadata = {
    id: 'input:brief', displayName: 'brief.pdf', mimeType: 'application/pdf', byteSize: 42,
    sha256: 'a'.repeat(64), sourceType: 'uploaded-file' as const, projectId: PROJECT.project.id, createdAt: TIME,
  };
  return {
    createUploadedInput: vi.fn(), createUrlInput: vi.fn(), readInput: vi.fn(), associateWithConversation: vi.fn(),
    getInput: vi.fn(async () => metadata), listInputs: vi.fn(async () => [metadata]),
  };
}
