import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DurableProjectConfiguration,
  DurableRepositoryObservation,
  DurableRuntimeObservation,
} from '../../agent-operations-contracts/src/index.js';
import { createRepositoryCheckoutBindingId } from '../../agent-operations-contracts/src/index.js';
import {
  SqliteAgentOperationsStateStore,
  resolveAgentOperationsStateLocation,
} from '../src/index.js';

const TIME = '2026-06-07T08:09:10.000Z';
const INSTALLATION_ID = 'installation:sqlite-test';
const REPOSITORY_ID = 'remote:github.com/wftx/agent-operations';
const temporaryDirectories: string[] = [];

function temporaryPath(...parts: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'ao-state-'));
  temporaryDirectories.push(directory);
  return join(directory, ...parts);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configuration(path = '/repos/agent-operations'): DurableProjectConfiguration {
  return {
    project: { id: 'ao', name: 'Agent Operations', createdAt: TIME, updatedAt: TIME },
    repositories: [{
      id: REPOSITORY_ID,
      identityKind: 'remote',
      name: 'agent-operations',
      canonicalRemote: 'github.com/wftx/agent-operations',
      createdAt: TIME,
      updatedAt: TIME,
    }],
    checkoutBindings: [{
      id: createRepositoryCheckoutBindingId(INSTALLATION_ID, path),
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      canonicalPath: path,
      availability: 'available',
      firstSeenAt: TIME,
      lastSeenAt: TIME,
    }],
    runtimeAgentIds: ['operations/agent'],
  };
}

function open(databasePath: string): SqliteAgentOperationsStateStore {
  return SqliteAgentOperationsStateStore.open({
    databasePath,
    installationIdFactory: () => INSTALLATION_ID,
    installationLabel: 'SQLite test',
    now: () => new Date(TIME),
  });
}

