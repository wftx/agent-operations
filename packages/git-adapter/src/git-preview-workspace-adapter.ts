import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, stat, symlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  PreviewWorkspaceAdapter,
  ReadOnlyPreviewWorkspaceInspection,
  ReadOnlyPreviewWorkspaceRequest,
} from '../../agent-operations-contracts/src/index.js';
import { GitRepositoryAdapter } from './git-repository-adapter.js';

export interface GitPreviewWorkspaceAdapterOptions {
  readonly workspaceRoot: string;
  readonly gitBinary?: string;
  readonly timeoutMs?: number;
}

/** Creates detached, AO owned worktrees for exact revision read only previews. */
export class GitPreviewWorkspaceAdapter implements PreviewWorkspaceAdapter {
  private readonly root: string;
  private readonly gitBinary: string;
  private readonly timeoutMs: number;
  private readonly inventory: GitRepositoryAdapter;

  constructor(options: GitPreviewWorkspaceAdapterOptions) {
    this.root = absolute(options.workspaceRoot, 'Preview workspace root');
    this.gitBinary = options.gitBinary ?? 'git';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.inventory = new GitRepositoryAdapter({ gitBinary: this.gitBinary, timeoutMs: this.timeoutMs });
  }

  async prepareReadOnlyWorkspace(input: ReadOnlyPreviewWorkspaceRequest): Promise<ReadOnlyPreviewWorkspaceInspection> {
    this.validate(input);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (await stat(input.destinationPath).catch(() => null)) return this.inspectReadOnlyWorkspace(input);
    const created = await this.git(input.sourceCheckoutPath, [
      'worktree', 'add', '--detach', input.destinationPath, input.revisionCommit,
    ]);
    if (!created.ok) return { exists: false, registered: false, reason: bounded(created.stderr || created.error) };
    const sourceDependencies = join(input.sourceCheckoutPath, 'node_modules');
    const dependencies = await stat(sourceDependencies).catch(() => null);
    if (dependencies?.isDirectory()) {
      await symlink(await realpath(sourceDependencies), join(input.destinationPath, 'node_modules'), 'dir');
    }
    return this.inspectReadOnlyWorkspace(input);
  }

  async inspectReadOnlyWorkspace(input: ReadOnlyPreviewWorkspaceRequest): Promise<ReadOnlyPreviewWorkspaceInspection> {
    this.validate(input);
    const metadata = await stat(input.destinationPath).catch(() => null);
    if (!metadata?.isDirectory()) return { exists: false, registered: false, reason: 'Preview workspace does not exist.' };
    const canonicalPath = await realpath(input.destinationPath).catch(() => null);
    if (canonicalPath !== input.destinationPath) return { exists: true, registered: false, reason: 'Preview workspace is not canonical.' };
    const [summary, head, branch, status, worktrees, sourceCommon, previewCommon] = await Promise.all([
      this.inventory.inspectRepository(input.destinationPath),
      this.git(input.destinationPath, ['rev-parse', '--verify', 'HEAD']),
      this.git(input.destinationPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.git(input.destinationPath, ['status', '--porcelain=v1', '--untracked-files=no']),
      this.git(input.sourceCheckoutPath, ['worktree', 'list', '--porcelain']),
      this.git(input.sourceCheckoutPath, ['rev-parse', '--git-common-dir']),
      this.git(input.destinationPath, ['rev-parse', '--git-common-dir']),
    ]);
    const registered = worktrees.ok && worktrees.stdout.split(/\r?\n/).includes(`worktree ${input.destinationPath}`);
    const revisionCommit = head.ok ? head.stdout.trim().toLowerCase() : undefined;
    const detachedHead = !branch.ok;
    const clean = status.ok && status.stdout.trim() === '';
    const sameCommonDirectory = sourceCommon.ok && previewCommon.ok
      && await realpath(resolve(input.sourceCheckoutPath, sourceCommon.stdout.trim())).catch(() => '')
        === await realpath(resolve(input.destinationPath, previewCommon.stdout.trim())).catch(() => '');
    const repositoryMatches = summary.id === input.repositoryId || sameCommonDirectory;
    const valid = registered && repositoryMatches && detachedHead && clean
      && revisionCommit === input.revisionCommit.toLowerCase();
    return {
      exists: true,
      registered,
      canonicalPath: input.destinationPath,
      repositoryId: repositoryMatches ? input.repositoryId : summary.id,
      ...(revisionCommit ? { revisionCommit } : {}),
      detachedHead,
      clean,
      ...(!valid ? { reason: `Preview workspace identity, revision, detached state, or cleanliness did not match durable intent: registered=${registered} repository=${repositoryMatches} detached=${detachedHead} clean=${clean} revision=${revisionCommit === input.revisionCommit.toLowerCase()}.` } : {}),
    };
  }

  async removeReadOnlyWorkspace(input: ReadOnlyPreviewWorkspaceRequest): Promise<ReadOnlyPreviewWorkspaceInspection> {
    const inspection = await this.inspectReadOnlyWorkspace(input);
    if (!inspection.exists) return inspection;
    if (!inspection.registered || inspection.reason) return { ...inspection, reason: inspection.reason ?? 'AO ownership was not proven.' };
    const dependency = await lstat(join(input.destinationPath, 'node_modules')).catch(() => null);
    if (dependency?.isSymbolicLink()) {
      const { unlink } = await import('node:fs/promises');
      await unlink(join(input.destinationPath, 'node_modules'));
    }
    const removed = await this.git(input.sourceCheckoutPath, ['worktree', 'remove', input.destinationPath]);
    if (!removed.ok) return { ...inspection, reason: bounded(removed.stderr || removed.error) };
    return this.inspectReadOnlyWorkspace(input);
  }

  private validate(input: ReadOnlyPreviewWorkspaceRequest): void {
    absolute(input.sourceCheckoutPath, 'Source checkout path');
    child(this.root, input.destinationPath);
    if (!input.repositoryId.trim() || !/^[a-f0-9]{40,64}$/i.test(input.revisionCommit)) {
      throw new Error('Invalid read only Preview Workspace request');
    }
  }

  private git(cwd: string, arguments_: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return new Promise(resolveResult => execFile(this.gitBinary, ['--no-optional-locks', '-C', cwd, ...arguments_], {
      encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    }, (error, stdout, stderr) => resolveResult({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '', ...(error ? { error: error.message } : {}) })));
  }
}

function absolute(value: string, field: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes('\0')) throw new Error(`${field} must be canonical and absolute`);
  return value;
}

function child(root: string, value: string): string {
  absolute(value, 'Preview workspace path');
  const rel = relative(root, value);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Preview workspace must be AO owned');
  return value;
}

function bounded(value?: string): string {
  const clean = (value ?? 'Git preview workspace operation failed').trim();
  return clean.length > 2_000 ? clean.slice(0, 2_000) : clean;
}
