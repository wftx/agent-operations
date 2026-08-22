import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DurableExecutionDispatch,
  DurableExecutionPlan,
  DurableJob,
  DurableProjectConfiguration,
} from '../../agent-operations-contracts/src/index.js';
import {
  createExecutionDispatchIdempotencyKey,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import { SqliteAgentOperationsStateStore } from '../src/index.js';

const TIME = '2026-08-21T16:00:00.000Z';
const INSTALLATION_ID = 'installation:dispatch-persistence';
const PROJECT_ID = 'agent-operations';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'engineering/coder';
const CHECKOUT_PATH = '/repos/agent-operations';
const CHECKOUT_ID = createRepositoryCheckoutBindingId(INSTALLATION_ID, CHECKOUT_PATH);
const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ao-dispatches-'));
  directories.push(directory);
  return join(directory, 'state.db');
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(path: string, targetSchemaVersion?: number) {
  return SqliteAgentOperationsStateStore.open({
    databasePath: path,
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

function job(suffix: string): DurableJob {
  return {
    id: `job:${suffix}`,
    projectId: PROJECT_ID,
    title: `Dispatch ${suffix}`,
    status: 'draft',
    repositoryId: REPOSITORY_ID,
    preferredRuntimeAgentId: RUNTIME_ID,
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  };
}

function plan(suffix: string): DurableExecutionPlan {
  return {
    id: `plan:${suffix}`,
    attemptId: `attempt:${suffix}`,
    jobId: `job:${suffix}`,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    runtimeAgentId: RUNTIME_ID,
    repositoryId: REPOSITORY_ID,
    checkoutBindingId: CHECKOUT_ID,
    input: { version: 1, instruction: `Dispatch ${suffix}.` },
    jobRevisionAtPreparation: 1,
    attemptRevisionAtPreparation: 0,
    createdAt: TIME,
  };
}

function prepared(suffix: string, idempotencyKey = createExecutionDispatchIdempotencyKey(`plan:${suffix}`)):
DurableExecutionDispatch {
  return {
    id: `dispatch:${suffix}`,
    executionPlanId: `plan:${suffix}`,
    attemptId: `attempt:${suffix}`,
    jobId: `job:${suffix}`,
    runtimeAgentId: RUNTIME_ID,
    idempotencyKey,
    status: 'prepared',
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  };
}

function submitting(dispatch: DurableExecutionDispatch): DurableExecutionDispatch {
  return { ...dispatch, status: 'submitting', submittedAt: TIME, revision: 1, updatedAt: TIME };
}

function terminal(
  dispatch: DurableExecutionDispatch,
  status: 'accepted' | 'rejected' | 'uncertain',
): DurableExecutionDispatch {
  return {
    ...dispatch,
    status,
    ...(status === 'accepted' ? { acceptedAt: TIME } : {}),
    resolvedAt: TIME,
    revision: 2,
    updatedAt: TIME,
  };
}

async function seedPlan(store: SqliteAgentOperationsStateStore, suffix: string): Promise<void> {
  const draft = job(suffix);
  await store.createJob(draft);
  await store.saveJobTransition({ ...draft, status: 'ready', revision: 1 }, 0);
  await store.createAttempt({
    id: `attempt:${suffix}`,
    jobId: draft.id,
    runtimeAgentId: RUNTIME_ID,
    status: 'created',
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  });
  await store.createExecutionPlan(plan(suffix));
}

async function seed(store: SqliteAgentOperationsStateStore, suffixes: readonly string[]): Promise<void> {
  await store.applyProjectConfiguration(configuration());
  for (const suffix of suffixes) await seedPlan(store, suffix);
}

describe('SQLite Execution Dispatch persistence', () => {
  it('persists accepted and uncertain Dispatches across reopen with optimistic transitions', async () => {
    const path = databasePath();
    const store = open(path);
    await seed(store, ['accepted', 'uncertain']);
    for (const [suffix, status] of [['accepted', 'accepted'], ['uncertain', 'uncertain']] as const) {
      const initial = prepared(suffix);
      await store.createExecutionDispatch(initial);
      const inFlight = submitting(initial);
      await store.saveExecutionDispatchTransition(inFlight, 0);
      await store.saveExecutionDispatchTransition(terminal(inFlight, status), 1);
    }
    await expect(store.saveExecutionDispatchTransition(
      { ...terminal(submitting(prepared('accepted')), 'accepted'), revision: 3 },
      1,
    )).rejects.toThrow();
    await store.close();

    const reopened = open(path);
    expect(await reopened.getExecutionDispatchForPlan('plan:accepted'))
      .toMatchObject({ status: 'accepted', revision: 2, acceptedAt: TIME });
    expect(await reopened.getExecutionDispatchForPlan('plan:uncertain'))
      .toMatchObject({ status: 'uncertain', revision: 2 });
    await reopened.close();
  });

  it('enforces unique Plan and idempotency identities', async () => {
    const store = open(databasePath());
    await seed(store, ['one', 'two']);
    await store.createExecutionDispatch(prepared('one'));
    await expect(store.createExecutionDispatch({
      ...prepared('one'),
      id: 'dispatch:duplicate-plan',
      idempotencyKey: 'dispatch-plan:different',
    })).rejects.toThrow('Could not create Execution Dispatch');
    await expect(store.createExecutionDispatch(prepared(
      'two',
      createExecutionDispatchIdempotencyKey('plan:one'),
    ))).rejects.toThrow('Could not create Execution Dispatch');
    await store.close();
  });

  it('migrates a populated schema v3 to v4 and preserves the entire Plan chain', async () => {
    const path = databasePath();
    const versionThree = open(path, 3);
    await seed(versionThree, ['migration']);
    await versionThree.close();

    let database = new Database(path, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='execution_dispatches'").get())
      .toBeUndefined();
    database.close();

    const upgraded = open(path);
    expect(await upgraded.getProject(PROJECT_ID)).not.toBeNull();
    expect(await upgraded.getRepository(REPOSITORY_ID)).not.toBeNull();
    expect(await upgraded.getJob('job:migration')).toMatchObject({ status: 'ready' });
    expect(await upgraded.getAttempt('attempt:migration')).toMatchObject({ status: 'created' });
    expect(await upgraded.getExecutionPlan('plan:migration')).toEqual(plan('migration'));
    await upgraded.createExecutionDispatch(prepared('migration'));
    expect(await upgraded.getExecutionDispatch('dispatch:migration')).toEqual(prepared('migration'));
    await upgraded.close();

    database = new Database(path, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    database.close();
  });

  it('rolls back a failed migration after v4 without damaging Dispatches', async () => {
    const path = databasePath();
    const store = open(path);
    await seed(store, ['rollback']);
    await store.createExecutionDispatch(prepared('rollback'));
    await store.close();

    expect(() => SqliteAgentOperationsStateStore.open({
      databasePath: path,
      additionalMigrations: [{
        version: 5,
        name: 'deliberate-dispatch-rollback',
        up: database => {
          database.exec('CREATE TABLE should_rollback_dispatch (id TEXT)');
          throw new Error('dispatch migration failure');
        },
      }],
    })).toThrow('dispatch migration failure');

    const database = new Database(path, { readonly: true });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback_dispatch'").get())
      .toBeUndefined();
    expect(database.prepare('SELECT id FROM execution_dispatches').get())
      .toEqual({ id: 'dispatch:rollback' });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    database.close();
  });
});
