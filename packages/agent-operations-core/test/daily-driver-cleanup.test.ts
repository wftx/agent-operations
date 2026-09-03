import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DurableProjectConfiguration,
  RepositoryWorkspaceAdapter,
} from '../../agent-operations-contracts/src/index.js';
import {
  FakeRepositoryInventoryAdapter,
  InMemoryAgentOperationsStateStore,
  createRepositoryCheckoutBindingId,
  createExecutionDispatchIdempotencyKey,
} from '../../agent-operations-contracts/src/index.js';
import { GitRepositoryRestoreAdapter } from '../../git-adapter/src/index.js';
import {
  JobLifecycleService,
  JobRetirementService,
  RepositoryRestoreService,
  RepositoryWorkspaceService,
} from '../src/index.js';

const TIME = '2026-09-03T12:00:00.000Z';
const INSTALLATION = 'installation:cleanup';

describe('Daily Driver lifecycle cleanup', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('allows unrelated repositories, blocks the same repository, and releases retired ownership', async () => {
    const store = new InMemoryAgentOperationsStateStore({ installation: { id: INSTALLATION, createdAt: TIME } });
    await configureTwoRepositories(store);
    const repositories = new FakeRepositoryInventoryAdapter([
      summary('remote:github.com/example/a', '/fixtures/a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      summary('remote:github.com/example/b', '/fixtures/b', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      summary('remote:github.com/example/c', '/fixtures/c', 'cccccccccccccccccccccccccccccccccccccccc'),
    ]);
    const existing = new Set<string>();
    const adapter: RepositoryWorkspaceAdapter = {
      createWorkspace: async input => {
        existing.add(input.destinationPath);
        return inspection(input);
      },
      inspectWorkspace: async input => existing.has(input.destinationPath)
        ? inspection(input) : { exists: false, registered: false },
      captureEvidence: async () => ({
        changedFiles: [], diffStat: '', diffText: '', diffTruncated: false,
      }),
      removeWorkspace: async input => {
        existing.delete(input.destinationPath);
        return { exists: false, registered: false };
      },
    };
    const workspaces = new RepositoryWorkspaceService(store, repositories, adapter, {
      stateDirectory: '/ao-state', now: () => new Date(TIME), globalActiveWorkspaceLimit: 2,
    });
    const jobA = await writeJob(store, 'job:a', 'project:cleanup', 'remote:github.com/example/a');
    const jobB = await writeJob(store, 'job:b', 'project:cleanup', 'remote:github.com/example/b');
    const workspaceA = await workspaces.prepareForJob(jobA.id);
    await expect(workspaces.prepareForJob(jobB.id)).resolves.toMatchObject({ repositoryId: jobB.repositoryId });
    const jobA2 = await writeJob(store, 'job:a2', 'project:cleanup', 'remote:github.com/example/a');
    await expect(workspaces.prepareForJob(jobA2.id)).rejects.toThrow(/same|repository|already owns/i);
    const jobC = await writeJob(store, 'job:c', 'project:cleanup', 'remote:github.com/example/c');
    await expect(workspaces.prepareForJob(jobC.id)).rejects.toThrow(/global.*limit/i);

    const afterRestart = new RepositoryWorkspaceService(store, repositories, adapter, {
      stateDirectory: '/ao-state', now: () => new Date(TIME), globalActiveWorkspaceLimit: 2,
    });
    await expect(afterRestart.prepareForJob(jobA.id)).resolves.toMatchObject({ id: workspaceA.id });

    await workspaces.captureEvidence(workspaceA.id);
    const retirement = new JobRetirementService(store, workspaces, () => new Date(TIME));
    const retired = await retirement.retire({
      jobId: jobA.id,
      disposition: 'externally-published',
      reason: 'Published commit matches reviewed evidence.',
      actor: 'operator',
      evidenceReference: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(await store.getRepositoryWorkspace(workspaceA.id)).toMatchObject({ state: 'cleaned' });
    expect(await store.getJobRetirement(jobA.id)).toMatchObject({ disposition: 'externally-published' });
    await expect(retirement.retire({
      jobId: jobA.id, disposition: 'retired', reason: 'Repeated request.', actor: 'other',
    })).resolves.toEqual(retired);
    await expect(workspaces.prepareForJob(jobA2.id)).resolves.toMatchObject({ repositoryId: jobA.repositoryId });
  });

  it('prepares an exact Red action, fails closed on drift, and preserves three untracked files', async () => {
    const root = repositoryFixture(roots);
    const adapter = new GitRepositoryRestoreAdapter();
    const inspected = await adapter.inspect(root);
    const store = new InMemoryAgentOperationsStateStore({ installation: { id: INSTALLATION, createdAt: TIME } });
    const bindingId = createRepositoryCheckoutBindingId(INSTALLATION, root);
    await store.applyProjectConfiguration({
      project: { id: 'project:roger', name: 'Roger', createdAt: TIME, updatedAt: TIME },
      repositories: [{
        id: inspected.repositoryId, identityKind: 'remote', name: 'roger',
        canonicalRemote: 'github.com/example/restore', createdAt: TIME, updatedAt: TIME,
      }],
      checkoutBindings: [{
        id: bindingId, repositoryId: inspected.repositoryId, installationId: INSTALLATION,
        canonicalPath: root, availability: 'available', firstSeenAt: TIME, lastSeenAt: TIME,
      }],
      runtimeAgentIds: [],
    });
    let id = 0;
    const service = new RepositoryRestoreService(store, adapter, {
      now: () => new Date(TIME), idFactory: () => `repository-restore:${++id}`,
    });
    const request = {
      projectId: 'project:roger', repositoryId: inspected.repositoryId, checkoutBindingId: bindingId,
      restorePaths: ['main.py', 'synology_client.py'],
      preserveUntrackedPaths: ['ONE.md', 'TWO.md', 'THREE.md'],
      requestedBy: 'operator', expectedBranch: 'main', expectedHead: inspected.headRevision,
    };
    const stale = await service.prepare(request);
    writeFileSync(join(root, 'main.py'), 'changed after approval request\n');
    await expect(service.approveAndExecute(stale.id, 'operator')).rejects.toThrow(/changed|Fresh approval/);

    writeFileSync(join(root, 'main.py'), 'modified main\n');
    const action = await service.prepare(request);
    const completed = await service.approveAndExecute(action.id, 'operator');
    expect(completed).toMatchObject({ state: 'completed', approvedBy: 'operator' });
    expect(readFileSync(join(root, 'main.py'), 'utf8')).toBe('original main\n');
    expect(readFileSync(join(root, 'synology_client.py'), 'utf8')).toBe('original client\n');
    for (const path of ['ONE.md', 'TWO.md', 'THREE.md']) {
      expect(readFileSync(join(root, path), 'utf8')).toBe(`${path}\n`);
    }
    await expect(service.approveAndExecute(action.id, 'operator')).resolves.toMatchObject({ state: 'completed' });
  });

  it.each(['submitting', 'uncertain', 'accepted'] as const)(
    'blocks retirement while a %s provider execution may still be active',
    async status => {
      const store = new InMemoryAgentOperationsStateStore({ installation: { id: INSTALLATION, createdAt: TIME } });
      await store.applyProjectConfiguration({
        project: { id: 'project:active', name: 'Active', createdAt: TIME, updatedAt: TIME },
        repositories: [], checkoutBindings: [], runtimeAgentIds: ['runtime:test'],
      });
      const lifecycle = new JobLifecycleService(store, {
        now: () => new Date(TIME), jobIdFactory: () => `job:${status}`,
        attemptIdFactory: () => `attempt:${status}`,
      });
      const job = await lifecycle.createJob({ projectId: 'project:active', title: status });
      await lifecycle.markJobReady(job.id);
      const created = await lifecycle.createAttempt(job.id, { runtimeAgentId: 'runtime:test' });
      const attempt = status === 'accepted' ? await lifecycle.startAttempt(created.id) : created;
      const planId = `plan:${status}`;
      await store.createExecutionPlan({
        id: planId, attemptId: attempt.id, jobId: job.id, projectId: job.projectId,
        installationId: INSTALLATION, runtimeAgentId: 'runtime:test',
        input: { version: 1, instruction: 'Existing immutable execution.' },
        requestedPolicy: { version: 1, filesystem: 'none', network: 'deny', environment: 'empty' },
        requestedCapabilities: { version: 1, repositoryRead: false },
        jobRevisionAtPreparation: 1, attemptRevisionAtPreparation: attempt.revision,
        createdAt: TIME,
      });
      const prepared = {
        id: `dispatch:${status}`, executionPlanId: planId, attemptId: attempt.id, jobId: job.id,
        runtimeAgentId: 'runtime:test', idempotencyKey: createExecutionDispatchIdempotencyKey(planId),
        status: 'prepared' as const, revision: 0, createdAt: TIME, updatedAt: TIME,
      };
      await store.createExecutionDispatch(prepared);
      const submitting = {
        ...prepared, status: 'submitting' as const, submittedAt: TIME, revision: 1,
      };
      await store.saveExecutionDispatchTransition(submitting, 0);
      if (status !== 'submitting') {
        await store.saveExecutionDispatchTransition({
          ...submitting, status, externalReference: `turn:${status}`, resolvedAt: TIME,
          ...(status === 'accepted'
            ? {
                acceptedAt: TIME,
                effectivePolicy: { version: 1 as const, filesystem: 'none' as const, network: 'deny' as const, environment: 'empty' as const },
                effectiveCapabilities: { version: 1 as const, repositoryRead: false },
              }
            : {}),
          revision: 2,
        }, 1);
      }
      const retirement = new JobRetirementService(store, {} as RepositoryWorkspaceService);
      await expect(retirement.retire({
        jobId: job.id, disposition: 'retired', reason: 'Do not allow this.', actor: 'operator',
      })).rejects.toThrow(/provider boundary/);
      expect(await store.getJobRetirement(job.id)).toBeNull();
    },
  );

  it('refuses to discard unique dirty workspace changes during retirement', async () => {
    const store = new InMemoryAgentOperationsStateStore({ installation: { id: INSTALLATION, createdAt: TIME } });
    await configureTwoRepositories(store);
    const repositories = new FakeRepositoryInventoryAdapter([
      summary('remote:github.com/example/a', '/fixtures/a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    ]);
    const adapter: RepositoryWorkspaceAdapter = {
      createWorkspace: async input => inspection(input),
      inspectWorkspace: async input => inspection(input),
      captureEvidence: async () => ({
        changedFiles: ['proof.txt'], diffStat: ' proof.txt | 1 +', diffText: '+unique\n', diffTruncated: false,
      }),
      removeWorkspace: async () => {
        throw new Error('dirty workspace removal must not be attempted');
      },
    };
    const workspaces = new RepositoryWorkspaceService(store, repositories, adapter, {
      stateDirectory: '/ao-state', now: () => new Date(TIME),
    });
    const job = await writeJob(store, 'job:dirty', 'project:cleanup', 'remote:github.com/example/a');
    const workspace = await workspaces.prepareForJob(job.id);
    await workspaces.captureEvidence(workspace.id);
    const retirement = new JobRetirementService(store, workspaces, () => new Date(TIME));
    await expect(retirement.retire({
      jobId: job.id, disposition: 'retired', reason: 'Obsolete proof.', actor: 'operator',
    })).rejects.toThrow(/unique dirty changes/);
    expect(await store.getJobRetirement(job.id)).toBeNull();
  });

  it('rejects untracked restore targets and active same repository workspaces', async () => {
    const root = repositoryFixture(roots);
    const adapter = new GitRepositoryRestoreAdapter();
    const inspected = await adapter.inspect(root);
    const store = new InMemoryAgentOperationsStateStore({ installation: { id: INSTALLATION, createdAt: TIME } });
    const bindingId = createRepositoryCheckoutBindingId(INSTALLATION, root);
    await store.applyProjectConfiguration({
      project: { id: 'project:roger', name: 'Roger', createdAt: TIME, updatedAt: TIME },
      repositories: [{ id: inspected.repositoryId, identityKind: 'remote', name: 'roger', canonicalRemote: 'github.com/example/restore', createdAt: TIME, updatedAt: TIME }],
      checkoutBindings: [{ id: bindingId, repositoryId: inspected.repositoryId, installationId: INSTALLATION, canonicalPath: root, availability: 'available', firstSeenAt: TIME, lastSeenAt: TIME }],
      runtimeAgentIds: [],
    });
    const service = new RepositoryRestoreService(store, adapter, { idFactory: () => 'repository-restore:block' });
    await expect(service.prepare({
      projectId: 'project:roger', repositoryId: inspected.repositoryId, checkoutBindingId: bindingId,
      restorePaths: ['main.py'], requestedBy: 'operator', expectedBranch: 'other',
    })).rejects.toThrow(/branch changed/);
    await expect(service.prepare({
      projectId: 'project:roger', repositoryId: inspected.repositoryId, checkoutBindingId: bindingId,
      restorePaths: ['main.py'], requestedBy: 'operator', expectedHead: '0'.repeat(40),
    })).rejects.toThrow(/HEAD changed/);
    await expect(service.prepare({
      projectId: 'project:roger', repositoryId: inspected.repositoryId, checkoutBindingId: bindingId,
      restorePaths: ['ONE.md'], requestedBy: 'operator',
    })).rejects.toThrow(/not a changed tracked path/);

    const owner = await writeJob(store, 'job:owner', 'project:roger', inspected.repositoryId);
    const preparing = {
      id: 'workspace:owner', jobId: owner.id, projectId: owner.projectId,
      repositoryId: inspected.repositoryId, sourceCheckoutBindingId: bindingId,
      baseRevision: inspected.headRevision, baseBranch: 'main', branchName: 'ao/job-owner',
      canonicalPath: `${root}-worktree`, state: 'preparing' as const, revision: 0,
      createdAt: TIME, updatedAt: TIME,
    };
    await store.createRepositoryWorkspace(preparing);
    await store.saveRepositoryWorkspaceTransition({
      ...preparing, state: 'active', revision: 1,
    }, 0);
    await expect(service.prepare({
      projectId: 'project:roger', repositoryId: inspected.repositoryId, checkoutBindingId: bindingId,
      restorePaths: ['main.py'], requestedBy: 'operator',
    })).rejects.toThrow(/active same repository workspace/);
  });
});

async function configureTwoRepositories(store: InMemoryAgentOperationsStateStore): Promise<void> {
  const repositories = [
    { id: 'remote:github.com/example/a', path: '/fixtures/a' },
    { id: 'remote:github.com/example/b', path: '/fixtures/b' },
    { id: 'remote:github.com/example/c', path: '/fixtures/c' },
  ];
  const configuration: DurableProjectConfiguration = {
    project: { id: 'project:cleanup', name: 'Cleanup', createdAt: TIME, updatedAt: TIME },
    repositories: repositories.map(item => ({
      id: item.id, identityKind: 'remote', name: item.id.at(-1)!, canonicalRemote: item.id.slice(7),
      createdAt: TIME, updatedAt: TIME,
    })),
    checkoutBindings: repositories.map(item => ({
      id: createRepositoryCheckoutBindingId(INSTALLATION, item.path), repositoryId: item.id,
      installationId: INSTALLATION, canonicalPath: item.path, availability: 'available',
      firstSeenAt: TIME, lastSeenAt: TIME,
    })),
    runtimeAgentIds: [],
  };
  await store.applyProjectConfiguration(configuration);
}

async function writeJob(store: InMemoryAgentOperationsStateStore, id: string, projectId: string, repositoryId: string) {
  const lifecycle = new JobLifecycleService(store, {
    now: () => new Date(TIME), jobIdFactory: () => id,
  });
  const job = await lifecycle.createJob({
    projectId, repositoryId, title: id, executionMode: 'repository-write-isolated',
  });
  return lifecycle.markJobReady(job.id);
}

function summary(id: string, path: string, head: string) {
  return {
    id, identityKind: 'remote' as const, name: id, checkoutPath: path, repositoryRoot: path,
    availability: 'available' as const, branch: 'main', detachedHead: false, headCommit: head,
    workingTree: 'clean' as const, remotes: [], observedAt: TIME,
  };
}

function inspection(input: { destinationPath: string; repositoryId: string; branchName: string; baseRevision: string }) {
  return {
    exists: true, registered: true, canonicalPath: input.destinationPath,
    repositoryId: input.repositoryId, branchName: input.branchName, headRevision: input.baseRevision,
  };
}

function repositoryFixture(roots: string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ao-restore-service-')));
  roots.push(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.test']);
  git(root, ['config', 'user.name', 'AO Test']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/example/restore.git']);
  writeFileSync(join(root, 'main.py'), 'original main\n');
  writeFileSync(join(root, 'synology_client.py'), 'original client\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  writeFileSync(join(root, 'main.py'), 'modified main\n');
  writeFileSync(join(root, 'synology_client.py'), 'modified client\n');
  git(root, ['add', 'synology_client.py']);
  for (const path of ['ONE.md', 'TWO.md', 'THREE.md']) writeFileSync(join(root, path), `${path}\n`);
  return root;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' } }).trim();
}
