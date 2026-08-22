import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRepositoryAdapter } from '../src/index.js';

const OBSERVED_AT = '2026-03-04T05:06:07.000Z';

describe('GitRepositoryAdapter', () => {
  let root: string;
  let repository: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ao-git-adapter-'));
    repository = join(root, 'repository');
    mkdirSync(repository);
    git(['init', '-b', 'main'], repository);
    git(['config', 'user.email', 'tests@example.test'], repository);
    git(['config', 'user.name', 'Agent Operations Tests'], repository);
    writeFileSync(join(repository, 'README.md'), '# fixture\n');
    git(['add', 'README.md'], repository);
    git(['commit', '-m', 'fixture'], repository);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    }).trim();
  }

  function adapter(gitBinary?: string): GitRepositoryAdapter {
    return new GitRepositoryAdapter({
      ...(gitBinary ? { gitBinary } : {}),
      now: () => new Date(OBSERVED_AT),
    });
  }

  it('observes a clean attached repository, HEAD, and multiple remotes', async () => {
    git(['remote', 'add', 'origin', 'https://github.com/wftx/example.git'], repository);
    git(['remote', 'add', 'upstream', 'git@github.com:upstream/example.git'], repository);
    const summary = await adapter().inspectRepository(repository);
    expect(summary).toMatchObject({
      id: 'remote:github.com/wftx/example',
      identityKind: 'remote',
      name: 'example',
      repositoryRoot: realpathSync(repository),
      availability: 'available',
      branch: 'main',
      detachedHead: false,
      workingTree: 'clean',
      observedAt: OBSERVED_AT,
      primaryRemote: { name: 'origin' },
    });
    expect(summary.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(summary.remotes.map(remote => remote.name)).toEqual(['origin', 'upstream']);
  });

  it('observes a dirty feature branch', async () => {
    git(['checkout', '-b', 'feature/inventory'], repository);
    writeFileSync(join(repository, 'README.md'), '# changed\n');
    expect(await adapter().inspectRepository(repository)).toMatchObject({
      branch: 'feature/inventory',
      detachedHead: false,
      workingTree: 'dirty',
    });
  });

  it('observes detached HEAD without inventing a branch', async () => {
    git(['checkout', '--detach', 'HEAD'], repository);
    const summary = await adapter().inspectRepository(repository);
    expect(summary.detachedHead).toBe(true);
    expect(summary.branch).toBeUndefined();
    expect(summary.headCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('uses deterministic local identity when no portable remote exists', async () => {
    const first = await adapter().inspectRepository(repository);
    const second = await adapter().inspectRepository(repository);
    expect(first.identityKind).toBe('local');
    expect(first.id).toBe(second.id);
    expect(first.remotes).toEqual([]);
  });

  it('preserves an unusual configured remote without failing inspection', async () => {
    git(['config', 'remote.strange.url', '::not a valid remote::'], repository);
    git(['config', 'remote.strange.fetch', '+refs/heads/*:refs/remotes/strange/*'], repository);
    const summary = await adapter().inspectRepository(repository);
    expect(summary.availability).toBe('available');
    expect(summary.identityKind).toBe('local');
    expect(summary.remotes).toEqual([
      expect.objectContaining({ name: 'strange', fetchUrl: '::not a valid remote::' }),
    ]);
    expect(summary.remotes[0].identity).toBeUndefined();
  });

  it('reports nonexistent paths and non-Git directories without throwing', async () => {
    const missing = await adapter().inspectRepository(join(root, 'missing'));
    const directory = join(root, 'plain-directory');
    mkdirSync(directory);
    const plain = await adapter().inspectRepository(directory);
    expect(missing).toMatchObject({ availability: 'unavailable', workingTree: 'unknown' });
    expect(plain).toMatchObject({ availability: 'not-a-repository', workingTree: 'unknown' });
  });

  it('degrades gracefully when Git itself cannot be invoked', async () => {
    const summary = await adapter(join(root, 'missing-git-binary')).inspectRepository(repository);
    expect(summary).toMatchObject({
      availability: 'degraded',
      identityKind: 'local',
      workingTree: 'unknown',
    });
    expect(summary.reason).toContain('Git repository inspection failed');
  });
});
