import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DurableJob,
  DurableProjectConfiguration,
  NewDurableJobAttempt,
} from '../../agent-operations-contracts/src/index.js';
import { SqliteAgentOperationsStateStore } from '../src/index.js';

const TIME = '2026-08-02T00:00:00.000Z';
const PROJECT_ID = 'agent-operations';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const CODER = 'engineering/coder';
const SENIOR = 'engineering/senior-coder';
const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ao-jobs-'));
  directories.push(directory);
  return join(directory, 'state.db');
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(path: string, targetSchemaVersion?: number): SqliteAgentOperationsStateStore {
  return SqliteAgentOperationsStateStore.open({
    databasePath: path,
    installationIdFactory: () => 'installation:jobs-test',
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
    checkoutBindings: [],
    runtimeAgentIds: [CODER, SENIOR],
  };
}

function job(id = 'job:sqlite-one'): DurableJob {
  return {
    id,
    projectId: PROJECT_ID,
    title: 'Durable work',
    description: 'Persist this request',
    status: 'draft',
    repositoryId: REPOSITORY_ID,
    preferredRuntimeAgentId: CODER,
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  };
}

function attempt(id: string, jobId = 'job:sqlite-one', runtimeAgentId = CODER): NewDurableJobAttempt {
  return {
    id,
    jobId,
    runtimeAgentId,
    status: 'created',
    revision: 0,
    createdAt: TIME,
    updatedAt: TIME,
  };
}

describe('SQLite job and attempt persistence', () => {
  it('migrates an actual schema-v1 database to v2 without losing Phase 6 state', async () => {
    const path = databasePath();
    const versionOne = open(path, 1);
    await versionOne.applyProjectConfiguration(configuration());
    await versionOne.close();

    let database = new Database(path, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get())
      .toBeUndefined();
    database.close();

    const upgraded = open(path);
    expect(await upgraded.getProject(PROJECT_ID)).toMatchObject({ name: 'Agent Operations' });
    expect(await upgraded.listJobs()).toEqual([]);
    await upgraded.createJob(job());
    await upgraded.close();

    database = new Database(path, { readonly: true });
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }]);
    database.close();
  });

  it('persists jobs and ordered attempt history across reopen', async () => {
    const path = databasePath();
    const store = open(path);
    await store.applyProjectConfiguration(configuration());
    await store.createJob(job());
    const first = await store.createAttempt(attempt('attempt:sqlite-one'));
    await store.saveAttemptTransition({
      ...first,
      status: 'failed',
      startedAt: TIME,
      finishedAt: TIME,
      failureReason: 'Runtime crashed',
      revision: 1,
      updatedAt: TIME,
    }, 0);
    const second = await store.createAttempt(attempt('attempt:sqlite-two', 'job:sqlite-one', SENIOR));
    expect(second.sequence).toBe(2);
    await store.close();

    const reopened = open(path);
    expect(await reopened.getJob('job:sqlite-one')).toEqual(job());
    expect(await reopened.listAttemptsForJob('job:sqlite-one')).toEqual([
      expect.objectContaining({ id: 'attempt:sqlite-one', sequence: 1, status: 'failed', runtimeAgentId: CODER }),
      expect.objectContaining({ id: 'attempt:sqlite-two', sequence: 2, status: 'created', runtimeAgentId: SENIOR }),
    ]);
    await reopened.close();
  });

  it('rejects duplicate identities and invalid project, repository, and runtime references', async () => {
    const store = open(databasePath());
    await store.applyProjectConfiguration(configuration());
    await store.createJob(job());
    await expect(store.createJob(job())).rejects.toThrow('Could not create job');
    await expect(store.createJob({ ...job('job:missing-project'), projectId: 'missing' }))
      .rejects.toThrow('Unknown project');
    await expect(store.createJob({
      ...job('job:wrong-repository'),
      repositoryId: 'remote:github.com/example/missing',
    })).rejects.toThrow('is not associated with project');
    await expect(store.createJob({
      ...job('job:wrong-runtime'),
      preferredRuntimeAgentId: 'engineering/missing',
    })).rejects.toThrow('is not associated with project');
    await expect(store.createAttempt(attempt('attempt:wrong-runtime', 'job:sqlite-one', 'engineering/missing')))
      .rejects.toThrow('is not associated with project');
    await store.close();
  });

  it('assigns sequences transactionally and enforces one active attempt per job', async () => {
    const store = open(databasePath());
    await store.applyProjectConfiguration(configuration());
    await store.createJob(job());
    const first = await store.createAttempt(attempt('attempt:active-one'));
    expect(first.sequence).toBe(1);
    await expect(store.createAttempt(attempt('attempt:active-two')))
      .rejects.toThrow('already has an active attempt');
    expect(await store.listAttemptsForJob(first.jobId)).toHaveLength(1);

    await store.saveAttemptTransition({
      ...first,
      status: 'cancelled',
      finishedAt: TIME,
      revision: 1,
    }, 0);
    const second = await store.createAttempt(attempt('attempt:active-two'));
    expect(second.sequence).toBe(2);
    await store.close();
  });

  it('uses optimistic revisions to reject stale job and attempt transitions', async () => {
    const store = open(databasePath());
    await store.applyProjectConfiguration(configuration());
    const initialJob = job();
    await store.createJob(initialJob);
    const readyJob = { ...initialJob, status: 'ready' as const, revision: 1 };
    await store.saveJobTransition(readyJob, 0);
    await expect(store.saveJobTransition({ ...initialJob, status: 'cancelled', revision: 1 }, 0))
      .rejects.toThrow('Stale job revision');

    const initialAttempt = await store.createAttempt(attempt('attempt:revision'));
    const running = { ...initialAttempt, status: 'running' as const, startedAt: TIME, revision: 1 };
    await store.saveAttemptTransition(running, 0);
    await expect(store.saveAttemptTransition({
      ...running,
      status: 'failed',
      failureReason: 'stale',
      finishedAt: TIME,
      revision: 1,
    }, 0)).rejects.toThrow('Stale attempt revision');
    expect(await store.getAttempt(initialAttempt.id)).toMatchObject({ status: 'running', revision: 1 });
    await store.close();
  });
});
