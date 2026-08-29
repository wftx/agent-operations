import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  AgentRuntimeAdapter,
  AgentRuntimeSummary,
  RuntimeLifecycleAdapter,
  RuntimeStartResult,
  RuntimeStartupInventory,
} from '../../agent-operations-contracts/src/index.js';
import { CortextOSRuntimeAdapter } from './cortextos-runtime-adapter.js';

const DEFAULT_CODEX_CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
] as const;
const STARTUP_DIAGNOSTIC_MAX_CHARS = 4_000;

interface SpawnedRuntimeProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

export interface CortextOSRuntimeLifecycleAdapterOptions {
  readonly instanceId?: string;
  readonly frameworkRoot?: string;
  readonly ctxRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtime?: AgentRuntimeAdapter;
  readonly readinessTimeoutMs?: number;
  readonly readinessIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly codexCandidates?: readonly string[];
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly stdoutFd: number; readonly stderrFd: number },
  ) => SpawnedRuntimeProcess;
  readonly isProcessAlive?: (pid: number) => boolean;
}

/** Explicit local lifecycle mutation. Inventory methods never call this adapter. */
export class CortextOSRuntimeLifecycleAdapter implements RuntimeLifecycleAdapter {
  private readonly instanceId: string;
  private readonly frameworkRoot: string;
  private readonly ctxRoot: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runtime: AgentRuntimeAdapter;
  private readonly readinessTimeoutMs: number;
  private readonly readinessIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly codexCandidates: readonly string[];
  private readonly spawnProcess: NonNullable<CortextOSRuntimeLifecycleAdapterOptions['spawnProcess']>;
  private readonly isProcessAlive: (pid: number) => boolean;
  private startInFlight: Promise<RuntimeStartResult> | null = null;

