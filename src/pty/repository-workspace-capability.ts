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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 1_048_576;
const MAX_TOOL_OUTPUT = 4_000;

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
    const [file, args] = selected;
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
      ...((stdout.truncated || stderr.truncated) ? { outputTruncated: true } : {}),
      occurredAt: new Date().toISOString(),
    };
  }

  async inspectGit(operation: 'status' | 'diff' | 'diff-stat' | 'head'): Promise<WorkspaceToolAuditEvent> {
    const args = operation === 'status'
      ? ['status', '--short', '--branch']
      : operation === 'head'
        ? ['rev-parse', '--verify', 'HEAD']
      : operation === 'diff-stat'
        ? ['diff', '--stat', '--no-ext-diff', '--']
        : ['diff', '--no-ext-diff', '--no-color', '--'];
    const started = Date.now();
    const result = await run('git', ['--no-optional-locks', '-C', this.root, ...args], this.root, 30_000);
    return {
      namespace: 'git',
      operation,
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      stdout: bounded(result.stdout).text,
      stderr: bounded(result.stderr).text,
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

function normalize(path: string): string {
  const clean = path.trim().replace(/\\/g, '/');
  if (!clean || clean.length > 1_024 || clean.includes('\0') || isAbsolute(clean)) {
    throw new WorkspaceToolError('INVALID_PATH', 'Patch path must be bounded and repository relative');
  }
  const parts = clean.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')
    || ['.git', '.agent-operations'].includes(parts[0])) {
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
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (process.platform !== 'darwin') {
    throw new WorkspaceToolError(
      'SANDBOX_UNAVAILABLE',
      'The bounded test runner currently requires the macOS sandbox boundary',
    );
  }
  const dependencyRoot = trustedDependencyRoot(cwd);
  const tempDirectory = mkdtempSync(join(cwd, '.ao-test-tmp-'));
  const escapedRoot = cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedDependencies = dependencyRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow file-read-metadata)',
    '(allow file-read-data (literal "/"))',
    `(allow file-read* (subpath "${escapedRoot}"))`,
    `(allow file-read* (subpath "${escapedDependencies}"))`,
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
    '(allow sysctl-read)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
  ].join('');
  try {
    return await run('/usr/bin/sandbox-exec', ['-p', profile, file, ...args], cwd, timeout, {
      PATH: [join(dependencyRoot, '.bin'), process.env.PATH ?? '/usr/bin:/bin'].join(delimiter),
      NODE_PATH: dependencyRoot,
      TMPDIR: tempDirectory,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    });
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
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

function bounded(value: string): { text: string; truncated: boolean } {
  const clean = value.replace(/(?:token|authorization|password)=\S+/gi, '[REDACTED]');
  const truncated = Buffer.byteLength(clean, 'utf8') > MAX_TOOL_OUTPUT;
  return {
    text: truncated ? Buffer.from(clean).subarray(0, MAX_TOOL_OUTPUT).toString('utf8') : clean,
    truncated,
  };
}
