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

function plan(suffix: string, withPolicy = true): DurableExecutionPlan {
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
    ...(withPolicy
      ? {
          requestedPolicy: { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const },
          requestedCapabilities: { version: 1 as const, repositoryRead: true },
        }
      : {}),
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
  withPolicy = true,
): DurableExecutionDispatch {
  return {
    ...dispatch,
    status,
    ...(status === 'accepted' ? { acceptedAt: TIME } : {}),
    ...(status === 'accepted' && withPolicy
      ? {
          effectivePolicy: { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const },
          effectiveCapabilities: { version: 1 as const, repositoryRead: true },
        }
      : {}),
    resolvedAt: TIME,
    revision: 2,
    updatedAt: TIME,
  };
}

async function seedPlan(
  store: SqliteAgentOperationsStateStore,
  suffix: string,
  withPolicy = true,
): Promise<void> {
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
  await store.createExecutionPlan(plan(suffix, withPolicy));
}

async function seed(
  store: SqliteAgentOperationsStateStore,
  suffixes: readonly string[],
  withPolicy = true,
): Promise<void> {
  await store.applyProjectConfiguration(configuration());
  for (const suffix of suffixes) await seedPlan(store, suffix, withPolicy);
}

describe('SQLite Execution Dispatch persistence', () => {
  it('migrates populated v5 history to v6 without inventing requested or effective policy', async () => {
    const path = databasePath();
    const versionFive = open(path, 5);
    await seed(versionFive, ['legacy-policy'], false);
    const initial = prepared('legacy-policy');
    await versionFive.createExecutionDispatch(initial);
    const inFlight = submitting(initial);
    await versionFive.saveExecutionDispatchTransition(inFlight, 0);
    await versionFive.saveExecutionDispatchTransition(terminal(inFlight, 'accepted', false), 1);
    await versionFive.close();

    const upgraded = open(path);
    expect(await upgraded.getExecutionPlan('plan:legacy-policy')).toEqual(plan('legacy-policy', false));
    const legacyDispatch = await upgraded.getExecutionDispatch('dispatch:legacy-policy');
    expect(legacyDispatch).toMatchObject({ status: 'accepted' });
    expect(legacyDispatch?.effectivePolicy).toBeUndefined();
    await upgraded.close();

    const database = new Database(path, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }]);
    expect(database.prepare(`
      SELECT requested_policy_version, requested_filesystem, requested_network, requested_environment
      FROM execution_plans WHERE id = 'plan:legacy-policy'
    `).get()).toEqual({
      requested_policy_version: null,
      requested_filesystem: null,
      requested_network: null,
      requested_environment: null,
    });
    database.close();
  });

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

  it('rejects partially specified requested and effective policy tuples at the database boundary', async () => {
    const path = databasePath();
    const store = open(path);
    await seed(store, ['complete-policy']);
    await store.createExecutionDispatch(prepared('complete-policy'));
    await store.close();

    const database = new Database(path);
    expect(() => database.prepare(`
      UPDATE execution_plans SET requested_network = NULL
      WHERE id = 'plan:complete-policy'
    `).run()).toThrow('execution plan policy must be wholly null or wholly specified');
    expect(() => database.prepare(`
      UPDATE execution_dispatches SET effective_policy_version = 1
      WHERE id = 'dispatch:complete-policy'
    `).run()).toThrow('execution dispatch policy must be wholly null or wholly specified');
    database.close();
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
    await seed(versionThree, ['migration'], false);
    await versionThree.close();

    let database = new Database(path, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='execution_dispatches'").get())
      .toBeUndefined();
    database.close();

    const upgraded = open(path, 4);
    expect(await upgraded.getProject(PROJECT_ID)).not.toBeNull();
    expect(await upgraded.getRepository(REPOSITORY_ID)).not.toBeNull();
    expect(await upgraded.getJob('job:migration')).toMatchObject({ status: 'ready' });
    expect(await upgraded.getAttempt('attempt:migration')).toMatchObject({ status: 'created' });
    expect(await upgraded.getExecutionPlan('plan:migration')).toEqual(plan('migration', false));
    await upgraded.createExecutionDispatch(prepared('migration'));
    expect(await upgraded.getExecutionDispatch('dispatch:migration')).toEqual(prepared('migration'));
    await upgraded.close();

    database = new Database(path, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    database.close();
  });

  it('rolls back a failed migration after current state without damaging Dispatches', async () => {
    const path = databasePath();
    const store = open(path);
    await seed(store, ['rollback']);
    await store.createExecutionDispatch(prepared('rollback'));
    await store.close();

    expect(() => SqliteAgentOperationsStateStore.open({
      databasePath: path,
      additionalMigrations: [{
        version: 13,
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
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }]);
    database.close();
  });
});
