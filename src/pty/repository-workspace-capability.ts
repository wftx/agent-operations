import { execFile } from 'node:child_process';
import {
  lstatSync,
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  realpathSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 1_048_576;
const MAX_TOOL_OUTPUT = 4_000;
const MAX_GIT_STATUS_ENTRIES = 1_000;

type RuntimeGitFileState =
  | 'unmodified' | 'modified' | 'added' | 'deleted' | 'renamed' | 'copied'
  | 'unmerged' | 'type-changed' | 'untracked' | 'ignored' | 'unknown';

interface RuntimeGitStatusEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly indexStatus: RuntimeGitFileState;
  readonly worktreeStatus: RuntimeGitFileState;
}

interface RuntimeGitInspectionEvidence {
  readonly repositoryRoot: string;
  readonly headRevision: string;
  readonly branch?: string;
  readonly detachedHead: boolean;
  readonly clean?: boolean;
  readonly statusEntries?: readonly RuntimeGitStatusEntry[];
}

export interface WorkspaceToolAuditEvent {
  readonly namespace: 'repository' | 'test' | 'git';
  readonly operation: string;
  readonly success: boolean;
  readonly occurredAt: string;
  readonly path?: string;
  readonly commandId?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputTruncated?: boolean;
  readonly errorCode?: string;
  readonly gitEvidence?: RuntimeGitInspectionEvidence;
  readonly ephemeralArtifacts?: readonly WorkspaceEphemeralArtifactAudit[];
}

export interface WorkspaceEphemeralArtifactAudit {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly byteSize: number;
  readonly fileCount: number;
  readonly cleanupStatus: 'removed';
}

export class WorkspaceToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceToolError';
  }
}

const TEST_COMMANDS = {
  typecheck: ['npm', ['run', 'typecheck']],
  'agent-operations-tests': ['npm', [
    'run',
    'test:agent-operations',
    '--',
    '--pool=threads',
    '--exclude',
    'apps/ao-web/test/operator-web.test.ts',
    '--exclude',
    'packages/cortextos-adapter/test/repository-workspace-capability.test.ts',
  ]],
  build: ['npm', ['run', 'build']],
  'dashboard-tests': ['npm', ['test', '--prefix', 'dashboard']],
} as const;

