import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    execFileSync('git', ['-C', root, 'config', 'user.email', 'ao@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'AO Test']);
    execFileSync('git', ['-C', root, 'add', 'safe.txt']);
    execFileSync('git', ['-C', root, 'commit', '-m', 'fixture']);
    const dependencies = realpathSync(join(process.cwd(), 'node_modules'));
    symlinkSync(dependencies, join(root, 'node_modules'), 'dir');
    return root;
  }

  it('applies one exact replacement and permits only read-only Git inspection', async () => {
    const root = fixture();
    const tools = new RootScopedRepositoryWorkspaceTools(root);
    expect(tools.patch('safe.txt', 'beta', 'gamma')).toEqual({ path: 'safe.txt', replacements: 1 });
    expect(readFileSync(join(root, 'safe.txt'), 'utf8')).toBe('alpha\ngamma\n');
    await expect(tools.inspectGit('diff')).resolves.toMatchObject({ success: true, operation: 'diff' });
    await expect(tools.inspectGit('head')).resolves.toMatchObject({
      success: true,
      operation: 'head',
      stdout: expect.stringMatching(/^[0-9a-f]{40}\n$/),
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
