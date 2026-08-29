import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { DurableProjectConfiguration } from '../../agent-operations-contracts/src/index.js';
import {
  REPOSITORY_READ_EXECUTION_CAPABILITIES,
  RESTRICTED_TEXT_EXECUTION_POLICY,
  createExecutionDispatchIdempotencyKey,
  createExecutionObservationId,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import {
  ExecutionPlanningService,
  JobLifecycleService,
  readWorkerExecutionBudget,
} from '../../agent-operations-core/src/index.js';
import { SqliteAgentOperationsStateStore } from '../src/index.js';

const TIME = '2026-08-27T04:00:00.000Z';
const INSTALLATION_ID = 'installation:orchestration-persistence';
const PROJECT_ID = 'orchestration-persistence';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'agent-operations/rehearsal';
const CHECKOUT = '/fixtures/agent-operations';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ao-orchestration-persistence-'));
  directories.push(directory);
  return join(directory, 'state.db');
}

function open(path: string, targetSchemaVersion?: number): SqliteAgentOperationsStateStore {
  return SqliteAgentOperationsStateStore.open({
    databasePath: path,
    installationIdFactory: () => INSTALLATION_ID,
    now: () => new Date(TIME),
    ...(targetSchemaVersion ? { targetSchemaVersion } : {}),
  });
}

function configuration(): DurableProjectConfiguration {
  return {
    project: { id: PROJECT_ID, name: 'Orchestration Persistence', createdAt: TIME, updatedAt: TIME },
    repositories: [{
      id: REPOSITORY_ID,
      identityKind: 'remote',
      name: 'agent-operations',
      canonicalRemote: 'github.com/wftx/agent-operations',
      createdAt: TIME,
      updatedAt: TIME,
    }],
    checkoutBindings: [{
      id: createRepositoryCheckoutBindingId(INSTALLATION_ID, CHECKOUT),
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      canonicalPath: CHECKOUT,
      availability: 'available',
      firstSeenAt: TIME,
      lastSeenAt: TIME,
    }],
    runtimeAgentIds: [RUNTIME_ID],
  };
}