  constructor(options: CortextOSRuntimeLifecycleAdapterOptions = {}) {
    this.instanceId = options.instanceId ?? options.environment?.CTX_INSTANCE_ID
      ?? process.env.CTX_INSTANCE_ID ?? 'default';
    if (!/^[A-Za-z0-9_-]+$/.test(this.instanceId)) {
      throw new Error(`Invalid CortextOS instance ID: ${this.instanceId}`);
    }
    this.frameworkRoot = resolve(options.frameworkRoot ?? process.cwd());
    this.ctxRoot = resolve(options.ctxRoot ?? join(homedir(), '.cortextos', this.instanceId));
    this.environment = { ...(options.environment ?? process.env) };
    this.runtime = options.runtime ?? new CortextOSRuntimeAdapter({
      instanceId: this.instanceId,
      frameworkRoot: this.frameworkRoot,
      ctxRoot: this.ctxRoot,
    });
    this.readinessTimeoutMs = boundedDuration(options.readinessTimeoutMs ?? 30_000, 'Readiness timeout');
    this.readinessIntervalMs = boundedDuration(options.readinessIntervalMs ?? 250, 'Readiness interval');
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)));
    this.codexCandidates = options.codexCandidates ?? DEFAULT_CODEX_CANDIDATES;
    this.spawnProcess = options.spawnProcess ?? spawnRuntimeProcess;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  async start(): Promise<RuntimeStartResult> {
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.startOnce().finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private async startOnce(): Promise<RuntimeStartResult> {
    const agents = await this.runtime.listAgents().catch(() => [] as readonly AgentRuntimeSummary[]);
    const inventory = this.readInventory(agents);
    const health = await this.runtime.getHealth().catch(() => null);
    const running = agents.filter(agent => agent.configured && agent.enabled !== false
      && agent.health.state === 'running');
    if (health?.state === 'available' && running.length > 0) {
      return {
        status: 'already-running',
        instanceId: this.instanceId,
        message: `Runtime is already ready with ${running.length} configured agent(s).`,
        inventory,
        ...(running[0]?.health.pid ? { daemonPid: running[0].health.pid } : {}),
      };
    }

    const owner = this.readLiveOwner();
    if (owner) {
      return this.failed(
        inventory,
        `CortextOS instance ${this.instanceId} already has a live owner.`,
        `Competing daemon owner PID ${owner.pid}; startup was not attempted.`,
      );
    }
    if (!agents.length) {
      return this.failed(inventory, 'Runtime configuration could not be inventoried.', 'No configured agents were found.');
    }
    if (agents.some(agent => !agent.configured || agent.provider === 'unknown')) {
      return this.failed(
        inventory,
        'Runtime inventory is not safe to start.',
        'One or more configured agent identities or providers could not be understood.',
      );
    }

    const codexExecutable = resolveCodexExecutable(this.environment, this.codexCandidates);
    if (!codexExecutable) {
      return this.failed(
        inventory,
        'Codex executable was not found.',
        'Set AO_CODEX_EXECUTABLE to an executable absolute path or install Codex in a known PATH location.',
      );
    }
    const cliPath = join(this.frameworkRoot, 'dist', 'cli.js');
    if (!existsSync(cliPath)) {
      return this.failed(inventory, 'CortextOS is not built.', `Missing canonical startup entry: ${cliPath}`);
    }

    const logDirectory = join(this.ctxRoot, 'logs');
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    const logPath = join(logDirectory, 'agent-operations-runtime-start.log');
    const logFd = openSync(logPath, 'a', 0o600);
    chmodSync(logPath, 0o600);
    const childEnvironment: NodeJS.ProcessEnv = {
      ...this.environment,
      PATH: prependPath(dirname(codexExecutable), this.environment.PATH),
      CTX_INSTANCE_ID: this.instanceId,
      CTX_ROOT: this.ctxRoot,
      CTX_FRAMEWORK_ROOT: this.frameworkRoot,
      CTX_PROJECT_ROOT: this.frameworkRoot,
    };
    let child: SpawnedRuntimeProcess;
    try {
      child = this.spawnProcess(process.execPath, [
        cliPath,
        'start',
        '--foreground',
        '--instance',
        this.instanceId,
      ], {
        cwd: this.frameworkRoot,
        env: childEnvironment,
        stdoutFd: logFd,
        stderrFd: logFd,
      });
    } catch (error) {
      closeSync(logFd);
      return this.failed(inventory, 'Runtime process could not be started.', boundedDiagnostic(errorMessage(error)));
    }
    closeSync(logFd);

    let earlyExit: string | null = null;
    child.once('error', error => { earlyExit = errorMessage(error); });
    child.once('exit', (code, signal) => {
      earlyExit = `Canonical startup exited before readiness with code ${code ?? 'unknown'} and signal ${signal ?? 'none'}.`;
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt <= this.readinessTimeoutMs) {
      const snapshot = await this.runtime.getHealth().catch(() => null);
      const currentAgents = await this.runtime.listAgents().catch(() => [] as readonly AgentRuntimeSummary[]);
      const readyAgents = currentAgents.filter(agent => agent.configured && agent.enabled !== false
        && agent.health.state === 'running');
      if (snapshot?.state === 'available' && readyAgents.length > 0) {
        child.unref();
        return {
          status: 'started',
          instanceId: this.instanceId,
          message: `Runtime is ready with ${readyAgents.length} configured agent(s).`,
          inventory: this.readInventory(currentAgents),
          ...(child.pid ? { daemonPid: child.pid } : {}),
        };
      }
      if (earlyExit !== null || child.exitCode !== null) {
        return this.failed(
          inventory,
          'Runtime failed before readiness.',
          boundedDiagnostic(`${earlyExit ?? 'Canonical startup exited.'} ${readBoundedTail(logPath)}`),
        );
      }
      await this.sleep(this.readinessIntervalMs);
    }
    return this.failed(
      inventory,
      'Runtime did not become ready within the bounded startup window.',
      boundedDiagnostic(readBoundedTail(logPath) || 'No bounded startup diagnostic was recorded.'),
    );
  }

  private failed(
    inventory: RuntimeStartupInventory,
    message: string,
    diagnostic: string,
  ): RuntimeStartResult {
    return {
      status: 'failed',
      instanceId: this.instanceId,
      message,
      inventory,
      diagnostic: boundedDiagnostic(diagnostic),
    };
  }

  private readInventory(agents: readonly AgentRuntimeSummary[]): RuntimeStartupInventory {
    let configuredCronCount = 0;
    let configuredIntegrationCount = 0;
    for (const agent of agents.filter(item => item.configured)) {
      const cronPath = join(this.ctxRoot, '.cortextOS', 'state', 'agents', agent.name, 'crons.json');
      try {
        const value = JSON.parse(readFileSync(cronPath, 'utf8')) as unknown;
        if (Array.isArray(value)) configuredCronCount += value.length;
        else if (isRecord(value) && Array.isArray(value.crons)) configuredCronCount += value.crons.length;
      } catch {
        // Missing or malformed configuration is reported by the runtime itself.
      }
      if (agent.organization
        && existsSync(join(this.frameworkRoot, 'orgs', agent.organization, 'agents', agent.name, '.env'))) {
        configuredIntegrationCount += 1;
      }
    }
    return {
      configuredAgents: agents.filter(agent => agent.configured).map(agent => ({
        id: agent.id,
        provider: agent.provider,
        enabled: agent.enabled,
      })),
      configuredCronCount,
      configuredIntegrationCount,
    };
  }

  private readLiveOwner(): { readonly pid: number } | null {
    try {
      const value = JSON.parse(readFileSync(join(this.ctxRoot, 'daemon.owner', 'owner.json'), 'utf8')) as unknown;
      if (!isRecord(value) || value.instanceId !== this.instanceId
        || !Number.isInteger(value.pid) || Number(value.pid) <= 0) return null;
      return this.isProcessAlive(Number(value.pid)) ? { pid: Number(value.pid) } : null;
    } catch {
      return null;
    }
  }
}

export function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = DEFAULT_CODEX_CANDIDATES,
): string | null {
  const configured = environment.AO_CODEX_EXECUTABLE?.trim();
  if (configured) return executablePath(configured, environment.PATH);
  const fromPath = executablePath('codex', environment.PATH);
  if (fromPath) return fromPath;
  for (const candidate of candidates) {
    const executable = executablePath(candidate, environment.PATH);
    if (executable) return executable;
  }
  return null;
}

