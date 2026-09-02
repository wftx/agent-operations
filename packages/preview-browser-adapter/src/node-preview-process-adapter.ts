import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import type {
  PreviewProcessAdapter,
  PreviewProcessInspection,
  PreviewProcessStartRequest,
  PreviewProcessStartResult,
} from '../../agent-operations-contracts/src/index.js';

const MAX_LOG_CHARS = 16_384;
const ALLOWED_EXECUTABLES = new Set(['npm', 'pnpm', 'yarn', 'bun']);

export class NodePreviewProcessAdapter implements PreviewProcessAdapter {
  private readonly owned = new Map<number, ChildProcess>();

  async reservePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
      const server = createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(error => error ? reject(error) : resolvePort(port));
      });
    });
  }

  async start(input: PreviewProcessStartRequest): Promise<PreviewProcessStartResult> {
    const workspacePath = requireAbsolute(input.workspacePath);
    if (!ALLOWED_EXECUTABLES.has(input.command.executable) || !Number.isInteger(input.port)
      || input.port < 1024 || input.port > 65_535) throw new Error('Invalid bounded Preview Process request');
    const arguments_ = input.command.arguments.map(value => value
      .replaceAll('{host}', '127.0.0.1').replaceAll('{port}', String(input.port)));
    validateArguments(arguments_);
    let logs = '';
    const append = (chunk: unknown) => {
      logs = boundLogs(`${logs}${String(chunk)}`);
    };
    const child = spawn(input.command.executable, arguments_, {
      cwd: workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        HOSTNAME: '127.0.0.1',
        PORT: String(input.port),
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        CI: '1',
        NO_COLOR: '1',
      },
    });
    if (!child.pid) throw new Error('Preview Process did not produce a PID');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    this.owned.set(child.pid, child);
    const origin = `http://127.0.0.1:${input.port}`;
    try {
      await waitUntilReady(origin, child, () => logs);
    } catch (error) {
      child.kill('SIGTERM');
      this.owned.delete(child.pid);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${boundLogs(logs)}`.trim());
    }
    child.unref();
    return { pid: child.pid, origin, logs: boundLogs(logs) };
  }

  async inspect(pid: number, origin: string): Promise<PreviewProcessInspection> {
    if (!Number.isInteger(pid) || pid <= 0 || !isLoopbackOrigin(origin)) return { running: false, reason: 'Invalid Preview Process identity.' };
    try { process.kill(pid, 0); } catch { return { running: false, reason: 'Preview Process PID is not running.' }; }
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2_000), redirect: 'manual' });
      return response.status > 0 ? { running: true, pid } : { running: false, reason: 'Preview origin is unavailable.' };
    } catch {
      return { running: false, reason: 'Preview origin is unavailable.' };
    }
  }

  async stop(pid: number): Promise<void> {
    const child = this.owned.get(pid);
    if (child) child.kill('SIGTERM');
    else {
      try { process.kill(pid, 'SIGTERM'); } catch { return; }
    }
    this.owned.delete(pid);
  }
}

async function waitUntilReady(origin: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Preview Process exited before readiness: ${logs()}`);
    }
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1_000), redirect: 'manual' });
      if (response.status > 0) return;
    } catch { /* readiness polling is bounded to loopback */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error('Preview Process did not become ready within 30000ms.');
}

function validateArguments(arguments_: readonly string[]): void {
  if (!arguments_.length || arguments_.length > 16 || arguments_.some(value =>
    !value || value.length > 256 || value.includes('\0') || /[;&|`$<>\n\r]/.test(value))) {
    throw new Error('Preview command arguments are outside the bounded token contract');
  }
}

function requireAbsolute(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes('\0')) throw new Error('Preview workspace must be canonical and absolute');
  return value;
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
      && url.pathname === '/' && !url.username && !url.password;
  } catch { return false; }
}

function boundLogs(value: string): string {
  const redacted = value.replace(/(token|authorization|password|secret)[=:]\s*\S+/gi, '$1=[REDACTED]');
  return redacted.length > MAX_LOG_CHARS ? redacted.slice(-MAX_LOG_CHARS) : redacted;
}