/** Shell-free mutation and validation tools rooted to one canonical AO worktree. */
export class RootScopedRepositoryWorkspaceTools {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root) || resolve(root) !== root || root.includes('\0')) {
      throw new WorkspaceToolError('INVALID_ROOT', 'Workspace root must be canonical and absolute');
    }
    const canonical = realpathSync(root);
    if (canonical !== root || !statSync(root).isDirectory()) {
      throw new WorkspaceToolError('INVALID_ROOT', 'Workspace root must name its canonical directory');
    }
    this.root = root;
  }

  patch(path: string, oldText: string, newText: string): { path: string; replacements: 1 } {
    const target = this.resolveExistingFile(path);
    if (!oldText || oldText === newText) {
      throw new WorkspaceToolError('INVALID_PATCH', 'Patch requires distinct nonempty oldText and newText');
    }
    const metadata = statSync(target.absolute);
    if (metadata.size > MAX_FILE_BYTES) {
      throw new WorkspaceToolError('FILE_TOO_LARGE', 'Patch target exceeds the bounded file size');
    }
    const content = readFileSync(target.absolute, 'utf8');
    const first = content.indexOf(oldText);
    if (first < 0) throw new WorkspaceToolError('PATCH_CONTEXT_MISSING', 'Patch oldText was not found');
    if (content.indexOf(oldText, first + oldText.length) >= 0) {
      throw new WorkspaceToolError('PATCH_CONTEXT_AMBIGUOUS', 'Patch oldText must match exactly once');
    }
    const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
    if (Buffer.byteLength(updated, 'utf8') > MAX_FILE_BYTES) {
      throw new WorkspaceToolError('FILE_TOO_LARGE', 'Patched file exceeds the bounded file size');
    }
    const descriptor = openSync(target.absolute, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new WorkspaceToolError('NOT_FILE', 'Patch target changed before the authorized write');
      }
      ftruncateSync(descriptor, 0);
      writeFileSync(descriptor, updated, { encoding: 'utf8' });
    } finally {
      closeSync(descriptor);
    }
    return { path: target.relative, replacements: 1 };
  }

  async runTest(commandId: string): Promise<WorkspaceToolAuditEvent> {
    const selected = TEST_COMMANDS[commandId as keyof typeof TEST_COMMANDS];
    if (!selected) throw new WorkspaceToolError('COMMAND_DENIED', 'Test command is not allowlisted');
    const [file, configuredArgs] = selected;
    // Next production webpack avoids Turbopack retaining sandboxed workers and
    // remains explicit in the durable command evidence.
    const args = commandId === 'build' && packageUsesNextBuild(this.root)
      ? [...configuredArgs, '--', '--webpack']
      : [...configuredArgs];
    const started = Date.now();
    const result = await runSandboxed(file, args, this.root, 10 * 60_000);
    const stdout = bounded(result.stdout);
    const stderr = bounded(result.stderr);
    return {
      namespace: 'test',
      operation: 'run',
      commandId,
      command: [file, ...args].join(' '),
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      stdout: stdout.text,
      stderr: stderr.text,
      ...(result.ephemeralArtifacts.length > 0
        ? { ephemeralArtifacts: result.ephemeralArtifacts }
        : {}),
      ...((stdout.truncated || stderr.truncated) ? { outputTruncated: true } : {}),
      occurredAt: new Date().toISOString(),
    };
  }

  async inspectGit(operation: 'status' | 'diff' | 'diff-stat' | 'head'): Promise<WorkspaceToolAuditEvent> {
    if (!['status', 'diff', 'diff-stat', 'head'].includes(operation)) {
      throw new WorkspaceToolError('INVALID_OPERATION', 'Git inspection operation is not allowlisted');
    }
    const args = operation === 'status'
      ? ['status', '--porcelain=v1', '-z', '--untracked-files=all']
      : operation === 'head'
        ? ['rev-parse', '--verify', 'HEAD']
      : operation === 'diff-stat'
        ? ['diff', '--stat', '--no-ext-diff', '--no-textconv', '--']
        : ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--'];
    const started = Date.now();
    const gitEnvironment = {
      TMPDIR: tmpdir(),
      HOME: process.env.HOME ?? tmpdir(),
      ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
      xcrun_nocache: '1',
    };
    const gitPrefix = [
      '--no-optional-locks', '-C', this.root,
      '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false',
      '-c', 'core.preloadIndex=false',
    ];
    const [result, repositoryRoot, head, branch] = await Promise.all([
      run('git', [...gitPrefix, ...args], this.root, 30_000, gitEnvironment),
      run('git', [...gitPrefix, 'rev-parse', '--show-toplevel'], this.root, 30_000, gitEnvironment),
      run('git', [...gitPrefix, 'rev-parse', '--verify', 'HEAD'], this.root, 30_000, gitEnvironment),
      run('git', [...gitPrefix, 'symbolic-ref', '--quiet', '--short', 'HEAD'], this.root, 30_000, gitEnvironment),
    ]);
    let canonicalRepositoryRoot: string | null = null;
    if (repositoryRoot.exitCode === 0) {
      try {
        canonicalRepositoryRoot = realpathSync(repositoryRoot.stdout.trim());
      } catch {
        canonicalRepositoryRoot = null;
      }
    }
    const headRevision = head.stdout.trim().toLowerCase();
    const identityValid = canonicalRepositoryRoot === this.root
      && /^[0-9a-f]{40,64}$/.test(headRevision);
    if (!identityValid) {
      return {
        namespace: 'git',
        operation,
        success: false,
        exitCode: result.exitCode || repositoryRoot.exitCode || head.exitCode || 1,
        durationMs: Date.now() - started,
        stdout: '',
        stderr: bounded(repositoryRoot.stderr || head.stderr || 'Git repository identity escaped the authorized root.').text,
        errorCode: canonicalRepositoryRoot && canonicalRepositoryRoot !== this.root
          ? 'SCOPE_MISMATCH'
          : 'IDENTITY_UNAVAILABLE',
        occurredAt: new Date().toISOString(),
      };
    }
    const statusEntries = operation === 'status' && result.exitCode === 0
      ? parseGitStatus(result.stdout)
      : undefined;
    const gitEvidence: RuntimeGitInspectionEvidence = {
      repositoryRoot: canonicalRepositoryRoot as string,
      headRevision,
      ...(branch.exitCode === 0 && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
      detachedHead: branch.exitCode !== 0,
      ...(statusEntries ? { clean: statusEntries.length === 0, statusEntries } : {}),
    };
    return {
      namespace: 'git',
      operation,
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      stdout: bounded(operation === 'status' && statusEntries
        ? formatGitStatus(gitEvidence, statusEntries)
        : result.stdout).text,
      stderr: bounded(result.stderr).text,
      gitEvidence,
      occurredAt: new Date().toISOString(),
    };
  }

  private resolveExistingFile(path: string): { absolute: string; relative: string } {
    const clean = normalize(path);
    const absolute = resolve(this.root, clean);
    const child = relative(this.root, absolute);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new WorkspaceToolError('PATH_ESCAPE', 'Patch path escapes the authorized workspace');
    }
    const segments = clean.split('/');
    let cursor = this.root;
    for (const segment of segments) {
      cursor = resolve(cursor, segment);
      const metadata = lstatSync(cursor);
      if (metadata.isSymbolicLink()) throw new WorkspaceToolError('SYMLINK_DENIED', 'Symlink traversal is denied');
    }
    if (!statSync(absolute).isFile() || realpathSync(dirname(absolute)) !== dirname(absolute)) {
      throw new WorkspaceToolError('NOT_FILE', 'Patch target must be a regular file in the workspace');
    }
    return { absolute, relative: clean };
  }
}

