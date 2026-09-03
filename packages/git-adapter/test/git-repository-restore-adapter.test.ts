import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRepositoryRestoreAdapter } from '../src/index.js';

describe('GitRepositoryRestoreAdapter', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ao-selective-restore-')));
    roots.push(root);
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.test']);
    git(root, ['config', 'user.name', 'AO Test']);
    git(root, ['remote', 'add', 'origin', 'https://github.com/example/restore.git']);
    writeFileSync(join(root, 'main.py'), 'original main\n');
    writeFileSync(join(root, 'synology_client.py'), 'original client\n');
    writeFileSync(join(root, 'unrelated.txt'), 'untouched\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'fixture']);
    const head = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'main.py'), 'modified main\n');
    writeFileSync(join(root, 'synology_client.py'), 'modified client\n');
    git(root, ['add', 'synology_client.py']);
    writeFileSync(join(root, 'unrelated.txt'), 'other modification\n');
    for (const path of ['ONE.md', 'TWO.md', 'THREE.md']) writeFileSync(join(root, path), `${path}\n`);
    return { root, head };
  }

  it('classifies staged, unstaged, and untracked state and restores only exact tracked paths', async () => {
    const { root, head } = fixture();
    const adapter = new GitRepositoryRestoreAdapter();
    const before = await adapter.inspect(root);
    expect(before).toMatchObject({
      repositoryId: 'remote:github.com/example/restore',
      canonicalPath: root,
      branch: 'main',
      headRevision: head,
      detachedHead: false,
    });
    expect(before.statusEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'main.py', indexStatus: 'unmodified', worktreeStatus: 'modified' }),
      expect.objectContaining({ path: 'synology_client.py', indexStatus: 'modified', worktreeStatus: 'unmodified' }),
      expect.objectContaining({ path: 'ONE.md', worktreeStatus: 'untracked' }),
    ]));
    await adapter.restoreTrackedPaths(root, head, ['main.py', 'synology_client.py']);
    expect(readFileSync(join(root, 'main.py'), 'utf8')).toBe('original main\n');
    expect(readFileSync(join(root, 'synology_client.py'), 'utf8')).toBe('original client\n');
    expect(readFileSync(join(root, 'unrelated.txt'), 'utf8')).toBe('other modification\n');
    expect(readFileSync(join(root, 'ONE.md'), 'utf8')).toBe('ONE.md\n');
    const after = await adapter.inspect(root);
    expect(after.statusEntries.map(item => item.path)).not.toContain('main.py');
    expect(after.statusEntries.map(item => item.path)).not.toContain('synology_client.py');
    expect(after.statusEntries.map(item => item.path)).toContain('unrelated.txt');
    expect(after.statusEntries.filter(item => item.worktreeStatus === 'untracked')).toHaveLength(3);
  });

  it('rejects path escapes, wildcard paths, arbitrary revisions, and nested repository scope', async () => {
    const { root, head } = fixture();
    const adapter = new GitRepositoryRestoreAdapter();
    await expect(adapter.restoreTrackedPaths(root, head, ['../outside'])).rejects.toThrow(/unsafe|escape/);
    await expect(adapter.restoreTrackedPaths(root, head, ['*.py'])).rejects.toThrow(/exact/);
    await expect(adapter.restoreTrackedPaths(root, 'HEAD', ['main.py'])).rejects.toThrow(/exact/);
    await expect(adapter.inspect(join(root, 'nested'))).rejects.toThrow();
  });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
  }).trim();
}
