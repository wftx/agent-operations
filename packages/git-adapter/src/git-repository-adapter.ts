import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type {
  RemoteRepositoryIdentity,
  RepositoryInventoryAdapter,
  RepositoryRemote,
  RepositorySummary,
} from '../../agent-operations-contracts/src/index.js';
import { normalizeGitRemoteUrl } from './remote-normalization.js';

interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface GitRepositoryAdapterOptions {
  readonly gitBinary?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export function createRemoteRepositoryId(identity: RemoteRepositoryIdentity): string {
  return `remote:${identity.canonical}`;
}

/** Local identities are deliberately machine-local and change if the checkout moves. */
export function createLocalRepositoryId(canonicalPath: string): string {
  const digest = createHash('sha256').update(canonicalPath).digest('hex');
  return `local:${digest}`;
}

function combineReasons(reasons: string[]): string | undefined {
  const unique = [...new Set(reasons.filter(Boolean))];
  return unique.length ? unique.join('; ') : undefined;
}

function repositoryName(identity: RemoteRepositoryIdentity | undefined, repositoryRoot: string): string {
  if (identity) return identity.repositoryPath.split('/').filter(Boolean).at(-1) ?? basename(repositoryRoot);
  return basename(repositoryRoot) || 'repository';
}

export class GitRepositoryAdapter implements RepositoryInventoryAdapter {
  private readonly gitBinary: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: GitRepositoryAdapterOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  async inspectRepository(checkoutPath: string): Promise<RepositorySummary> {
    const observedAt = this.now().toISOString();
    const resolvedCheckout = resolve(checkoutPath);
    let checkoutStats;
    try {
      checkoutStats = await stat(resolvedCheckout);
    } catch (error) {
      return this.unavailableSummary(
        resolvedCheckout,
        observedAt,
        `Repository path is unavailable: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
      );
    }
    if (!checkoutStats.isDirectory()) {
      return this.unavailableSummary(resolvedCheckout, observedAt, 'Repository path is not a directory');
    }

    const canonicalCheckout = await realpath(resolvedCheckout).catch(() => resolvedCheckout);
    const rootResult = await this.runGit(canonicalCheckout, ['rev-parse', '--show-toplevel']);
    if (!rootResult.ok) {
      const notRepository = /not a git repository/i.test(`${rootResult.stderr} ${rootResult.error ?? ''}`);
      return {
        id: createLocalRepositoryId(canonicalCheckout),
        identityKind: 'local',
        name: basename(canonicalCheckout) || 'repository',
        checkoutPath: canonicalCheckout,
        availability: notRepository ? 'not-a-repository' : 'degraded',
        detachedHead: false,
        workingTree: 'unknown',
        remotes: [],
        observedAt,
        reason: notRepository
          ? 'Path is not inside a Git repository'
          : `Git repository inspection failed: ${rootResult.error || rootResult.stderr || 'unknown Git error'}`,
      };
    }

    const rawRoot = rootResult.stdout.trim();
    const repositoryRoot = await realpath(rawRoot).catch(() => resolve(rawRoot));
    const [branchResult, headResult, statusResult, remoteNamesResult] = await Promise.all([
      this.runGit(repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD']),
      this.runGit(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=normal']),
      this.runGit(repositoryRoot, ['remote']),
    ]);

    const issues: string[] = [];
    const branch = branchResult.ok && branchResult.stdout.trim() ? branchResult.stdout.trim() : undefined;
    const headCommit = headResult.ok && /^[0-9a-f]{40,64}$/i.test(headResult.stdout.trim())
      ? headResult.stdout.trim().toLowerCase()
      : undefined;
    const detachedHead = !branch && Boolean(headCommit);
    const workingTree = statusResult.ok
      ? (statusResult.stdout.length ? 'dirty' as const : 'clean' as const)
      : 'unknown' as const;
    if (!statusResult.ok) issues.push(`Could not read working tree: ${statusResult.error || statusResult.stderr}`);
    if (!remoteNamesResult.ok) issues.push(`Could not list remotes: ${remoteNamesResult.error || remoteNamesResult.stderr}`);

    const remoteNames = remoteNamesResult.ok
      ? remoteNamesResult.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).sort()
      : [];
    const remotes: RepositoryRemote[] = [];
    for (const name of remoteNames) {
      const [fetchResult, pushResult] = await Promise.all([
        this.runGit(repositoryRoot, ['remote', 'get-url', name]),
        this.runGit(repositoryRoot, ['remote', 'get-url', '--push', name]),
      ]);
      if (!fetchResult.ok || !fetchResult.stdout.trim()) {
        issues.push(`Could not read remote ${name}: ${fetchResult.error || fetchResult.stderr}`);
        continue;
      }
      const fetch = normalizeGitRemoteUrl(fetchResult.stdout.trim());
      const push = pushResult.ok && pushResult.stdout.trim()
        ? normalizeGitRemoteUrl(pushResult.stdout.trim())
        : undefined;
      remotes.push({
        name,
        fetchUrl: fetch.sanitizedUrl,
        ...(push && push.sanitizedUrl !== fetch.sanitizedUrl ? { pushUrl: push.sanitizedUrl } : {}),
        ...(fetch.identity ? { identity: fetch.identity } : {}),
      });
    }

    const primaryRemote = remotes.find(remote => remote.name === 'origin') ?? remotes[0];
    const portableIdentity = primaryRemote?.identity
      ?? remotes.find(remote => remote.identity)?.identity;
    const id = portableIdentity
      ? createRemoteRepositoryId(portableIdentity)
      : createLocalRepositoryId(repositoryRoot);
    const reason = combineReasons(issues);

    return {
      id,
      identityKind: portableIdentity ? 'remote' : 'local',
      name: repositoryName(portableIdentity, repositoryRoot),
      checkoutPath: canonicalCheckout,
      repositoryRoot,
      availability: issues.length ? 'degraded' : 'available',
      ...(branch ? { branch } : {}),
      detachedHead,
      ...(headCommit ? { headCommit } : {}),
      workingTree,
      remotes,
      ...(primaryRemote ? { primaryRemote } : {}),
      observedAt,
      ...(reason ? { reason } : {}),
    };
  }

  private unavailableSummary(checkoutPath: string, observedAt: string, reason: string): RepositorySummary {
    return {
      id: createLocalRepositoryId(checkoutPath),
      identityKind: 'local',
      name: basename(checkoutPath) || 'repository',
      checkoutPath,
      availability: 'unavailable',
      detachedHead: false,
      workingTree: 'unknown',
      remotes: [],
      observedAt,
      reason,
    };
  }

  private runGit(repositoryPath: string, args: readonly string[]): Promise<GitCommandResult> {
    return new Promise(resolveCommand => {
      execFile(
        this.gitBinary,
        ['--no-optional-locks', '-C', repositoryPath, ...args],
        {
          encoding: 'utf8',
          timeout: this.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: '0',
            LC_ALL: 'C',
          },
        },
        (error, stdout, stderr) => {
          resolveCommand({
            ok: !error,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            ...(error ? { error: error.message } : {}),
          });
        },
      );
    });
  }
}