function parseGitStatus(value: string): readonly RuntimeGitStatusEntry[] {
  const fields = value.split('\0').filter(Boolean);
  const entries: RuntimeGitStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    if (entries.length >= MAX_GIT_STATUS_ENTRIES) {
      throw new WorkspaceToolError('STATUS_TOO_LARGE', 'Git status exceeds the bounded entry limit');
    }
    const field = fields[index];
    if (field.length < 4 || field[2] !== ' ') {
      throw new WorkspaceToolError('MALFORMED_STATUS', 'Git returned malformed status evidence');
    }
    const rawIndex = field[0];
    const rawWorktree = field[1];
    const path = safeGitPath(field.slice(3));
    const renamedOrCopied = rawIndex === 'R' || rawIndex === 'C'
      || rawWorktree === 'R' || rawWorktree === 'C';
    const originalPath = renamedOrCopied
      ? safeGitPath(fields[index += 1] ?? '')
      : undefined;
    entries.push({
      path,
      ...(originalPath ? { originalPath } : {}),
      indexStatus: gitFileState(rawIndex, true),
      worktreeStatus: gitFileState(rawWorktree, false),
    });
  }
  return entries;
}

function gitFileState(value: string, index: boolean): RuntimeGitFileState {
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

function safeGitPath(value: string): string {
  if (!value || value.length > 1_024 || value.includes('\0') || isAbsolute(value)) {
    throw new WorkspaceToolError('MALFORMED_STATUS', 'Git returned an unsafe status path');
  }
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new WorkspaceToolError('MALFORMED_STATUS', 'Git returned an unsafe status path');
  }
  return parts.join('/');
}

function formatGitStatus(
  evidence: RuntimeGitInspectionEvidence,
  entries: readonly RuntimeGitStatusEntry[],
): string {
  const identity = `## ${evidence.branch ?? `(detached at ${evidence.headRevision.slice(0, 12)})`}`;
  return [identity, ...entries.map(entry => {
    const source = entry.originalPath ? `${entry.originalPath} -> ` : '';
    return `${entry.indexStatus}/${entry.worktreeStatus} ${source}${entry.path}`;
  })].join('\n');
}

function packageUsesNextBuild(root: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: { build?: unknown };
    };
    return typeof manifest.scripts?.build === 'string'
      && /^next\s+build(?:\s|$)/.test(manifest.scripts.build.trim());
  } catch {
    throw new WorkspaceToolError(
      'INVALID_PROJECT_MANIFEST',
      'The bounded build command requires a readable package manifest',
    );
  }
}

function normalize(path: string): string {
  const clean = path.trim().replace(/\\/g, '/');
  if (!clean || clean.length > 1_024 || clean.includes('\0') || isAbsolute(clean)) {
    throw new WorkspaceToolError('INVALID_PATH', 'Patch path must be bounded and repository relative');
  }
  const parts = clean.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')
    || ['.git', '.agent-operations', 'node_modules'].includes(parts[0])) {
    throw new WorkspaceToolError('RESTRICTED_PATH', 'Patch path is restricted');
  }
  return parts.join('/');
}

function run(
  file: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
  environment: NodeJS.ProcessEnv = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise(resolveResult => {
    execFile(file, [...args], {
      cwd,
      encoding: 'utf8',
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: cwd,
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        CI: '1',
        ...environment,
      },
    }, (error, stdout, stderr) => resolveResult({
      exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
        ? Number((error as NodeJS.ErrnoException).code)
        : error ? 1 : 0,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
    }));
  });
}

