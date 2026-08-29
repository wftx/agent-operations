import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRepositoryAdapter, GitRepositoryWorkspaceAdapter } from '../src/index.js';

describe('GitRepositoryWorkspaceAdapter', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ao-workspace-')));
    roots.push(root);
    const source = join(root, 'source');
    execFileSync('git', ['init', '--initial-branch=main', source]);
    execFileSync('git', ['-C', source, 'config', 'user.email', 'ao@example.invalid']);
    execFileSync('git', ['-C', source, 'config', 'user.name', 'AO Test']);
    execFileSync('git', ['-C', source, 'remote', 'add', 'origin', 'https://github.com/wftx/agent-operations.git']);
    writeFileSync(join(source, 'README.md'), 'before\n');
    writeFileSync(join(source, '.gitignore'), 'node_modules\n');
    execFileSync('git', ['-C', source, 'add', 'README.md', '.gitignore']);
    execFileSync('git', ['-C', source, 'commit', '-m', 'fixture']);
    mkdirSync(join(source, 'node_modules'));
    const baseRevision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return { root, source, baseRevision };
  }

  it('creates and recovers exactly one isolated worktree without changing source files', async () => {
    const { root, source, baseRevision } = fixture();
    const repositoryId = (await new GitRepositoryAdapter().inspectRepository(source)).id;
    const destinationPath = join(root, 'state', 'workspaces', 'job-one');
    const adapter = new GitRepositoryWorkspaceAdapter({ workspaceRoot: join(root, 'state', 'workspaces') });
    const input = {
      sourceCheckoutPath: source,
      destinationPath,
      repositoryId,
      baseRevision,
      branchName: 'ao/job-one',
    };
    await expect(adapter.createWorkspace(input)).resolves.toMatchObject({
      exists: true, registered: true, repositoryId, branchName: 'ao/job-one', headRevision: baseRevision,
    });
    expect(realpathSync(join(destinationPath, 'node_modules')))
      .toBe(realpathSync(join(source, 'node_modules')));
    await expect(adapter.createWorkspace(input)).resolves.toMatchObject({ exists: true, registered: true });
    writeFileSync(join(destinationPath, 'README.md'), 'after\n');
    expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('before\n');
    await expect(adapter.captureEvidence(destinationPath)).resolves.toMatchObject({
      changedFiles: ['README.md'], diffTruncated: false,
    });
    expect(execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });

  it('rejects a destination outside the AO workspace root', async () => {
    const { root, source, baseRevision } = fixture();
    const repositoryId = (await new GitRepositoryAdapter().inspectRepository(source)).id;
    const adapter = new GitRepositoryWorkspaceAdapter({ workspaceRoot: join(root, 'state', 'workspaces') });
    await expect(adapter.createWorkspace({
      sourceCheckoutPath: source,
      destinationPath: join(root, 'outside'),
      repositoryId,
      baseRevision,
      branchName: 'ao/job-two',
    })).rejects.toThrow('child of the AO workspace root');
  });

  it('removes only the exact clean AO worktree and preserves its branch and unrelated worktrees', async () => {
    const { root, source, baseRevision } = fixture();
    const repositoryId = (await new GitRepositoryAdapter().inspectRepository(source)).id;
    const workspaceRoot = join(root, 'state', 'workspaces');
    const adapter = new GitRepositoryWorkspaceAdapter({ workspaceRoot });
    const first = {
      sourceCheckoutPath: source,
      destinationPath: join(workspaceRoot, 'job-cleanup-one'),
      repositoryId,
      baseRevision,
      branchName: 'ao/job-cleanup-one',
    };
    const second = {
      ...first,
      destinationPath: join(workspaceRoot, 'job-cleanup-two'),
      branchName: 'ao/job-cleanup-two',
    };
    await adapter.createWorkspace(first);
    await adapter.createWorkspace(second);
    writeFileSync(join(first.destinationPath, 'README.md'), 'dirty\n');
    await expect(adapter.removeWorkspace(first)).resolves.toMatchObject({
      exists: true,
      registered: true,
      reason: expect.stringContaining('failed safely'),
    });
    writeFileSync(join(first.destinationPath, 'README.md'), 'before\n');
    await expect(adapter.removeWorkspace(first)).resolves.toMatchObject({
      exists: false,
      registered: false,
    });
    await expect(adapter.inspectWorkspace(second)).resolves.toMatchObject({
      exists: true,
      registered: true,
      branchName: 'ao/job-cleanup-two',
    });
    expect(execFileSync('git', ['-C', source, 'rev-parse', '--verify', 'refs/heads/ao/job-cleanup-one'], {
      encoding: 'utf8',
    }).trim()).toBe(baseRevision);
    expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('before\n');
  });
});