describe('SQLite orchestration persistence', () => {
  it('reopens historical cancelled preflight Attempts without rewriting or charging them', async () => {
    const path = databasePath();
    const initial = open(path);
    await initial.applyProjectConfiguration(configuration());
    const lifecycle = new JobLifecycleService(initial, {
      now: () => new Date(TIME),
      jobIdFactory: () => 'job:cancelled-preflight-history',
      attemptIdFactory: (() => {
        let sequence = 0;
        return () => `attempt:cancelled-preflight:${++sequence}`;
      })(),
    });
    const draft = await lifecycle.createJob({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: RUNTIME_ID,
      title: 'Historical preflight failures',
      acceptanceCriteria: 'Read-only result required.',
      automaticReadOnlyCompletion: true,
    });
    await lifecycle.markJobReady(draft.id);
    const planning = new ExecutionPlanningService(initial, {
      now: () => new Date(TIME),
      planIdFactory: (() => {
        let sequence = 0;
        return () => `plan:cancelled-preflight:${++sequence}`;
      })(),
    });
    for (let index = 0; index < 2; index += 1) {
      const attempt = await lifecycle.createAttempt(draft.id, {
        runtimeAgentId: RUNTIME_ID,
        executionRole: 'worker',
      });
      await planning.prepareExecutionPlan({
        projectId: PROJECT_ID,
        attemptId: attempt.id,
        instruction: 'Read only.',
        requestedPolicy: RESTRICTED_TEXT_EXECUTION_POLICY,
        requestedCapabilities: REPOSITORY_READ_EXECUTION_CAPABILITIES,
      });
      await lifecycle.cancelAttempt(attempt.id);
    }
    const originalAttempts = await initial.listAttemptsForJob(draft.id);
    await initial.close();

    const reopened = open(path);
    const reopenedAttempts = await reopened.listAttemptsForJob(draft.id);
    expect(reopenedAttempts).toEqual(originalAttempts);
    expect(reopenedAttempts).toEqual([
      expect.objectContaining({ roleSequence: 1, status: 'cancelled' }),
      expect.objectContaining({ roleSequence: 2, status: 'cancelled' }),
    ]);
    expect(await readWorkerExecutionBudget(reopened, reopenedAttempts, 2)).toMatchObject({
      consumed: 0,
      remaining: 2,
      exhausted: false,
    });
    for (const attempt of reopenedAttempts) {
      const plan = await reopened.getExecutionPlanForAttempt(attempt.id);
      expect(plan).not.toBeNull();
      expect(await reopened.getExecutionDispatchForPlan(plan!.id)).toBeNull();
    }
    await reopened.close();
  });

  it('migrates populated v8 history to v9 without inventing reviews or escalations', async () => {
    const path = databasePath();
    const v8 = open(path, 8);
    const configured = configuration();
    await v8.applyProjectConfiguration(configured);
    const draft = {
      id: 'job:historical',
      projectId: PROJECT_ID,
      title: 'Historical read-only execution',
      status: 'draft' as const,
      repositoryId: REPOSITORY_ID,
      preferredRuntimeAgentId: RUNTIME_ID,
      revision: 0,
      createdAt: TIME,
      updatedAt: TIME,
    };
    await v8.createJob(draft);
    await v8.saveJobTransition({ ...draft, status: 'ready', revision: 1 }, 0);
    const worker = await v8.createAttempt({
      id: 'attempt:historical-worker',
      jobId: draft.id,
      runtimeAgentId: RUNTIME_ID,
      status: 'created',
      revision: 0,
      createdAt: TIME,
      updatedAt: TIME,
    });
    const plan = {
      id: 'plan:historical-worker',
      attemptId: worker.id,
      jobId: draft.id,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      runtimeAgentId: RUNTIME_ID,
      repositoryId: REPOSITORY_ID,
      checkoutBindingId: configured.checkoutBindings[0].id,
      input: { version: 1 as const, instruction: 'Historical instruction.' },
      requestedPolicy: { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const },
      requestedCapabilities: { version: 1 as const, repositoryRead: true },
      jobRevisionAtPreparation: 1,
      attemptRevisionAtPreparation: 0,
      createdAt: TIME,
    };
    await v8.createExecutionPlan(plan);
    const prepared = {
      id: 'dispatch:historical-worker',
      executionPlanId: plan.id,
      attemptId: worker.id,
      jobId: draft.id,
      runtimeAgentId: RUNTIME_ID,
      idempotencyKey: createExecutionDispatchIdempotencyKey(plan.id),
      status: 'prepared' as const,
      revision: 0,
      createdAt: TIME,
      updatedAt: TIME,
    };
    await v8.createExecutionDispatch(prepared);
    const submitting = { ...prepared, status: 'submitting' as const, submittedAt: TIME, revision: 1 };
    await v8.saveExecutionDispatchTransition(submitting, 0);
    await v8.saveExecutionDispatchTransition({
      ...submitting,
      status: 'accepted',
      effectivePolicy: plan.requestedPolicy,
      effectiveCapabilities: plan.requestedCapabilities,
      externalReference: 'cortextos:codex-turn:v1:thread-old:turn-old',
      acceptedAt: TIME,
      resolvedAt: TIME,
      revision: 2,
    }, 1);
    await v8.saveAttemptTransition({
      ...worker,
      status: 'running',
      startedAt: TIME,
      revision: 1,
    }, 0);
    await v8.close();

    const upgraded = open(path);
    expect(await upgraded.getJob(draft.id)).toEqual({ ...draft, status: 'ready', revision: 1 });
    expect(await upgraded.getAttempt(worker.id)).toMatchObject({
      executionRole: 'worker',
      roleSequence: 1,
      sequence: 1,
      status: 'running',
    });
    expect(await upgraded.listAttemptReviewsForJob(draft.id)).toEqual([]);
    expect(await upgraded.listEscalations(draft.id)).toEqual([]);

    const observation = {
      id: createExecutionObservationId(prepared.id, 'fixture', 'completed'),
      dispatchId: prepared.id,
      attemptId: worker.id,
      source: 'fixture',
      sourceEventId: 'completed',
      kind: 'turn-completed' as const,
      correlation: 'exact' as const,
      correlatedDispatchId: prepared.id,
      executionContext: { workingDirectory: CHECKOUT, repositoryReadRoot: CHECKOUT },
      effectivePolicy: plan.requestedPolicy,
      effectiveCapabilities: plan.requestedCapabilities,
      resultText: 'Bounded historical result captured only after schema v9.',
      observedAt: TIME,
      recordedAt: TIME,
    };
    expect(await upgraded.appendExecutionObservation(observation)).toBe(true);
    const reviewer = await upgraded.createAttempt({
      id: 'attempt:historical-reviewer',
      jobId: draft.id,
      runtimeAgentId: RUNTIME_ID,
      executionRole: 'reviewer',
      status: 'created',
      revision: 0,
      createdAt: TIME,
      updatedAt: TIME,
    });
    expect(reviewer).toMatchObject({ executionRole: 'reviewer', roleSequence: 1, sequence: 2 });
    await upgraded.createAttemptReview({
      id: 'review:historical',
      jobId: draft.id,
      workerAttemptId: worker.id,
      reviewerAttemptId: reviewer.id,
      reviewerRuntimeAgentId: RUNTIME_ID,
      decision: 'REVISION_REQUIRED',
      summary: 'Historical result needs correction.',
      feedback: 'Use the Agent Operations contract.',
      createdAt: TIME,
    });
    await upgraded.createEscalation({
      id: 'escalation:historical',
      jobId: draft.id,
      attemptId: worker.id,
      reviewId: 'review:historical',
      reason: 'human_judgment_required',
      summary: 'Operator decision required.',
      createdAt: TIME,
    });
    await upgraded.close();

    const reopened = open(path);
    expect(await reopened.listExecutionObservationsForDispatch(prepared.id))
      .toEqual([observation]);
    expect(await reopened.listAttemptReviewsForJob(draft.id)).toEqual([
      expect.objectContaining({ id: 'review:historical', decision: 'REVISION_REQUIRED' }),
    ]);
    expect(await reopened.listEscalations(draft.id, true)).toEqual([
      expect.objectContaining({ id: 'escalation:historical', reason: 'human_judgment_required' }),
    ]);
    await reopened.close();

    const database = new Database(path, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }]);
    database.close();
  });
});