async function runSandboxed(
  file: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  ephemeralArtifacts: readonly WorkspaceEphemeralArtifactAudit[];
}> {
  if (process.platform !== 'darwin') {
    throw new WorkspaceToolError(
      'SANDBOX_UNAVAILABLE',
      'The bounded test runner currently requires the macOS sandbox boundary',
    );
  }
  const dependencyRoot = trustedDependencyRoot(cwd);
  const knownArtifacts = ['node-compile-cache', 'xcrun_db'] as const;
  const existedBefore = new Set(knownArtifacts.filter(name => pathMetadata(join(cwd, name)) !== null));
  const tempDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'ao-bounded-test-')));
  const escapedRoot = cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedDependencies = dependencyRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedTemporary = tempDirectory.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal (target same-sandbox))',
    '(allow file-read-metadata)',
    '(allow file-read-data (literal "/"))',
    `(allow file-read* (subpath "${escapedRoot}"))`,
    `(allow file-read* (subpath "${escapedDependencies}"))`,
    `(allow file-read* (subpath "${escapedTemporary}"))`,
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/sbin"))',
    '(allow file-read* (subpath "/Library/Apple"))',
    '(allow file-read* (subpath "/Library/Developer/CommandLineTools"))',
    '(allow file-read* (subpath "/Library/Preferences/Logging"))',
    '(allow file-read* (subpath "/private/etc"))',
    '(allow file-read* (subpath "/private/var/db"))',
    '(allow file-read* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/random"))',
    '(allow file-read* (literal "/dev/urandom"))',
    `(allow file-write* (subpath "${escapedRoot}"))`,
    `(allow file-write* (subpath "${escapedTemporary}"))`,
    `(deny file-write* (subpath "${escapedDependencies}"))`,
    '(allow sysctl-read)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
  ].join('');
  try {
    const result = await run('/usr/bin/sandbox-exec', ['-p', profile, file, ...args], cwd, timeout, {
      PATH: [join(dependencyRoot, '.bin'), process.env.PATH ?? '/usr/bin:/bin'].join(delimiter),
      NODE_PATH: dependencyRoot,
      TMPDIR: tempDirectory,
      HOME: tempDirectory,
      NODE_COMPILE_CACHE: join(tempDirectory, 'node-compile-cache'),
      NEXT_TELEMETRY_DISABLED: '1',
      xcrun_nocache: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    });
    const ephemeralArtifacts = knownArtifacts
      .filter(name => !existedBefore.has(name) && pathMetadata(join(cwd, name)) !== null)
      .map(name => inspectEphemeralArtifact(cwd, name));
    for (const artifact of ephemeralArtifacts) {
      try {
        rmSync(join(cwd, artifact.path), { recursive: true, force: true });
      } catch {
        throw new WorkspaceToolError(
          'EPHEMERAL_CLEANUP_FAILED',
          `Bounded validation could not remove its ${artifact.path} artifact`,
        );
      }
    }
    return { ...result, ephemeralArtifacts };
  } finally {
    await removeTemporaryDirectory(tempDirectory);
  }
}

async function removeTemporaryDirectory(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
    }
  }
  throw lastError;
}

function trustedDependencyRoot(cwd: string): string {
  const link = join(cwd, 'node_modules');
  let metadata;
  try {
    metadata = lstatSync(link);
  } catch {
    throw new WorkspaceToolError(
      'DEPENDENCIES_UNAVAILABLE',
      'The isolated worktree has no AO prepared dependency link',
    );
  }
  if (metadata.isDirectory()) {
    const marker = join(link, '.ao-dependency-projection.json');
    const markerMetadata = pathMetadata(marker);
    if (!markerMetadata?.isFile()) {
      throw new WorkspaceToolError(
        'DEPENDENCIES_UNAVAILABLE',
        'The isolated worktree dependency projection is not AO owned',
      );
    }
    return realpathSync(link);
  }
  if (!metadata.isSymbolicLink()) {
    throw new WorkspaceToolError(
      'DEPENDENCIES_UNAVAILABLE',
      'The isolated worktree dependency path is not an AO prepared link',
    );
  }
  const target = realpathSync(link);
  if (!statSync(target).isDirectory()) {
    throw new WorkspaceToolError('DEPENDENCIES_UNAVAILABLE', 'The dependency link target is unavailable');
  }
  return target;
}

function pathMetadata(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function inspectEphemeralArtifact(cwd: string, name: string): WorkspaceEphemeralArtifactAudit {
  const root = join(cwd, name);
  const metadata = lstatSync(root);
  let byteSize = metadata.isFile() ? metadata.size : 0;
  let fileCount = metadata.isFile() ? 1 : 0;
  if (metadata.isDirectory()) {
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(child);
        else {
          fileCount += 1;
          byteSize += lstatSync(child).size;
        }
      }
    }
  }
  return {
    path: name,
    kind: metadata.isDirectory()
      ? 'directory'
      : metadata.isFile()
        ? 'file'
        : metadata.isSymbolicLink()
          ? 'symlink'
          : 'other',
    byteSize,
    fileCount,
    cleanupStatus: 'removed',
  };
}

function bounded(value: string): { text: string; truncated: boolean } {
  const clean = value.replace(/(?:token|authorization|password)=\S+/gi, '[REDACTED]');
  const truncated = Buffer.byteLength(clean, 'utf8') > MAX_TOOL_OUTPUT;
  return {
    text: truncated ? Buffer.from(clean).subarray(0, MAX_TOOL_OUTPUT).toString('utf8') : clean,
    truncated,
  };
}
