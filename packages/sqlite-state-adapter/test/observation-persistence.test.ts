import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DurableAttemptOutcomeDecision,
  DurableExecutionObservation,
  DurableProjectConfiguration,
} from '../../agent-operations-contracts/src/index.js';
import {
  createExecutionDispatchIdempotencyKey,
  createExecutionObservationId,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import { SqliteAgentOperationsStateStore } from '../src/index.js';

const TIME = '2026-08-21T21:00:00.000Z';
const INSTALLATION_ID = 'installation:observation';
const PROJECT_ID = 'agent-operations';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'engineering/coder';
const CHECKOUT_PATH = '/repos/agent-operations';
const CHECKOUT_ID = createRepositoryCheckoutBindingId(INSTALLATION_ID, CHECKOUT_PATH);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ao-observation-state-'));
  directories.push(directory);
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

function configuration(): DurableProjectConfiguration {
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
    checkoutBindings: [{
      id: CHECKOUT_ID,
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      canonicalPath: CHECKOUT_PATH,
      availability: 'available',
      firstSeenAt: TIME,
      lastSeenAt: TIME,
    }],
    runtimeAgentIds: [RUNTIME_ID],
  };
}

async function seedAcceptedDispatch(
  store: SqliteAgentOperationsStateStore,
  withPolicy = true,
): Promise<void> {
  await store.applyProjectConfiguration(configuration());
  const draft = {
    id: 'job:observation',
    projectId: PROJECT_ID,
    title: 'Observe accepted execution',
    status: 'draft' as const,
    repositoryId: REPOSITORY_ID,
    preferredRuntimeAgentId: RUNTIME_ID,
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  };
  await store.createJob(draft);
  await store.saveJobTransition({ ...draft, status: 'ready', revision: 1 }, 0);
  const attempt = await store.createAttempt({
    id: 'attempt:observation',
    jobId: draft.id,
    runtimeAgentId: RUNTIME_ID,
    status: 'created',
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  });
  const plan = {
    id: 'plan:observation',
    attemptId: attempt.id,
    jobId: draft.id,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    runtimeAgentId: RUNTIME_ID,
    repositoryId: REPOSITORY_ID,
    checkoutBindingId: CHECKOUT_ID,
    input: { version: 1 as const, instruction: 'Observe this accepted Dispatch.' },
    ...(withPolicy
      ? { requestedPolicy: { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const } }
      : {}),
    jobRevisionAtPreparation: 1,
    attemptRevisionAtPreparation: 0,
    createdAt: TIME,
  };
  await store.createExecutionPlan(plan);
  const prepared = {
    id: 'dispatch:observation',
    executionPlanId: plan.id,
    attemptId: attempt.id,
    jobId: draft.id,
    runtimeAgentId: RUNTIME_ID,
    idempotencyKey: createExecutionDispatchIdempotencyKey(plan.id),
    status: 'prepared' as const,
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  };
  await store.createExecutionDispatch(prepared);
  const submitting = { ...prepared, status: 'submitting' as const, submittedAt: TIME, revision: 1 };
  await store.saveExecutionDispatchTransition(submitting, 0);
  await store.saveExecutionDispatchTransition({
    ...submitting,
    status: 'accepted',
    ...(withPolicy ? { effectivePolicy: plan.requestedPolicy } : {}),
    acceptedAt: TIME,
    resolvedAt: TIME,
    revision: 2,
  }, 1);
  await store.saveAttemptTransition({
    ...attempt,
    status: 'running',
    startedAt: TIME,
    revision: 1,
  }, 0);
}

function observation(): DurableExecutionObservation {
  return {
    id: createExecutionObservationId('dispatch:observation', 'fake-codex', 'turn:one'),
    dispatchId: 'dispatch:observation',
    attemptId: 'attempt:observation',
    source: 'fake-codex',
    sourceEventId: 'turn:one',
    kind: 'turn-completed',
    correlation: 'exact',
    correlatedDispatchId: 'dispatch:observation',
    runtimeSessionId: 'thread:one',
    externalReference: 'turn:one',
    outputSummary: 'Bounded output summary.',
    observedAt: TIME,
    recordedAt: TIME,
  };
}

