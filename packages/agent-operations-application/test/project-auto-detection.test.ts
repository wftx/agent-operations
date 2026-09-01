import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAgentOperationsStateStore } from '../../agent-operations-contracts/src/testing/in-memory-agent-operations-state-store.js';
import { GitRepositoryAdapter } from '../../git-adapter/src/index.js';
import { LocalProjectResourceInspector } from '../../project-input-adapter/src/index.js';
import { ProjectApplicationService } from '../src/index.js';

const TIME = '2026-08-31T12:00:00.000Z';

describe('Project local folder Git auto detection', () => {
  let root: string;
  let sequence: number;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ao-project-onboarding-')));
    sequence = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the logical repository and checkout binding when Git with a remote is detected', async () => {
    const repository = createRepository('remote-repository');
    git(['remote', 'add', 'origin', 'https://github.com/example/auto-detected.git'], repository);
    const before = repositoryTruth(repository);
    const { projects, store } = application();

    const result = await projects.createProject({
      name: 'Remote Repository', resource: { type: 'local-folder', path: repository },
    });

    expect(result.repositories).toEqual([expect.objectContaining({
      id: 'remote:github.com/example/auto-detected',
      canonicalRemote: 'github.com/example/auto-detected',
    })]);
    expect(result.localFolders).toEqual([]);
    expect(result.repositoryReadiness).toEqual([expect.objectContaining({
      canonicalPath: repository,
      canonicalRemote: 'github.com/example/auto-detected',
      branch: 'main',
      workingTree: 'clean',
    })]);
    expect(result.profile).toMatchObject({
      resourceSummary: 'Git repository detected',
      capabilities: { repositoryReadOnlyJobs: 'available', isolatedCodeChangeJobs: 'available' },
    });
    expect(await store.listCheckoutBindings(result.repositories[0]!.id)).toEqual([
      expect.objectContaining({ canonicalPath: repository, repositoryId: result.repositories[0]!.id }),
    ]);
    expect(repositoryTruth(repository)).toEqual(before);
  });

  it('retains a Git repository with no remote as a local logical repository', async () => {
    const repository = createRepository('no-remote');
    const { projects } = application();

    const result = await projects.createProject({
      name: 'No Remote', resource: { type: 'local-folder', path: repository },
    });

    expect(result.repositories[0]).toMatchObject({ identityKind: 'local', name: 'no-remote' });
    expect(result.repositories[0]!.canonicalRemote).toBeUndefined();
    expect(result.repositoryReadiness[0]).toMatchObject({ canonicalPath: repository, branch: 'main' });
    expect(result.repositoryReadiness[0]!.canonicalRemote).toBeUndefined();
    expect(result.profile.capabilities.repositoryReadOnlyJobs).toBe('available');
  });

  it('preserves the existing explicit Git application contract for non UI callers', async () => {
    const repository = createRepository('explicit-git');
    const { projects } = application();

    const result = await projects.createProject({
      name: 'Explicit Git', resource: { type: 'git-repository', path: repository },
    });

    expect(result.repositories).toHaveLength(1);
    expect(result.localFolders).toEqual([]);
    expect(result.profile.resourceSummary).toBe('Git repository detected');
  });

  it('detects a linked Git worktree whose .git marker is a file', async () => {
    const repository = createRepository('source');
    const worktree = join(root, 'linked-worktree');
    git(['worktree', 'add', '-b', 'feature/auto-detected', worktree], repository);
    const { projects, store } = application();

    const result = await projects.createProject({
      name: 'Linked Worktree', resource: { type: 'local-folder', path: worktree },
    });

    expect(result.repositoryReadiness[0]).toMatchObject({
      canonicalPath: realpathSync(worktree), branch: 'feature/auto-detected', workingTree: 'clean',
    });
    expect((await store.listCheckoutBindings(result.repositories[0]!.id))[0]).toMatchObject({
      canonicalPath: realpathSync(worktree),
    });
  });

  it('preserves a dirty checkout exactly while recording its observed state', async () => {
    const repository = createRepository('dirty');
    writeFileSync(join(repository, 'README.md'), '# dirty\n');
    writeFileSync(join(repository, 'local-note.txt'), 'untracked\n');
    const before = repositoryTruth(repository);
    const { projects } = application();

    const result = await projects.createProject({
      name: 'Dirty Repository', resource: { type: 'local-folder', path: repository },
    });

    expect(result.repositoryReadiness[0]!.workingTree).toBe('dirty');
    expect(repositoryTruth(repository)).toEqual(before);
  });

  it('keeps an ordinary parent folder local and only reports nested Git repositories', async () => {
    const folder = join(root, 'ordinary-folder');
    const nested = join(folder, 'services', 'nested-repository');
    mkdirSync(nested, { recursive: true });
    initializeRepository(nested);
    writeFileSync(join(folder, 'README.md'), '# folder\n');
    const { projects, store } = application();

    const result = await projects.createProject({
      name: 'Ordinary Folder', resource: { type: 'local-folder', path: folder },
    });

    expect(result.repositories).toEqual([]);
    expect(result.repositoryReadiness).toEqual([]);
    expect(result.localFolders).toEqual([expect.objectContaining({ canonicalPath: realpathSync(folder) })]);
    expect(result.profile).toMatchObject({
      resourceSummary: 'Local folder',
      capabilities: { repositoryReadOnlyJobs: 'unavailable', isolatedCodeChangeJobs: 'unavailable' },
    });
    expect(result.profile.warnings).toContain(
      'Nested Git repositories detected: services/nested-repository. Select a nested repository explicitly to bind it.',
    );
    expect(await store.listCheckoutBindings()).toEqual([]);
  });

  it('rejects an invalid path before creating durable Project state', async () => {
    const { projects, store } = application();

    await expect(projects.createProject({
      name: 'Missing', resource: { type: 'local-folder', path: join(root, 'missing') },
    })).rejects.toThrow();
    expect(await store.listProjects()).toEqual([]);
  });

  it('rejects a duplicate installation local binding before creating another Project', async () => {
    const repository = createRepository('duplicate');
    const { projects, store } = application();
    await projects.createProject({ name: 'First', resource: { type: 'local-folder', path: repository } });

    await expect(projects.createProject({
      name: 'Second', resource: { type: 'local-folder', path: repository },
    })).rejects.toThrow('already bound to an Agent Operations Project');
    expect((await store.listProjects()).map(project => project.name)).toEqual(['First']);
  });

  it('leaves Start Without Files unchanged and performs no folder or Git inspection', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const projects = new ProjectApplicationService(
      store,
      { inspectRepository: async () => { throw new Error('Git inspection should not run'); } },
      { inspectLocalFolder: async () => { throw new Error('Folder inspection should not run'); } },
      { now: () => new Date(TIME), projectIdFactory: () => 'project:no-files' },
    );

    const result = await projects.createProject({ name: 'Context Only', resource: { type: 'none' } });

    expect(result.repositories).toEqual([]);
    expect(result.localFolders).toEqual([]);
    expect(result.repositoryReadiness).toEqual([]);
    expect(result.profile.resourceSummary).toBe('No resource attached');
  });

  function application() {
    const store = new InMemoryAgentOperationsStateStore();
    const projects = new ProjectApplicationService(
      store,
      new GitRepositoryAdapter({ now: () => new Date(TIME) }),
      new LocalProjectResourceInspector(),
      { now: () => new Date(TIME), projectIdFactory: () => `project:${++sequence}` },
    );
    return { projects, store };
  }

  function createRepository(name: string): string {
    const repository = join(root, name);
    mkdirSync(repository);
    initializeRepository(repository);
    return realpathSync(repository);
  }

  function initializeRepository(repository: string): void {
    git(['init', '-b', 'main'], repository);
    git(['config', 'user.email', 'tests@example.test'], repository);
    git(['config', 'user.name', 'Agent Operations Tests'], repository);
    writeFileSync(join(repository, 'README.md'), '# fixture\n');
    git(['add', 'README.md'], repository);
    git(['commit', '-m', 'fixture'], repository);
  }

  function repositoryTruth(repository: string): object {
    return {
      head: git(['rev-parse', 'HEAD'], repository),
      status: git(['status', '--porcelain=v1', '--untracked-files=normal'], repository),
      remotes: git(['remote', '-v'], repository),
    };
  }

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    }).trim();
  }
});
