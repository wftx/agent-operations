import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  RepositoryRestoreAdapter,
  RepositoryRestoreFileState,
  RepositoryRestoreInspection,
  RepositoryRestoreStatusEntry,
} from '../../agent-operations-contracts/src/index.js';
import { GitRepositoryAdapter } from './git-repository-adapter.js';

interface GitResult {
  readonly ok: boolean;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: string;
}

/** Exact path, exact revision destructive restore adapter. It exposes no arbitrary Git command surface. */
export class GitRepositoryRestoreAdapter implements RepositoryRestoreAdapter {
  private readonly gitBinary: string;
  private readonly timeoutMs: number;
  private readonly inventory: GitRepositoryAdapter;

  constructor(options: { readonly gitBinary?: string; readonly timeoutMs?: number } = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.inventory = new GitRepositoryAdapter({ gitBinary: this.gitBinary, timeoutMs: this.timeoutMs });
  }

  async inspect(canonicalPath: string): Promise<RepositoryRestoreInspection> {
    const root = await this.requireCanonicalRoot(canonicalPath);
    const repository = await this.inventory.inspectRepository(root);
    if (repository.availability !== 'available' || repository.repositoryRoot !== root || !repository.headCommit) {
      throw new Error(`Repository identity is unavailable for selective restore: ${repository.reason ?? root}`);
    }
    const [status, branch] = await Promise.all([
      this.runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    ]);
    if (!status.ok) throw new Error(`Could not inspect selective restore status: ${bounded(status)}`);
    const statusEntries = parseStatus(status.stdout.toString('utf8'));
    const identity = {
      repositoryId: repository.id,
      canonicalPath: root,
      ...(branch.ok && branch.stdout.toString('utf8').trim()
        ? { branch: branch.stdout.toString('utf8').trim() }
        : {}),
      detachedHead: !branch.ok,
      headRevision: repository.headCommit,
      statusEntries,
    };
    return {
      ...identity,
      evidenceHash: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    };
  }

  async sha256ForWorkingTreeFile(canonicalPath: string, path: string): Promise<string | null> {
    const root = await this.requireCanonicalRoot(canonicalPath);
    const safe = safePath(root, path);
    const metadata = await lstat(safe.absolute).catch(() => null);
    if (!metadata) return null;
    if (!metadata.isFile()) throw new Error(`Selective restore path is not a regular file: ${safe.relative}`);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(safe.absolute)) digest.update(chunk as Buffer);
    return digest.digest('hex');
  }

  async sha256ForHeadFile(canonicalPath: string, headRevision: string, path: string): Promise<string | null> {
    const root = await this.requireCanonicalRoot(canonicalPath);
    const safe = safePath(root, path);
    requireRevision(headRevision);
    const result = await this.runGit(root, ['show', `${headRevision}:${safe.relative}`]);
    if (!result.ok) return null;
    return createHash('sha256').update(result.stdout).digest('hex');
  }

  async restoreTrackedPaths(
    canonicalPath: string,
    headRevision: string,
    paths: readonly string[],
  ): Promise<void> {
    const root = await this.requireCanonicalRoot(canonicalPath);
    requireRevision(headRevision);
    const safePaths = paths.map(path => safePath(root, path).relative);
    if (safePaths.length === 0 || new Set(safePaths).size !== safePaths.length || safePaths.length > 100) {
      throw new Error('Selective restore requires 1 to 100 unique tracked paths');
    }
    const restored = await this.runGit(root, [
      'restore', `--source=${headRevision}`, '--staged', '--worktree', '--', ...safePaths,
    ]);
    if (!restored.ok) throw new Error(`Selective restore failed: ${bounded(restored)}`);
  }

  private async requireCanonicalRoot(value: string): Promise<string> {
    if (!value || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
      throw new Error('Selective restore root must be canonical and absolute');
    }
    const canonical = await realpath(value);
    if (canonical !== value) throw new Error('Selective restore root is not canonical');
    const top = await this.runGit(canonical, ['rev-parse', '--show-toplevel']);
    const reported = top.ok ? await realpath(top.stdout.toString('utf8').trim()).catch(() => null) : null;
    if (reported !== canonical) throw new Error('Selective restore root escaped the authorized repository');
    return canonical;
  }

  private runGit(repositoryPath: string, args: readonly string[]): Promise<GitResult> {
    return new Promise(resolveResult => {
      execFile(this.gitBinary, ['--no-optional-locks', '-C', repositoryPath, ...args], {
        encoding: 'buffer',
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? '/tmp',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
      }, (error, stdout, stderr) => resolveResult({
        ok: !error,
        stdout: stdout ?? Buffer.alloc(0),
        stderr: stderr ?? Buffer.alloc(0),
        ...(error ? { error: error.message } : {}),
      }));
    });
  }
}

function parseStatus(value: string): readonly RepositoryRestoreStatusEntry[] {
  const fields = value.split('\0').filter(Boolean);
  const entries: RepositoryRestoreStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    if (entries.length >= 1_000) throw new Error('Selective restore status exceeds 1000 entries');
    const field = fields[index];
    if (field.length < 4 || field[2] !== ' ') throw new Error('Git returned malformed selective restore status');
    const rawIndex = field[0];
    const rawWorktree = field[1];
    const path = relativePath(field.slice(3));
    const moved = rawIndex === 'R' || rawIndex === 'C' || rawWorktree === 'R' || rawWorktree === 'C';
    const originalPath = moved ? relativePath(fields[index += 1] ?? '') : undefined;
    entries.push({
      path,
      ...(originalPath ? { originalPath } : {}),
      indexStatus: fileState(rawIndex, true),
      worktreeStatus: fileState(rawWorktree, false),
    });
  }
  return entries;
}

function fileState(value: string, index: boolean): RepositoryRestoreFileState {
  if (value === ' ') return 'unmodified';
  if (value === 'M') return 'modified';
  if (value === 'A') return 'added';
  if (value === 'D') return 'deleted';
  if (value === 'R') return 'renamed';
  if (value === 'C') return 'copied';
  if (value === 'U') return 'unmerged';
  if (value === 'T') return 'type-changed';
  if (value === '?' && !index) return 'untracked';
  if (value === '!' && !index) return 'ignored';
  if ((value === '?' || value === '!') && index) return 'unmodified';
  return 'unknown';
}

function safePath(root: string, value: string): { readonly relative: string; readonly absolute: string } {
  const clean = relativePath(value);
  const absolute = resolve(root, clean);
  const child = relative(root, absolute);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Selective restore path escapes the authorized repository');
  }
  return { relative: clean, absolute };
}

function relativePath(value: string): string {
  const clean = value.trim().replace(/\\/g, '/');
  if (!clean || clean.length > 1_024 || clean.includes('\0') || isAbsolute(clean)
    || clean.includes('*') || clean.includes('?')) {
    throw new Error('Selective restore path must be exact and repository relative');
  }
  const parts = clean.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Selective restore path is unsafe');
  }
  return parts.join('/');
}

function requireRevision(value: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) throw new Error('Selective restore revision must be exact');
}

function bounded(result: GitResult): string {
  const value = (result.error || result.stderr.toString('utf8') || 'unknown Git error')
    .replace(/(?:token|authorization|password)=\S+/gi, '[REDACTED]')
    .trim();
  return value.length > 1_000 ? `${value.slice(0, 1_000)}...` : value;
}
