import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositoryCheckoutBindingId } from '../../agent-operations-contracts/src/index.js';
import { JobLifecycleService } from '../../agent-operations-core/src/index.js';
import { SqliteAgentOperationsStateStore } from '../src/index.js';

const TIME = '2026-08-27T12:00:00.000Z';
const INSTALLATION_ID = 'installation:operator-persistence';
const PROJECT_ID = 'project:ao';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ao-operator-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.db');
}

function open(databasePath: string, targetSchemaVersion?: number) {
  return SqliteAgentOperationsStateStore.open({
    databasePath,
    installationIdFactory: () => INSTALLATION_ID,
    now: () => new Date(TIME),
    ...(targetSchemaVersion ? { targetSchemaVersion } : {}),
  });
}

async function seed(store: SqliteAgentOperationsStateStore) {
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
      id: createRepositoryCheckoutBindingId(INSTALLATION_ID, '/repo'),
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      canonicalPath: '/repo',
      availability: 'available',
      firstSeenAt: TIME,
      lastSeenAt: TIME,
    }],
    runtimeAgentIds: ['agent-operations/rehearsal'],
  });
  const lifecycle = new JobLifecycleService(store, {
    now: () => new Date(TIME),
    jobIdFactory: () => 'job:operator',
  });
  const draft = await lifecycle.createJob({
    projectId: PROJECT_ID,
    repositoryId: REPOSITORY_ID,
    preferredRuntimeAgentId: 'agent-operations/rehearsal',
    title: 'Operator Job',
    acceptanceCriteria: 'Return an authoritative file.',
    automaticReadOnlyCompletion: true,
  });
  return lifecycle.markJobReady(draft.id);
}

