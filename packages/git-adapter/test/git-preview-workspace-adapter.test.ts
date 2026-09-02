import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitPreviewWorkspaceAdapter, GitRepositoryAdapter } from '../src/index.js';

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('GitPreviewWorkspaceAdapter', () => {
  it('creates a clean detached exact revision worktree without touching a dirty primary checkout', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ao-preview-git-')));
    roots.push(root);
    const source = join(root, 'source');
    const previewRoot = join(root, 'previews');
    const destination = join(previewRoot, 'job-one');
    mkdirSync(source);
    git(source, ['init', '-b', 'main']);
    git(source, ['config', 'user.email', 'test@example.invalid']);
    git(source, ['config', 'user.name', 'AO Test']);
    writeFileSync(join(source, 'page.txt'), 'committed\n');
    git(source, ['add', 'page.txt']);
    git(source, ['commit', '-m', 'fixture']);
    const revision = git(source, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(source, 'page.txt'), 'dirty primary\n');
    const primaryBefore = git(source, ['status', '--porcelain=v1']);
    const repository = await new GitRepositoryAdapter().inspectRepository(source);
    const adapter = new GitPreviewWorkspaceAdapter({ workspaceRoot: previewRoot });

    const inspection = await adapter.prepareReadOnlyWorkspace({
      sourceCheckoutPath: source, destinationPath: destination,
      repositoryId: repository.id, revisionCommit: revision,
    });

    expect(inspection).toMatchObject({ exists: true, registered: true, detachedHead: true, clean: true, revisionCommit: revision });
    expect(git(source, ['status', '--porcelain=v1'])).toBe(primaryBefore);
    expect(git(destination, ['show', 'HEAD:page.txt'])).toBe('committed\n');
    const removed = await adapter.removeReadOnlyWorkspace({ sourceCheckoutPath: source, destinationPath: destination,
      repositoryId: repository.id, revisionCommit: revision });
    expect(removed).toMatchObject({ exists: false });
    expect(git(source, ['status', '--porcelain=v1'])).toBe(primaryBefore);
  });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}
