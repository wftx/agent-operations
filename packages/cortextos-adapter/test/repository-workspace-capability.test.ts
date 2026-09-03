import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RootScopedRepositoryWorkspaceTools } from '../../../src/pty/repository-workspace-capability.js';

describe('RootScopedRepositoryWorkspaceTools', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ao-tools-')));
    roots.push(root);
    execFileSync('git', ['init', '--initial-branch=main', root]);
    writeFileSync(join(root, 'safe.txt'), 'alpha\nbeta\n');
    writeFileSync(join(root, 'staged.txt'), 'before\n');
    writeFileSync(join(root, 'deleted.txt'), 'delete me\n');
    writeFileSync(join(root, 'rename-source.txt'), 'rename me\n');
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    execFileSync('git', ['-C', root, 'config', 'user.email', 'ao@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'AO Test']);
    execFileSync('git', [
      '-C', root, 'add', 'safe.txt', 'staged.txt', 'deleted.txt', 'rename-source.txt', '.gitignore',
    ]);
    execFileSync('git', ['-C', root, 'commit', '-m', 'fixture']);
    const dependencies = realpathSync(join(process.cwd(), 'node_modules'));
    symlinkSync(dependencies, join(root, 'node_modules'), 'dir');
    return root;
  }

  it('applies one exact replacement and permits only read-only Git inspection', async () => {
    const root = fixture();
    const tools = new RootScopedRepositoryWorkspaceTools(root);
    await expect(tools.inspectGit('status')).resolves.toMatchObject({
      success: true,
      gitEvidence: { branch: 'main', detachedHead: false, clean: true, statusEntries: [] },
    });
    expect(tools.patch('safe.txt', 'beta', 'gamma')).toEqual({ path: 'safe.txt', replacements: 1 });
    expect(readFileSync(join(root, 'safe.txt'), 'utf8')).toBe('alpha\ngamma\n');
    await expect(tools.inspectGit('diff')).resolves.toMatchObject({ success: true, operation: 'diff' });
    await expect(tools.inspectGit('head')).resolves.toMatchObject({
      success: true,
      operation: 'head',
      stdout: expect.stringMatching(/^[0-9a-f]{40}\n$/),
    });
  });

  it('returns authoritative typed branch, HEAD, staged, unstaged, deleted, renamed, and untracked evidence', async () => {
    const root = fixture();
    const expectedHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeFileSync(join(root, 'safe.txt'), 'unstaged modification\n');
    writeFileSync(join(root, 'staged.txt'), 'staged modification\n');
    writeFileSync(join(root, 'added.txt'), 'staged addition\n');
    execFileSync('git', ['-C', root, 'add', 'staged.txt', 'added.txt']);
    unlinkSync(join(root, 'deleted.txt'));
    execFileSync('git', ['-C', root, 'mv', 'rename-source.txt', 'rename-target.txt']);
    writeFileSync(join(root, 'untracked.txt'), 'new\n');
    const before = execFileSync(
      'git', ['--no-optional-locks', '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { encoding: 'utf8' },
    );

    const status = await new RootScopedRepositoryWorkspaceTools(root).inspectGit('status');

    expect(status).toMatchObject({
      success: true,
      operation: 'status',
      gitEvidence: {
        repositoryRoot: root,
        branch: 'main',
        headRevision: expectedHead,
        detachedHead: false,
        clean: false,
      },
    });
    expect(status.gitEvidence?.statusEntries).toEqual(expect.arrayContaining([
      { path: 'safe.txt', indexStatus: 'unmodified', worktreeStatus: 'modified' },
      { path: 'staged.txt', indexStatus: 'modified', worktreeStatus: 'unmodified' },
      { path: 'added.txt', indexStatus: 'added', worktreeStatus: 'unmodified' },
      { path: 'deleted.txt', indexStatus: 'unmodified', worktreeStatus: 'deleted' },
      {
        path: 'rename-target.txt', originalPath: 'rename-source.txt',
        indexStatus: 'renamed', worktreeStatus: 'unmodified',
      },
      { path: 'untracked.txt', indexStatus: 'unmodified', worktreeStatus: 'untracked' },
    ]));
    expect(execFileSync(
      'git', ['--no-optional-locks', '-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { encoding: 'utf8' },
    )).toBe(before);
  });

  it('rejects non-allowlisted Git operations and repository roots outside the exact scope', async () => {
    const root = fixture();
    const tools = new RootScopedRepositoryWorkspaceTools(root);
    await expect((tools.inspectGit as (operation: string) => Promise<unknown>)('commit'))
      .rejects.toThrow('not allowlisted');
    const nested = join(root, 'nested');
    mkdirSync(nested);
    await expect(new RootScopedRepositoryWorkspaceTools(nested).inspectGit('status')).resolves.toMatchObject({
      success: false,
      errorCode: 'SCOPE_MISMATCH',
    });
  });

  it('blocks path escape, metadata, symlinks, ambiguous patches, and unknown test commands', async () => {
    const root = fixture();
    const outside = join(root, '..', `outside-${Date.now()}.txt`);
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(root, 'link.txt'));
    writeFileSync(join(root, 'twice.txt'), 'same same');
    const tools = new RootScopedRepositoryWorkspaceTools(root);
    expect(() => tools.patch('../outside.txt', 'secret', 'changed')).toThrow();
    expect(() => tools.patch('.git/config', 'a', 'b')).toThrow();
    expect(() => tools.patch('link.txt', 'secret', 'changed')).toThrow('Symlink');
    expect(() => tools.patch('twice.txt', 'same', 'changed')).toThrow('exactly once');
    await expect(tools.runTest('arbitrary')).rejects.toThrow('not allowlisted');
    expect(readFileSync(outside, 'utf8')).toBe('secret');
    rmSync(outside);
  });

  it.runIf(process.platform === 'darwin')('runs allowlisted tests with bounded environment and write containment', async () => {
    const root = fixture();
    const outside = join(root, '..', `outside-test-${Date.now()}.txt`);
    writeFileSync(outside, 'outside secret fixture');
    writeFileSync(join(root, 'success.mjs'), `
      import { execFileSync } from 'node:child_process';
      import { defineConfig } from 'vitest/config';
      if (process.env.AO_TEST_PARENT_SECRET) process.exit(7);
      const gitVersion = execFileSync('/usr/bin/git', ['--version'], { encoding: 'utf8' }).trim();
      console.log(defineConfig ? 'sandboxed test passed' : 'dependency missing');
      console.log(gitVersion);
    `);
    writeFileSync(join(root, 'contained.mjs'), `
      import { readFileSync, writeFileSync } from 'node:fs';
      try {
        readFileSync(${JSON.stringify(outside)}, 'utf8');
        process.exit(10);
      } catch {
        console.log('outside read denied');
      }
      try {
        writeFileSync(${JSON.stringify(outside)}, 'escaped');
        process.exit(9);
      } catch {
        console.log('outside write denied');
      }
    `);
    writeFileSync(join(root, 'failure.mjs'), `
      console.log('x'.repeat(40000));
      console.error('bounded failure');
      process.exit(3);
    `);
    writeFileSync(join(root, 'network.mjs'), `
      import { createServer } from 'node:net';
      const server = createServer();
      server.once('error', () => {
        console.log('network denied');
        process.exit(0);
      });
      server.listen(0, '127.0.0.1', () => process.exit(8));
    `);
    writeFileSync(join(root, 'artifacts.mjs'), `
      import { mkdirSync, writeFileSync } from 'node:fs';
      mkdirSync('node-compile-cache');
      writeFileSync('node-compile-cache/cache.bin', 'cache');
      writeFileSync('xcrun_db', 'cache');
      console.log('ephemeral fixtures created');
    `);
    writeFileSync(join(root, 'dependency-write.mjs'), `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      try {
        writeFileSync(join(process.env.NODE_PATH, 'ao-write-probe'), 'denied');
        process.exit(11);
      } catch {
        console.log('dependency write denied');
      }
    `);
    writeFileSync(join(root, 'signal.mjs'), `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      setTimeout(() => child.kill('SIGTERM'), 25);
      child.once('exit', () => console.log('child signal allowed'));
    `);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: {
        typecheck: 'node success.mjs',
        build: 'node contained.mjs',
      },
    }));
    const prior = process.env.AO_TEST_PARENT_SECRET;
    process.env.AO_TEST_PARENT_SECRET = 'fixture-only';
    try {
      const tools = new RootScopedRepositoryWorkspaceTools(root);
      const typecheck = await tools.runTest('typecheck');
      if (!typecheck.success) throw new Error(JSON.stringify(typecheck));
      expect(typecheck).toMatchObject({
        success: true,
        stdout: expect.stringContaining('sandboxed test passed'),
      });
      expect(typecheck.stdout).toContain('git version');
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        scripts: { typecheck: 'node success.mjs', build: 'node failure.mjs' },
      }));
      const failed = await tools.runTest('build');
      expect(failed).toMatchObject({
        success: false,
        exitCode: 3,
        stderr: expect.stringContaining('bounded failure'),
      });
      expect(Buffer.byteLength(failed.stdout ?? '', 'utf8')).toBeLessThanOrEqual(4_000);
      expect(Buffer.byteLength(failed.stderr ?? '', 'utf8')).toBeLessThanOrEqual(4_000);
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        scripts: { typecheck: 'node success.mjs', build: 'node contained.mjs' },
      }));
      const contained = await tools.runTest('build');
      expect(contained).toMatchObject({
        success: true,
        stdout: expect.stringContaining('outside write denied'),
      });
      expect(contained.stdout).toContain('outside read denied');
      expect(readFileSync(outside, 'utf8')).toBe('outside secret fixture');
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        scripts: { typecheck: 'node success.mjs', build: 'node dependency-write.mjs' },
      }));
      await expect(tools.runTest('build')).resolves.toMatchObject({
        success: true,
        stdout: expect.stringContaining('dependency write denied'),
      });
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        scripts: { typecheck: 'node success.mjs', build: 'node signal.mjs' },
      }));
      await expect(tools.runTest('build')).resolves.toMatchObject({
        success: true,
        stdout: expect.stringContaining('child signal allowed'),
      });
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        scripts: { typecheck: 'node success.mjs', build: 'node artifacts.mjs' },
      }));
      await expect(tools.runTest('build')).resolves.toMatchObject({
        success: true,
        ephemeralArtifacts: [
          { path: 'node-compile-cache', kind: 'directory', byteSize: 5, fileCount: 1, cleanupStatus: 'removed' },
          { path: 'xcrun_db', kind: 'file', byteSize: 5, fileCount: 1, cleanupStatus: 'removed' },
        ],
      });
      expect(readdirSync(root)).not.toContain('node-compile-cache');
      expect(readdirSync(root)).not.toContain('xcrun_db');
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        scripts: { typecheck: 'node success.mjs', build: 'node network.mjs' },
      }));
      await expect(tools.runTest('build')).resolves.toMatchObject({
        success: true,
        stdout: expect.stringContaining('network denied'),
      });
      expect(readdirSync(root).filter(name => name.startsWith('.ao-test-tmp-'))).toEqual([]);
      expect(readdirSync(root)).not.toContain('node-compile-cache');
    } finally {
      rmSync(outside, { force: true });
      if (prior === undefined) delete process.env.AO_TEST_PARENT_SECRET;
      else process.env.AO_TEST_PARENT_SECRET = prior;
    }
  });
});
