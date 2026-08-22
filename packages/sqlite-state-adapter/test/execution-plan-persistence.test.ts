import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DurableExecutionPlan,
  DurableJob,
  DurableProjectConfiguration,
} from '../../agent-operations-contracts/src/index.js';
import { createRepositoryCheckoutBindingId } from '../../agent-operations-contracts/src/index.js';
import { SqliteAgentOperationsStateStore } from '../src/index.js';

const TIME = '2026-08-21T14:00:00.000Z';
const INSTALLATION_ID = 'installation:execution-persistence';
const PROJECT_ID = 'agent-operations';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const RUNTIME_ID = 'engineering/coder';
const PATH = '/repos/agent-operations';
const CHECKOUT_ID = createRepositoryCheckoutBindingId(INSTALLATION_ID, PATH);
const directories: string[] = [];

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ao-execution-plans-'));
  directories.push(directory);
  return join(directory, 'state.db');
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
      canonicalPath: PATH,
      availability: 'available',
      firstSeenAt: TIME,
      lastSeenAt: TIME,
    }],
    runtimeAgentIds: [RUNTIME_ID],
  };
}

function job(): DurableJob {
  return {
    id: 'job:execution-persistence',
    projectId: PROJECT_ID,
    title: 'Persist execution intent',
    status: 'draft',
    repositoryId: REPOSITORY_ID,
    preferredRuntimeAgentId: RUNTIME_ID,
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  };
}

function plan(): DurableExecutionPlan {
  return {
    id: 'plan:execution-persistence',
    attemptId: 'attempt:execution-persistence',
    jobId: 'job:execution-persistence',
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    runtimeAgentId: RUNTIME_ID,
    repositoryId: REPOSITORY_ID,
    checkoutBindingId: CHECKOUT_ID,
    input: { version: 1, instruction: 'Inspect the failing test.' },
    jobRevisionAtPreparation: 1,
    attemptRevisionAtPreparation: 0,
    createdAt: TIME,
  };
}

async function seedPhaseSeven(store: SqliteAgentOperationsStateStore): Promise<void> {
  await store.applyProjectConfiguration(configuration());
  const draft = job();
  await store.createJob(draft);
  await store.saveJobTransition({ ...draft, status: 'ready', revision: 1 }, 0);
  await store.createAttempt({
    id: 'attempt:execution-persistence',
    jobId: draft.id,
    runtimeAgentId: RUNTIME_ID,
    status: 'created',
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  });
}

describe('SQLite Execution Plan persistence', () => {
  it('creates and reopens an immutable Plan in a fresh schema-v3 database', async () => {
    const databasePath = path();
    const store = open(databasePath);
    await seedPhaseSeven(store);
    await store.createExecutionPlan(plan());
    await expect(store.createExecutionPlan({ ...plan(), id: 'plan:duplicate-attempt' }))
      .rejects.toThrow('Could not create Execution Plan');
    await store.close();

    const reopened = open(databasePath);
    expect(await reopened.getExecutionPlan(plan().id)).toEqual(plan());
    expect(await reopened.getExecutionPlanForAttempt(plan().attemptId)).toEqual(plan());
    expect('updateExecutionPlan' in reopened).toBe(false);
    await reopened.close();
  });

  it('migrates a real populated schema v2 to v3 without losing projects, repositories, jobs, or attempts', async () => {
    const databasePath = path();
    const versionTwo = open(databasePath, 2);
    await seedPhaseSeven(versionTwo);
    await versionTwo.close();

    let database = new Database(databasePath, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_plans'").get())
      .toBeUndefined();
    database.close();

    const upgraded = open(databasePath);
    expect(await upgraded.getProject(PROJECT_ID)).toMatchObject({ name: 'Agent Operations' });
    expect(await upgraded.getRepository(REPOSITORY_ID)).toMatchObject({ name: 'agent-operations' });
    expect(await upgraded.getJob(job().id)).toMatchObject({ status: 'ready', revision: 1 });
    expect(await upgraded.getAttempt(plan().attemptId)).toMatchObject({ status: 'created', sequence: 1 });
    await upgraded.createExecutionPlan(plan());
    expect(await upgraded.getExecutionPlan(plan().id)).toEqual(plan());
    await upgraded.close();

    database = new Database(databasePath, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    database.close();
  });

  it('rolls back a failed migration after v3 without damaging Plans or migration history', async () => {
    const databasePath = path();
    const store = open(databasePath);
    await seedPhaseSeven(store);
    await store.createExecutionPlan(plan());
    await store.close();

    expect(() => SqliteAgentOperationsStateStore.open({
      databasePath,
      additionalMigrations: [{
        version: 4,
        name: 'deliberate-v4-failure',
        up: database => {
          database.exec('CREATE TABLE should_rollback_v4 (id TEXT)');
          throw new Error('deliberate migration failure');
        },
      }],
    })).toThrow('deliberate migration failure');

    const database = new Database(databasePath, { readonly: true });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback_v4'").get())
      .toBeUndefined();
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(database.prepare('SELECT id FROM execution_plans').get()).toEqual({ id: plan().id });
    database.close();
  });
});
