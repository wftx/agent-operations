import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, stat, symlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  RepositoryWorkspaceAdapter,
  RepositoryWorkspaceInspection,
  RepositoryWorkspacePreparation,
} from '../../agent-operations-contracts/src/index.js';
import { GitRepositoryAdapter } from './git-repository-adapter.js';

const MAX_EVIDENCE_BYTES = 64 * 1024;

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface GitRepositoryWorkspaceAdapterOptions {
  readonly workspaceRoot: string;
  readonly gitBinary?: string;
  readonly timeoutMs?: number;
}

/** Git mutation is limited to creating an AO owned worktree and its deterministic branch. */
export class GitRepositoryWorkspaceAdapter implements RepositoryWorkspaceAdapter {
  private readonly root: string;
  private readonly gitBinary: string;
  private readonly timeoutMs: number;
  private readonly inventory: GitRepositoryAdapter;

  constructor(options: GitRepositoryWorkspaceAdapterOptions) {
    this.root = requireAbsolute(options.workspaceRoot, 'Workspace root');
    this.gitBinary = options.gitBinary ?? 'git';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.inventory = new GitRepositoryAdapter({
      gitBinary: this.gitBinary,
      timeoutMs: this.timeoutMs,
    });
  }

  async createWorkspace(input: RepositoryWorkspacePreparation): Promise<RepositoryWorkspaceInspection> {
    this.validate(input);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const existing = await stat(input.destinationPath).catch(() => null);
    if (existing) {
      const inspection = await this.inspectWorkspace(input);
      if (!inspection.exists || !inspection.registered || inspection.reason) return inspection;
      const dependencyFailure = await this.ensureDependencies(input);
      return dependencyFailure ? { ...inspection, reason: dependencyFailure } : inspection;
    }
    const existingBranch = await this.runGit(input.sourceCheckoutPath, [
      'rev-parse', '--verify', `refs/heads/${input.branchName}`,
    ]);
    if (existingBranch.ok && existingBranch.stdout.trim().toLowerCase() !== input.baseRevision.toLowerCase()) {
      return {
        exists: false,
        registered: false,
        reason: 'The deterministic workspace branch already exists at another revision.',
      };
    }
    const created = await this.runGit(input.sourceCheckoutPath, existingBranch.ok
      ? ['worktree', 'add', input.destinationPath, input.branchName]
      : ['worktree', 'add', '-b', input.branchName, input.destinationPath, input.baseRevision]);
    if (!created.ok) {
      return {
        exists: false,
        registered: false,
        reason: bounded(`Git worktree creation failed: ${created.error || created.stderr}`),
      };
    }
    const inspection = await this.inspectWorkspace(input);
    if (!inspection.exists || !inspection.registered || inspection.reason) return inspection;
    const dependencyFailure = await this.ensureDependencies(input);
    return dependencyFailure ? { ...inspection, reason: dependencyFailure } : inspection;
  }

