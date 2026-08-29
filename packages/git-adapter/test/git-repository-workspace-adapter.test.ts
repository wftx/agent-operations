import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    expect(lstatSync(join(destinationPath, 'node_modules')).isDirectory()).toBe(true);
    expect(lstatSync(join(destinationPath, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(
      join(destinationPath, 'node_modules', '.ao-dependency-projection.json'),
      'utf8',
    ))).toMatchObject({ version: 1, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await expect(adapter.createWorkspace(input)).resolves.toMatchObject({ exists: true, registered: true });
    writeFileSync(join(destinationPath, 'README.md'), 'after\n');
    expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe('before\n');
    await expect(adapter.captureEvidence(destinationPath)).resolves.toMatchObject({
      changedFiles: ['README.md'], diffTruncated: false,
    });
    expect(execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });

  it('replaces only the legacy exact dependency link and fails closed on an unowned directory', async () => {
    const { root, source, baseRevision } = fixture();
    const repositoryId = (await new GitRepositoryAdapter().inspectRepository(source)).id;
    const workspaceRoot = join(root, 'state', 'workspaces');
    const destinationPath = join(workspaceRoot, 'job-dependencies');
    const adapter = new GitRepositoryWorkspaceAdapter({ workspaceRoot });
    const input = {
      sourceCheckoutPath: source,
      destinationPath,
      repositoryId,
      baseRevision,
      branchName: 'ao/job-dependencies',
    };
    execFileSync('git', ['-C', source, 'worktree', 'add', '-b', input.branchName, destinationPath, baseRevision]);
    symlinkSync(realpathSync(join(source, 'node_modules')), join(destinationPath, 'node_modules'), 'dir');

    const recovered = await adapter.createWorkspace(input);
    if (recovered.reason) throw new Error(recovered.reason);
    expect(recovered).toMatchObject({
      exists: true,
      registered: true,
    });
    expect(lstatSync(join(destinationPath, 'node_modules')).isDirectory()).toBe(true);
    rmSync(join(destinationPath, 'node_modules'), { recursive: true, force: true });
    mkdirSync(join(destinationPath, 'node_modules'));
    writeFileSync(join(destinationPath, 'node_modules', 'unowned.txt'), 'preserve me');

    await expect(adapter.createWorkspace(input)).resolves.toMatchObject({
      exists: true,
      registered: true,
      reason: expect.stringContaining('not AO owned'),
    });
    expect(readFileSync(join(destinationPath, 'node_modules', 'unowned.txt'), 'utf8')).toBe('preserve me');
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

  it('captures bounded metadata for an added binary without serializing its contents', async () => {
    const { root, source, baseRevision } = fixture();
    const repositoryId = (await new GitRepositoryAdapter().inspectRepository(source)).id;
    const workspaceRoot = join(root, 'state', 'workspaces');
    const destinationPath = join(workspaceRoot, 'job-binary');
    const adapter = new GitRepositoryWorkspaceAdapter({ workspaceRoot });
    await adapter.createWorkspace({
      sourceCheckoutPath: source,
      destinationPath,
      repositoryId,
      baseRevision,
      branchName: 'ao/job-binary',
    });
    mkdirSync(join(destinationPath, 'public'));
    const content = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from([0, 1, 2, 3, 4, 5]),
    ]);
    writeFileSync(join(destinationPath, 'public', 'mirror-x-photo.png'), content);

    const evidence = await adapter.captureEvidence(destinationPath);
    expect(evidence.changedFiles).toEqual(['public/mirror-x-photo.png']);
    expect(evidence.binaryFiles).toEqual([{
      path: 'public/mirror-x-photo.png',
      gitStatus: '??',
      mediaType: 'image/png',
      byteSize: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    }]);
    expect(evidence.diffStat).toContain('public/mirror-x-photo.png | binary');
    expect(evidence.diffText).toContain('content omitted');
    expect(evidence.diffText).not.toContain(content.toString('latin1'));
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
