import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, realpath, stat, symlink } from 'node:fs/promises';
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
      this.runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.runGit(root, ['diff', '--stat', '--no-ext-diff', '--']),
      this.runGit(root, ['diff', '--no-ext-diff', '--no-color', '--']),
    ]);
    if (!status.ok || !statResult.ok || !diffResult.ok) {
      throw new Error(bounded(`Could not capture workspace evidence: ${status.error || statResult.error || diffResult.error || status.stderr || statResult.stderr || diffResult.stderr}`));
    }
    const statusEntries = parsePorcelainStatus(status.stdout);
    const changedFiles = statusEntries.map(entry => entry.path);
    const binaryFiles = (await Promise.all(statusEntries.map(entry =>
      binaryEvidence(root, entry.path, entry.gitStatus)))).filter(value => value !== null);
    const binaryStat = binaryFiles.map(file =>
      `${file.path} | binary ${file.byteSize} bytes ${file.mediaType} ${file.gitStatus} sha256 ${file.sha256}`);
    const diffStat = [statResult.stdout.trim(), ...binaryStat].filter(Boolean).join('\n');
    const binaryDiff = binaryFiles.map(file =>
      `binary ${file.gitStatus} ${file.path} | ${file.mediaType} | ${file.byteSize} bytes | sha256 ${file.sha256} | content omitted`);
    const combinedDiff = [diffResult.stdout.trimEnd(), ...binaryDiff].filter(Boolean).join('\n');
    const bytes = Buffer.byteLength(combinedDiff, 'utf8');
    return {
      changedFiles,
      binaryFiles,
      diffStat: bounded(diffStat),
      diffText: bytes > MAX_EVIDENCE_BYTES
        ? Buffer.from(combinedDiff).subarray(0, MAX_EVIDENCE_BYTES).toString('utf8')
        : combinedDiff,
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

interface StatusEntry {
  readonly gitStatus: string;
  readonly path: string;
}

function parsePorcelainStatus(value: string): readonly StatusEntry[] {
  const fields = value.split('\0').filter(Boolean);
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) throw new Error('Git returned malformed workspace status evidence');
    const gitStatus = field.slice(0, 2);
    const path = field.slice(3);
    if (!path || path.includes('\0') || isAbsolute(path) || path.split('/').includes('..')) {
      throw new Error('Git returned an unsafe workspace status path');
    }
    entries.push({ gitStatus, path });
    if (gitStatus.includes('R') || gitStatus.includes('C')) index += 1;
  }
  return entries;
}

async function binaryEvidence(root: string, path: string, gitStatus: string) {
  const absolute = join(root, path);
  const metadata = await lstat(absolute).catch(() => null);
  if (!metadata?.isFile()) return null;
  const handle = await open(absolute, 'r');
  const prefix = Buffer.alloc(Math.min(8_192, metadata.size));
  try {
    await handle.read(prefix, 0, prefix.length, 0);
  } finally {
    await handle.close();
  }
  const mediaType = detectMediaType(prefix);
  if (mediaType === 'text/plain' && !prefix.includes(0)) return null;
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(absolute)) digest.update(chunk as Buffer);
  return {
    path,
    gitStatus,
    mediaType,
    byteSize: metadata.size,
    sha256: digest.digest('hex'),
  };
}

function detectMediaType(prefix: Buffer): string {
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg';
  if (prefix.subarray(0, 6).toString('ascii') === 'GIF87a'
    || prefix.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (prefix.subarray(0, 4).toString('ascii') === 'RIFF'
    && prefix.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (prefix.subarray(4, 12).toString('ascii').includes('ftypavif')) return 'image/avif';
  return prefix.includes(0) ? 'application/octet-stream' : 'text/plain';
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