  async inspectWorkspace(input: RepositoryWorkspacePreparation): Promise<RepositoryWorkspaceInspection> {
    this.validate(input);
    const metadata = await stat(input.destinationPath).catch(() => null);
    if (!metadata?.isDirectory()) {
      return { exists: false, registered: false, reason: 'Workspace path does not exist.' };
    }
    const canonicalPath = await realpath(input.destinationPath).catch(() => null);
    if (!canonicalPath || canonicalPath !== input.destinationPath) {
      return { exists: true, registered: false, reason: 'Workspace path is not canonical.' };
    }
    const summary = await this.inventory.inspectRepository(canonicalPath);
    const [branch, head, worktrees] = await Promise.all([
      this.runGit(canonicalPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.runGit(canonicalPath, ['rev-parse', '--verify', 'HEAD']),
      this.runGit(input.sourceCheckoutPath, ['worktree', 'list', '--porcelain']),
    ]);
    const registered = worktrees.ok && worktrees.stdout.split(/\r?\n/)
      .some(line => line === `worktree ${canonicalPath}`);
    const branchName = branch.ok ? branch.stdout.trim() : undefined;
    const headRevision = head.ok ? head.stdout.trim().toLowerCase() : undefined;
    const valid = registered
      && summary.availability === 'available'
      && summary.id === input.repositoryId
      && branchName === input.branchName
      && headRevision === input.baseRevision.toLowerCase();
    return {
      exists: true,
      registered,
      canonicalPath,
      repositoryId: summary.id,
      ...(branchName ? { branchName } : {}),
      ...(headRevision ? { headRevision } : {}),
      ...(!valid ? { reason: 'Workspace identity, branch, or base revision did not match durable intent.' } : {}),
    };
  }

  async captureEvidence(canonicalPath: string) {
    const root = requireWorkspaceChild(this.root, canonicalPath);
    const [status, statResult, diffResult] = await Promise.all([
      this.runGit(root, ['status', '--porcelain=v1', '--untracked-files=normal']),
      this.runGit(root, ['diff', '--stat', '--no-ext-diff', '--']),
      this.runGit(root, ['diff', '--no-ext-diff', '--no-color', '--']),
    ]);
    if (!status.ok || !statResult.ok || !diffResult.ok) {
      throw new Error(bounded(`Could not capture workspace evidence: ${status.error || statResult.error || diffResult.error || status.stderr || statResult.stderr || diffResult.stderr}`));
    }
    const changedFiles = status.stdout.split(/\r?\n/).filter(Boolean).map(line => line.slice(3));
    const bytes = Buffer.byteLength(diffResult.stdout, 'utf8');
    return {
      changedFiles,
      diffStat: bounded(statResult.stdout),
      diffText: bytes > MAX_EVIDENCE_BYTES
        ? Buffer.from(diffResult.stdout).subarray(0, MAX_EVIDENCE_BYTES).toString('utf8')
        : diffResult.stdout,
      diffTruncated: bytes > MAX_EVIDENCE_BYTES,
    };
  }

  async removeWorkspace(input: RepositoryWorkspacePreparation): Promise<RepositoryWorkspaceInspection> {
    this.validate(input);
    const before = await this.inspectWorkspace(input);
    const owned = before.exists && before.registered
      && before.canonicalPath === input.destinationPath
      && before.repositoryId === input.repositoryId
      && before.branchName === input.branchName;
    if (!owned) {
      return {
        ...before,
        reason: before.reason ?? 'Workspace cleanup refused because exact AO ownership was not proven.',
      };
    }
    const removed = await this.runGit(input.sourceCheckoutPath, [
      'worktree', 'remove', input.destinationPath,
    ]);
    if (!removed.ok) {
      return {
        ...before,
        reason: bounded(`Git worktree removal failed safely: ${removed.error || removed.stderr}`),
      };
    }
    return this.inspectWorkspace(input);
  }

  private validate(input: RepositoryWorkspacePreparation): void {
    requireAbsolute(input.sourceCheckoutPath, 'Source checkout path');
    requireWorkspaceChild(this.root, input.destinationPath);
    if (!input.repositoryId.trim() || !/^[0-9a-f]{40,64}$/i.test(input.baseRevision)
      || !/^ao\/job-[a-z0-9-]+$/i.test(input.branchName)) {
      throw new Error('Invalid isolated Repository Workspace preparation input');
    }
  }

  private async ensureDependencies(input: RepositoryWorkspacePreparation): Promise<string | null> {
    const source = join(input.sourceCheckoutPath, 'node_modules');
    const destination = join(input.destinationPath, 'node_modules');
    const sourceMetadata = await stat(source).catch(() => null);
    if (!sourceMetadata?.isDirectory()) {
      return 'The source checkout has no installed node_modules dependency tree.';
    }
    const canonicalSource = await realpath(source);
    const destinationMetadata = await lstat(destination).catch(() => null);
    if (!destinationMetadata) {
      await symlink(canonicalSource, destination, 'dir').catch(() => undefined);
    }
    const linkedMetadata = await lstat(destination).catch(() => null);
    const linkedTarget = linkedMetadata?.isSymbolicLink()
      ? await realpath(destination).catch(() => null)
      : null;
    return linkedTarget === canonicalSource
      ? null
      : 'The isolated worktree dependency link is missing or does not match the source checkout.';
  }

  private runGit(repositoryPath: string, args: readonly string[]): Promise<GitResult> {
    return new Promise(resolveResult => {
      execFile(this.gitBinary, ['--no-optional-locks', '-C', repositoryPath, ...args], {
        encoding: 'utf8',
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
      }, (error, stdout, stderr) => resolveResult({
        ok: !error,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        ...(error ? { error: error.message } : {}),
      }));
    });
  }
}

function requireAbsolute(value: string, field: string): string {
  const clean = value.trim();
  if (!clean || !isAbsolute(clean) || resolve(clean) !== clean || clean.includes('\0')) {
    throw new Error(`${field} must be canonical and absolute`);
  }
  return clean;
}

function requireWorkspaceChild(root: string, value: string): string {
  const clean = requireAbsolute(value, 'Workspace path');
  const child = relative(root, clean);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Workspace path must be a child of the AO workspace root');
  }
  return clean;
}

function bounded(value: string): string {
  const clean = value.trim().replace(/(?:token|authorization|password)=\S+/gi, '[REDACTED]');
  return clean.length > 4_096 ? `${clean.slice(0, 4_096)}…` : clean;
}