function decision(): DurableAttemptOutcomeDecision {
  return {
    id: 'outcome:observation',
    attemptId: 'attempt:observation',
    dispatchId: 'dispatch:observation',
    outcome: 'completed',
    source: 'human',
    summary: 'Operator verified completion.',
    evidenceObservationId: observation().id,
    overrideWithoutExactCompletionEvidence: false,
    createdAt: TIME,
  };
}

describe('SQLite execution observation persistence', () => {
  it('migrates a populated v4 chain to v5 and preserves every existing record', async () => {
    const databasePath = path();
    const versionFour = open(databasePath, 4);
    await seedAcceptedDispatch(versionFour, false);
    await versionFour.close();

    let database = new Database(databasePath, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='execution_observations'").get())
      .toBeUndefined();
    database.close();

    const upgraded = open(databasePath, 5);
    expect(await upgraded.getProject(PROJECT_ID)).not.toBeNull();
    expect(await upgraded.getRepository(REPOSITORY_ID)).not.toBeNull();
    expect(await upgraded.getJob('job:observation')).toMatchObject({ status: 'ready' });
    expect(await upgraded.getAttempt('attempt:observation')).toMatchObject({ status: 'running' });
    expect(await upgraded.getExecutionPlan('plan:observation')).not.toBeNull();
    expect(await upgraded.getExecutionDispatch('dispatch:observation')).toMatchObject({ status: 'accepted' });
    expect(await upgraded.appendExecutionObservation(observation())).toBe(true);
    await upgraded.createAttemptOutcomeDecision(decision());
    await upgraded.close();

    database = new Database(databasePath, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
    database.close();
  });

  it('persists and deduplicates observations and outcome authority across reopen', async () => {
    const databasePath = path();
    const store = open(databasePath);
    await seedAcceptedDispatch(store);
    expect(await store.appendExecutionObservation(observation())).toBe(true);
    expect(await store.appendExecutionObservation(observation())).toBe(false);
    await store.createAttemptOutcomeDecision(decision());
    await expect(store.createAttemptOutcomeDecision({ ...decision(), id: 'outcome:duplicate' }))
      .rejects.toThrow('Could not create Attempt Outcome Decision');
    await store.close();

    const reopened = open(databasePath);
    expect(await reopened.listExecutionObservationsForDispatch('dispatch:observation'))
      .toEqual([observation()]);
    expect(await reopened.getAttemptOutcomeDecision('attempt:observation')).toEqual(decision());
    expect(await reopened.getExecutionDispatch('dispatch:observation')).toMatchObject({ status: 'accepted' });
    await reopened.close();
  });

  it('enforces exact correlation and evidence associations structurally', async () => {
    const store = open(path());
    await seedAcceptedDispatch(store);
    await expect(store.appendExecutionObservation({
      ...observation(),
      id: 'observation:bad',
      correlatedDispatchId: 'dispatch:other',
    })).rejects.toThrow('Could not append Execution Observation');
    await store.appendExecutionObservation(observation());
    await expect(store.createAttemptOutcomeDecision({
      ...decision(),
      id: 'outcome:bad-evidence',
      evidenceObservationId: 'observation:missing',
    })).rejects.toThrow('Could not create Attempt Outcome Decision');
    await store.close();
  });

  it('rolls back a failed migration after v5 without damaging evidence', async () => {
    const databasePath = path();
    const store = open(databasePath);
    await seedAcceptedDispatch(store);
    await store.appendExecutionObservation(observation());
    await store.close();

    expect(() => SqliteAgentOperationsStateStore.open({
      databasePath,
      additionalMigrations: [{
        version: 7,
        name: 'deliberate-observation-rollback',
        up: database => {
          database.exec('CREATE TABLE should_rollback_observation (id TEXT)');
          throw new Error('observation migration failure');
        },
      }],
    })).toThrow('observation migration failure');

    const database = new Database(databasePath, { readonly: true });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback_observation'").get())
      .toBeUndefined();
    expect(database.prepare('SELECT id FROM execution_observations').get())
      .toEqual({ id: observation().id });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]);
    database.close();
  });
});