describe('SQLite Agent Operations state store', () => {
  it('creates a missing state directory, applies the initial migration once, and creates installation identity', async () => {
    const databasePath = temporaryPath('missing', 'nested', 'state.db');
    const store = open(databasePath);
    expect(await store.getInstallation()).toEqual({
      id: INSTALLATION_ID,
      createdAt: TIME,
      label: 'SQLite test',
    });
    await store.close();

    const database = new Database(databasePath, { readonly: true });
    expect(database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, name: 'initial-agent-operations-state' },
      { version: 2, name: 'durable-jobs-and-attempts' },
      { version: 3, name: 'immutable-execution-plans' },
      { version: 4, name: 'manual-execution-dispatches' },
      { version: 5, name: 'execution-observations-and-outcomes' },
      { version: 6, name: 'runtime-capability-policy' },
      { version: 7, name: 'exact-execution-context-evidence' },
      { version: 8, name: 'repository-read-execution-capability' },
      { version: 9, name: 'mvp-orchestrator-review-and-escalation' },
      { version: 10, name: 'daily-operator-runs-guidance-and-notifications' },
      { version: 11, name: 'late-execution-reconciliation' },
      { version: 12, name: 'isolated-write-job-workspaces' },
      { version: 13, name: 'project-onboarding-and-job-inputs' },
    ]);
    database.close();

    const reopened = open(databasePath);
    expect(await reopened.getInstallation()).toMatchObject({ id: INSTALLATION_ID, createdAt: TIME });
    await reopened.close();
  });

  it('persists Project Resources, Profiles, and immutable Input associations across reopen', async () => {
    const databasePath = temporaryPath('state.db');
    const store = open(databasePath);
    await store.applyProjectConfiguration(configuration());
    await store.createLocalFolderResource({
      id: `resource:folder:${'a'.repeat(64)}`, projectId: 'ao', installationId: INSTALLATION_ID,
      canonicalPath: '/projects/context', fingerprint: 'b'.repeat(64), availability: 'available',
      firstSeenAt: TIME, lastSeenAt: TIME,
    });
    await store.saveProjectProfile({
      projectId: 'ao', resourceSummary: 'Existing Git repository', detectedStack: ['Node.js'],
      packageManager: 'npm', buildCommandCandidates: ['npm run build'], testCommandCandidates: [],
      previewCommandCandidates: [], deploymentClues: [], documentation: [],
      capabilities: {
        repositoryReadOnlyJobs: 'available', isolatedCodeChangeJobs: 'available',
        boundedFileInspection: 'available', inputs: 'available', orchestratorConversation: 'available',
        build: 'detected-unvalidated', preview: 'unknown', publish: 'unknown',
      },
      warnings: [], knownConstraints: [], agentsFileSuggestion: true, inspectedAt: TIME, revision: 0,
    });
    await store.createInput({
      id: 'input:one', displayName: 'brief.pdf', mimeType: 'application/pdf', byteSize: 42,
      sha256: 'c'.repeat(64), sourceType: 'uploaded-file', projectId: 'ao',
      storageReference: '/private/ao/inputs/one/content', ingestionState: 'complete',
      validationState: 'valid', createdAt: TIME,
    });
    await store.associateInputsWithConversation('conversation:one', ['input:one']);
    await store.close();

    const reopened = open(databasePath);
    expect(await reopened.listLocalFolderResources('ao')).toHaveLength(1);
    expect(await reopened.getProjectProfile('ao')).toMatchObject({ projectId: 'ao', detectedStack: ['Node.js'] });
    expect(await reopened.getInput('input:one')).toMatchObject({ displayName: 'brief.pdf', byteSize: 42 });
    expect(await reopened.listConversationInputIds('conversation:one')).toEqual(['input:one']);
    await reopened.close();
  });

  it('persists configured projects, logical repositories, checkout bindings, and associations across reopen', async () => {
    const databasePath = temporaryPath('state.db');
    const store = open(databasePath);
    const configured = configuration();
    await store.applyProjectConfiguration(configured);
    await store.close();

    const reopened = open(databasePath);
    expect(await reopened.getProject('ao')).toEqual(configured.project);
    expect(await reopened.getRepository(REPOSITORY_ID)).toEqual(configured.repositories[0]);
    expect(await reopened.listCheckoutBindings(REPOSITORY_ID)).toEqual(configured.checkoutBindings);
    expect(await reopened.listProjectRepositoryIds('ao')).toEqual([REPOSITORY_ID]);
    expect(await reopened.listProjectRuntimeAgentIds('ao')).toEqual(['operations/agent']);
    await reopened.close();
  });

  it('treats repeated project configuration as an idempotent update while preserving creation time', async () => {
    const store = open(temporaryPath('state.db'));
    const configured = configuration();
    await store.applyProjectConfiguration(configured);
    const runtimeObservation: DurableRuntimeObservation = {
      projectId: 'ao',
      agentId: 'operations/agent',
      associationState: 'available',
      runtimeState: 'running',
      observedAt: TIME,
    };
    await store.recordRuntimeObservation(runtimeObservation);
    await store.applyProjectConfiguration({
      ...configured,
      project: {
        ...configured.project,
        name: 'Agent Operations Renamed',
        createdAt: '2099-01-01T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
      runtimeAgentIds: [],
    });
    expect(await store.getProject('ao')).toEqual({
      id: 'ao',
      name: 'Agent Operations Renamed',
      createdAt: TIME,
      updatedAt: '2026-06-08T00:00:00.000Z',
    });
    expect(await store.listProjects()).toHaveLength(1);
    expect(await store.listProjectRuntimeAgentIds('ao')).toEqual([]);
    expect(await store.getLatestRuntimeObservation('ao', 'operations/agent')).toEqual(runtimeObservation);
    await store.close();
  });

  it('stores and retrieves the newest normalized repository and runtime observations', async () => {
    const store = open(temporaryPath('state.db'));
    const configured = configuration();
    await store.applyProjectConfiguration(configured);
    const olderRepository: DurableRepositoryObservation = {
      repositoryId: REPOSITORY_ID,
      checkoutBindingId: configured.checkoutBindings[0].id,
      availability: 'available',
      branch: 'main',
      detachedHead: false,
      headCommit: 'a'.repeat(40),
      workingTree: 'clean',
      observedAt: '2026-06-07T08:00:00.000Z',
    };
    const newerRepository: DurableRepositoryObservation = {
      ...olderRepository,
      workingTree: 'dirty',
      reason: 'Uncommitted Phase 6 work',
      observedAt: TIME,
    };
    await store.recordRepositoryObservation(newerRepository);
    await store.recordRepositoryObservation(olderRepository);
    expect(await store.getLatestRepositoryObservation(configured.checkoutBindings[0].id))
      .toEqual(newerRepository);

    const runtime: DurableRuntimeObservation = {
      projectId: 'ao',
      agentId: 'operations/agent',
      associationState: 'available',
      provider: 'codex',
      runtimeState: 'running',
      enabled: null,
      configured: true,
      lastHeartbeat: TIME,
      observedAt: TIME,
    };
    await store.recordRuntimeObservation(runtime);
    expect(await store.getLatestRuntimeObservation('ao', 'operations/agent')).toEqual(runtime);
    await store.close();
  });

  it('allows one logical repository to have multiple checkout paths without changing its identity', async () => {
    const store = open(temporaryPath('state.db'));
    const first = configuration('/repos/one');
    await store.applyProjectConfiguration({
      ...first,
      checkoutBindings: [first.checkoutBindings[0], configuration('/repos/two').checkoutBindings[0]],
    });
    const bindings = await store.listCheckoutBindings(REPOSITORY_ID);
    expect(bindings.map(binding => binding.canonicalPath)).toEqual(['/repos/one', '/repos/two']);
    expect(new Set(bindings.map(binding => binding.repositoryId))).toEqual(new Set([REPOSITORY_ID]));
    await store.close();
  });

  it('keeps local-only identity explicit and scoped checkout IDs distinct across installations', async () => {
    const localId = `local:${'b'.repeat(64)}`;
    const store = open(temporaryPath('state.db'));
    await store.applyProjectConfiguration({
      project: { id: 'local-project', name: 'Local', createdAt: TIME, updatedAt: TIME },
      repositories: [{
        id: localId,
        identityKind: 'local',
        name: 'scratch',
        createdAt: TIME,
        updatedAt: TIME,
      }],
      checkoutBindings: [{
        id: createRepositoryCheckoutBindingId(INSTALLATION_ID, '/repos/scratch'),
        repositoryId: localId,
        installationId: INSTALLATION_ID,
        canonicalPath: '/repos/scratch',
        availability: 'available',
        firstSeenAt: TIME,
        lastSeenAt: TIME,
      }],
      runtimeAgentIds: [],
    });
    expect(await store.getRepository(localId)).toMatchObject({ identityKind: 'local' });
    expect(createRepositoryCheckoutBindingId(INSTALLATION_ID, '/repos/scratch'))
      .not.toBe(createRepositoryCheckoutBindingId('installation:other', '/repos/scratch'));
    await store.close();
  });

  it('rolls back contradictory checkout identity and rejects unknown observation associations', async () => {
    const store = open(temporaryPath('state.db'));
    const initial = configuration();
    await store.applyProjectConfiguration(initial);
    const conflictingRepositoryId = 'remote:github.com/wftx/different';
    await expect(store.applyProjectConfiguration({
      project: { ...initial.project, name: 'Should roll back' },
      repositories: [{
        ...initial.repositories[0],
        id: conflictingRepositoryId,
        name: 'different',
        canonicalRemote: 'github.com/wftx/different',
      }],
      checkoutBindings: [{
        ...initial.checkoutBindings[0],
        id: createRepositoryCheckoutBindingId(INSTALLATION_ID, '/repos/agent-operations'),
        repositoryId: conflictingRepositoryId,
      }],
      runtimeAgentIds: [],
    })).rejects.toThrow('Checkout path identity conflict');
    expect((await store.getProject('ao'))?.name).toBe('Agent Operations');
    expect(await store.getRepository(conflictingRepositoryId)).toBeNull();

    await expect(store.recordRuntimeObservation({
      projectId: 'ao',
      agentId: 'unknown/agent',
      associationState: 'unavailable',
      observedAt: TIME,
    })).rejects.toThrow('Could not record runtime observation');
    await store.close();
  });

  it('rolls back a failed migration and refuses a corrupt database', async () => {
    const databasePath = temporaryPath('state.db');
    expect(() => SqliteAgentOperationsStateStore.open({
      databasePath,
      installationIdFactory: () => INSTALLATION_ID,
      now: () => new Date(TIME),
      additionalMigrations: [{
        version: 14,
        name: 'deliberate-test-failure',
        up: database => {
          database.exec('CREATE TABLE should_rollback (id TEXT)');
          database.exec('THIS IS NOT SQL');
        },
      }],
    })).toThrow('Could not open Agent Operations state');

    const database = new Database(databasePath, { readonly: true });
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
    ).get()).toBeUndefined();
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }]);
    database.close();

    const corruptPath = temporaryPath('corrupt.db');
    writeFileSync(corruptPath, 'not a SQLite database', 'utf8');
    expect(() => open(corruptPath)).toThrow('Could not open Agent Operations state');
  });
});

describe('Agent Operations state location', () => {
  it('defaults outside CortextOS and accepts directory or database overrides', () => {
    expect(resolveAgentOperationsStateLocation({}, '/home/test')).toEqual({
      stateDirectory: '/home/test/.agent-operations',
      databasePath: '/home/test/.agent-operations/state.db',
    });
    expect(resolveAgentOperationsStateLocation({ AGENT_OPERATIONS_STATE_DIR: '/srv/ao' }, '/ignored'))
      .toEqual({ stateDirectory: '/srv/ao', databasePath: '/srv/ao/state.db' });
    expect(resolveAgentOperationsStateLocation({ AGENT_OPERATIONS_DATABASE_PATH: '/data/custom.db' }, '/ignored'))
      .toEqual({ stateDirectory: '/data', databasePath: '/data/custom.db' });
  });
});