describe('daily Operator persistence', () => {
  it('persists immutable Red action receipts and deterministic Job verification', async () => {
    const databasePath = path();
    const store = open(databasePath);
    const job = await seed(store);
    const bindingId = createRepositoryCheckoutBindingId(INSTALLATION_ID, '/repo');
    const action = {
      id: 'repository-restore:receipt', projectId: PROJECT_ID, repositoryId: REPOSITORY_ID,
      checkoutBindingId: bindingId, state: 'pending-approval' as const,
      preconditions: {
        repositoryId: REPOSITORY_ID, checkoutBindingId: bindingId, canonicalPath: '/repo',
        branch: 'main', headRevision: 'a'.repeat(40),
        restorePaths: [{ path: 'main.py', indexStatus: 'unmodified' as const, worktreeStatus: 'modified' as const, workingTreeSha256: 'b'.repeat(64), headSha256: 'c'.repeat(64) }],
        preserveUntrackedPaths: [{ path: 'PLAN.md', sha256: 'd'.repeat(64) }],
        statusEntries: [], evidenceHash: 'e'.repeat(64),
      },
      approvalSummary: 'Restore main.py and preserve PLAN.md.', requestedBy: 'operator',
      createdAt: TIME, revision: 0,
    };
    await store.createRepositoryRestoreAction(action);
    const approved = { ...action, state: 'approved' as const, approvedAt: TIME, approvedBy: 'operator', revision: 1 };
    await store.saveRepositoryRestoreActionTransition(approved, 0);
    await store.saveRepositoryRestoreActionTransition({
      ...approved, state: 'completed', revision: 2,
      result: { beforeEvidenceHash: 'e'.repeat(64), afterEvidenceHash: 'f'.repeat(64), restoredPaths: ['main.py'], preservedUntrackedPaths: [{ path: 'PLAN.md', sha256: 'd'.repeat(64) }], completedAt: TIME },
    }, 1);
    const receipt = {
      actionId: action.id, operation: 'repository.restore_tracked_paths' as const,
      projectId: PROJECT_ID, repositoryId: REPOSITORY_ID, checkoutBindingId: bindingId,
      approvedPaths: ['main.py'], approvedBy: 'operator', approvedAt: TIME,
      executedAt: TIME, recordedAt: TIME, evidenceSource: 'captured-during-execution' as const,
      branchBefore: 'main', branchAfter: 'main', headBefore: 'a'.repeat(40), headAfter: 'a'.repeat(40),
      approvedFileHashesBefore: [{ path: 'main.py', sha256: 'b'.repeat(64) }],
      restoredFileHashesAfter: [{ path: 'main.py', sha256: 'c'.repeat(64) }],
      preservedUntrackedFileHashesBefore: [{ path: 'PLAN.md', sha256: 'd'.repeat(64) }],
      preservedUntrackedFileHashesAfter: [{ path: 'PLAN.md', sha256: 'd'.repeat(64) }],
      finalStatus: [{ path: 'PLAN.md', indexStatus: 'unmodified' as const, worktreeStatus: 'untracked' as const }],
      beforeEvidenceHash: 'e'.repeat(64), afterEvidenceHash: 'f'.repeat(64),
      commitPerformed: false as const, pushPerformed: false as const, deployPerformed: false as const,
      verificationResult: 'passed' as const,
    };
    await store.createRepositoryRestoreExecutionReceipt(receipt);
    const verification = {
      id: 'deterministic-verification:receipt', jobId: job.id, actionId: action.id,
      projectId: PROJECT_ID, repositoryId: REPOSITORY_ID, checkoutBindingId: bindingId,
      verifiedAt: TIME, verifiedBy: 'application:test', branch: 'main', headRevision: 'a'.repeat(40),
      statusEntries: receipt.finalStatus, cleanPaths: ['main.py'],
      preservedUntrackedFiles: receipt.preservedUntrackedFileHashesAfter,
      commitPerformed: false as const, pushPerformed: false as const, deployPerformed: false as const,
      providerRuntimeRequired: false as const, providerSubmissionsCreated: 0 as const,
      result: 'passed' as const, summary: 'Exact repository facts verified.',
    };
    await store.createDeterministicRepositoryVerification(verification);
    await store.close();

    const reopened = open(databasePath);
    expect(await reopened.getRepositoryRestoreExecutionReceipt(action.id)).toEqual(receipt);
    expect(await reopened.getDeterministicRepositoryVerification(job.id)).toEqual(verification);
    await expect(reopened.createRepositoryRestoreExecutionReceipt({ ...receipt, recordedAt: 'later' }))
      .rejects.toThrow(/immutable/);
    await reopened.close();
  });

  it('atomically records a late-completion resolution and resumes the same Operator Run', async () => {
    const store = open(path());
    const job = await seed(store);
    const run = {
      id: 'operator-run:late', jobId: job.id, status: 'pending' as const, revision: 0,
      createdAt: TIME, updatedAt: TIME,
    };
    await store.createOperatorRun(run);
    await store.saveOperatorRunTransition({
      ...run, status: 'running', revision: 1, startedAt: TIME,
    }, 0);
    await store.saveOperatorRunTransition({
      ...run, status: 'needs_human', revision: 2, startedAt: TIME, finishedAt: TIME,
    }, 1);
    await store.createEscalation({
      id: 'escalation:late', jobId: job.id, reason: 'observation_timeout',
      summary: 'Observation timed out; provider outcome remained unknown.', createdAt: TIME,
    });

    await store.resolveEscalationAndResumeOperatorRun(
      'escalation:late',
      TIME,
      'Resolved by late exact completion; no task was resent.',
      { ...run, status: 'pending', revision: 3 },
      2,
    );

    expect(await store.getEscalation('escalation:late')).toMatchObject({
      resolvedAt: TIME,
      resolutionSummary: 'Resolved by late exact completion; no task was resent.',
    });
    expect(await store.getOperatorRun(run.id)).toMatchObject({ status: 'pending', revision: 3 });
    await store.close();
  });

  it('persists runs, resolved guidance history, and at-most-once notification claims', async () => {
    const databasePath = path();
    const store = open(databasePath);
    const job = await seed(store);
    await store.createOperatorRun({
      id: 'operator-run:1', jobId: job.id, status: 'pending', revision: 0,
      createdAt: TIME, updatedAt: TIME,
    });
    await store.saveOperatorRunTransition({
      id: 'operator-run:1', jobId: job.id, status: 'running', revision: 1,
      createdAt: TIME, updatedAt: TIME, startedAt: TIME,
    }, 0);
    await store.saveOperatorRunTransition({
      id: 'operator-run:1', jobId: job.id, status: 'needs_human', revision: 2,
      createdAt: TIME, updatedAt: TIME, startedAt: TIME, finishedAt: TIME,
    }, 1);
    await store.createEscalation({
      id: 'escalation:1', jobId: job.id, reason: 'human_judgment_required',
      summary: 'Choose the intended behavior.', createdAt: TIME,
    });
    await store.createHumanGuidanceAndResumeOperatorRun({
      id: 'guidance:1', jobId: job.id, escalationId: 'escalation:1',
      instruction: 'Use the documented behavior.', createdAt: TIME,
    }, TIME, {
      id: 'operator-run:1', jobId: job.id, status: 'pending', revision: 3,
      createdAt: TIME, updatedAt: TIME,
    }, 2);
    const delivery = {
      id: 'notification-delivery:1', eventKey: 'needs_human:escalation:1',
      kind: 'needs_human' as const, jobId: job.id, escalationId: 'escalation:1',
      status: 'pending' as const, revision: 0, createdAt: TIME, updatedAt: TIME,
    };
    expect(await store.createOperatorNotificationDelivery(delivery)).toBe(true);
    expect(await store.createOperatorNotificationDelivery({ ...delivery, id: 'notification-delivery:2' })).toBe(false);
    await store.saveOperatorNotificationDeliveryTransition({
      ...delivery, status: 'failed', message: 'offline', revision: 1, attemptedAt: TIME,
    }, 0);
    await store.close();

    const reopened = open(databasePath);
    expect(await reopened.getOperatorRunForJob(job.id)).toMatchObject({ status: 'pending', revision: 3 });
    expect(await reopened.listHumanGuidance(job.id)).toEqual([expect.objectContaining({ instruction: 'Use the documented behavior.' })]);
    expect(await reopened.getEscalation('escalation:1')).toMatchObject({ resolvedAt: TIME });
    expect(await reopened.listOperatorNotificationDeliveries(job.id)).toEqual([
      expect.objectContaining({ status: 'failed', message: 'offline' }),
    ]);
    await reopened.close();
  });

  it('atomically persists one human Worker budget extension per escalation', async () => {
    const databasePath = path();
    const store = open(databasePath);
    const job = await seed(store);
    const run = {
      id: 'operator-run:extension', jobId: job.id, status: 'pending' as const, revision: 0,
      createdAt: TIME, updatedAt: TIME,
    };
    await store.createOperatorRun(run);
    await store.saveOperatorRunTransition({
      ...run, status: 'running', revision: 1, startedAt: TIME,
    }, 0);
    await store.saveOperatorRunTransition({
      ...run, status: 'needs_human', revision: 2, startedAt: TIME, finishedAt: TIME,
    }, 1);
    await store.createEscalation({
      id: 'escalation:extension', jobId: job.id, reason: 'review_failed_after_budget',
      summary: 'Worker execution budget of 2 is exhausted.', createdAt: TIME,
    });
    const extension = {
      id: 'worker-budget-extension:1', jobId: job.id, escalationId: 'escalation:extension',
      additionalWorkerExecutions: 1 as const, createdAt: TIME,
    };
    const pending = { ...run, status: 'pending' as const, revision: 3 };

    await store.authorizeWorkerBudgetExtensionAndResumeOperatorRun(
      extension,
      {
        id: 'guidance:extension', jobId: job.id, escalationId: 'escalation:extension',
        instruction: 'Keep the Reviewer feedback and check the exact file.', createdAt: TIME,
      },
      TIME,
      'Operator authorized exactly one additional Worker execution.',
      pending,
      2,
    );

    expect(await store.listWorkerBudgetExtensions(job.id)).toEqual([extension]);
    expect(await store.listHumanGuidance(job.id)).toEqual([
      expect.objectContaining({ instruction: 'Keep the Reviewer feedback and check the exact file.' }),
    ]);
    expect(await store.getEscalation('escalation:extension')).toMatchObject({
      resolvedAt: TIME,
      resolutionSummary: 'Operator authorized exactly one additional Worker execution.',
    });
    expect(await store.getOperatorRunForJob(job.id)).toMatchObject({ status: 'pending', revision: 3 });
    await expect(store.authorizeWorkerBudgetExtensionAndResumeOperatorRun(
      { ...extension, id: 'worker-budget-extension:duplicate' }, null, TIME,
      'Duplicate.', { ...pending, revision: 4 }, 3,
    )).rejects.toThrow();
    expect(await store.listWorkerBudgetExtensions(job.id)).toHaveLength(1);
    await store.close();

    const reopened = open(databasePath);
    expect(await reopened.listWorkerBudgetExtensions(job.id)).toEqual([extension]);
    await reopened.close();
  });

  it('upgrades populated v9 state without rewriting existing orchestration truth', async () => {
    const databasePath = path();
    const legacy = open(databasePath, 9);
    const job = await seed(legacy);
    await legacy.createEscalation({
      id: 'escalation:legacy', jobId: job.id, reason: 'runtime_failure',
      summary: 'Historical boundary.', createdAt: TIME,
    });
    await legacy.close();

    const upgraded = open(databasePath);
    expect(await upgraded.getJob(job.id)).toEqual(job);
    expect(await upgraded.getEscalation('escalation:legacy')).toEqual({
      id: 'escalation:legacy', jobId: job.id, reason: 'runtime_failure',
      summary: 'Historical boundary.', createdAt: TIME,
    });
    expect(await upgraded.listOperatorRuns()).toEqual([]);
    expect(await upgraded.listHumanGuidance(job.id)).toEqual([]);
    expect(await upgraded.listWorkerBudgetExtensions(job.id)).toEqual([]);
    expect(await upgraded.listOperatorNotificationDeliveries()).toEqual([]);
    await upgraded.close();
  });
});