function executablePath(value: string, pathValue: string | undefined): string | null {
  let candidate: string | null = null;
  if (isAbsolute(value)) candidate = resolve(value);
  else if (/^[A-Za-z0-9._-]+$/.test(value)) {
    const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [value], {
      encoding: 'utf8',
      env: { PATH: pathValue ?? '' },
    });
    candidate = lookup.status === 0 ? lookup.stdout.split(/\r?\n/)[0]?.trim() ?? null : null;
  }
  if (!candidate) return null;
  try {
    accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function spawnRuntimeProcess(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly stdoutFd: number; readonly stderrFd: number },
): ChildProcess {
  return spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', options.stdoutFd, options.stderrFd],
    detached: true,
  });
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readBoundedTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-STARTUP_DIAGNOSTIC_MAX_CHARS);
  } catch {
    return '';
  }
}

function boundedDiagnostic(value: string): string {
  return value
    .replace(/\b\d{7,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(/((?:api[_-]?key|token|secret|authorization)\s*[:=])\s*\S+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STARTUP_DIAGNOSTIC_MAX_CHARS);
}

function prependPath(directory: string, current: string | undefined): string {
  return [directory, current].filter(Boolean).join(delimiter);
}

function boundedDuration(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 120_000) {
    throw new Error(`${field} must be an integer between 0 and 120000ms`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
