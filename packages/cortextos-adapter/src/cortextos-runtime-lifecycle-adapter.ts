import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  AgentRuntimeAdapter,
  AgentRuntimeSummary,
  RuntimeAgentStartResult,
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
  readonly sendAgentCommand?: (
    agentName: string,
  ) => Promise<{ readonly success: boolean; readonly error?: string }>;
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
  private readonly sendAgentCommand: NonNullable<CortextOSRuntimeLifecycleAdapterOptions['sendAgentCommand']>;
  private startInFlight: Promise<RuntimeStartResult> | null = null;
  private restartInFlight: Promise<RuntimeStartResult> | null = null;
  private readonly agentStartsInFlight = new Map<string, Promise<RuntimeAgentStartResult>>();

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
    this.sendAgentCommand = options.sendAgentCommand
      ?? (agentName => sendStartAgent(this.instanceId, this.ctxRoot, agentName));
  }

  async start(): Promise<RuntimeStartResult> {
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.startOnce().finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  async restart(): Promise<RuntimeStartResult> {
    if (this.restartInFlight) return this.restartInFlight;
    this.restartInFlight = this.restartOnce().finally(() => { this.restartInFlight = null; });
    return this.restartInFlight;
  }

  async ensureAgentRunning(agentId: string): Promise<RuntimeAgentStartResult> {
    const cleanId = agentId.trim();
    const existing = this.agentStartsInFlight.get(cleanId);
    if (existing) return existing;
    const operation = this.ensureAgentRunningOnce(cleanId)
      .finally(() => this.agentStartsInFlight.delete(cleanId));
    this.agentStartsInFlight.set(cleanId, operation);
    return operation;
  }

  private async ensureAgentRunningOnce(agentId: string): Promise<RuntimeAgentStartResult> {
    const initial = await this.runtime.getAgent(agentId).catch(() => null);
    if (!initial || !initial.configured || initial.provider === 'unknown') {
      return agentStartFailure(agentId, 'Worker runtime is not a known configured agent.');
    }
    if (initial.enabled !== false && initial.health.state === 'running') {
      return {
        status: 'ready', agentId, message: `Runtime ${agentId} is already running.`,
        enabled: false, started: false,
      };
    }
    const safety = this.inspectExecutionAgentSafety(initial.organization, initial.name);
    if (!safety.safe) return agentStartFailure(agentId, safety.reason);

    const registryPath = join(this.ctxRoot, 'config', 'enabled-agents.json');
    let originalRegistry: string | null = null;
    let enabledByThisCall = false;
    try {
      originalRegistry = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null;
      const registry = originalRegistry === null ? {} : parseRegistry(originalRegistry);
      const registered = registry[initial.name];
      const current: Record<string, unknown> = isRecord(registered) ? registered : {};
      if (initial.enabled === false || !isRecord(registered)) {
        registry[initial.name] = {
          ...current,
          enabled: true,
          status: 'configured',
          ...(initial.organization ? { org: initial.organization } : {}),
        };
        writeAtomicJson(registryPath, registry);
        enabledByThisCall = true;
      }
      const response = await this.sendAgentCommand(initial.name);
      if (!response.success) throw new Error(response.error ?? 'Daemon rejected the Worker start request.');
      const startedAt = Date.now();
      while (Date.now() - startedAt <= this.readinessTimeoutMs) {
        const observed = await this.runtime.getAgent(agentId).catch(() => null);
        if (observed?.enabled !== false && observed?.health.state === 'running') {
          return {
            status: 'started', agentId, message: `Runtime ${agentId} is running.`,
            enabled: enabledByThisCall, started: true,
          };
        }
        await this.sleep(this.readinessIntervalMs);
      }
      throw new Error(`Runtime ${agentId} did not become running within the bounded readiness window.`);
    } catch (error) {
      if (enabledByThisCall) restoreRegistry(registryPath, originalRegistry);
      return agentStartFailure(agentId, errorMessage(error), enabledByThisCall);
    }
  }

  private inspectExecutionAgentSafety(
    organization: string | null,
    name: string,
  ): { readonly safe: true } | { readonly safe: false; readonly reason: string } {
    if (!organization || !/^[A-Za-z0-9._-]+$/.test(organization) || !/^[A-Za-z0-9._-]+$/.test(name)) {
      return { safe: false, reason: 'Worker runtime configuration identity is unsafe.' };
    }
    const agentsRoot = resolve(this.frameworkRoot, 'orgs', organization, 'agents');
    const agentRoot = resolve(agentsRoot, name);
    const fromAgentsRoot = relative(agentsRoot, agentRoot);
    if (fromAgentsRoot.startsWith(`..${sep}`) || fromAgentsRoot === '..' || isAbsolute(fromAgentsRoot)) {
      return { safe: false, reason: 'Worker runtime configuration escaped the agents root.' };
    }
    try {
      const config = JSON.parse(readFileSync(join(agentRoot, 'config.json'), 'utf8')) as unknown;
      if (!isRecord(config)) throw new Error('config root is not an object');
      if (config.telegram_polling !== false) {
        return { safe: false, reason: 'Worker runtime recovery would activate Telegram polling.' };
      }
      if (!Array.isArray(config.crons) || config.crons.length > 0) {
        return { safe: false, reason: 'Worker runtime recovery would activate configured schedules.' };
      }
      const cronPath = join(this.ctxRoot, '.cortextOS', 'state', 'agents', name, 'crons.json');
      if (existsSync(cronPath)) {
        const crons = JSON.parse(readFileSync(cronPath, 'utf8')) as unknown;
        const values = Array.isArray(crons) ? crons : isRecord(crons) ? crons.crons : null;
        if (!Array.isArray(values) || values.length > 0) {
          return { safe: false, reason: 'Worker runtime recovery would activate durable schedules.' };
        }
      }
      return { safe: true };
    } catch (error) {
      return { safe: false, reason: `Worker runtime configuration could not be verified: ${errorMessage(error)}` };
    }
  }

  private async restartOnce(): Promise<RuntimeStartResult> {
    const agents = await this.runtime.listAgents().catch(() => [] as readonly AgentRuntimeSummary[]);
    const inventory = this.readInventory(agents);
    const cliPath = join(this.frameworkRoot, 'dist', 'cli.js');
    if (!existsSync(cliPath)) return this.failed(inventory, 'CortextOS is not built.', `Missing canonical startup entry: ${cliPath}`);
    if (this.readLiveOwner()) {
      const stopped = spawnSync(process.execPath, [cliPath, 'stop', '--instance', this.instanceId], {
        cwd: this.frameworkRoot,
        env: { ...this.environment, CTX_INSTANCE_ID: this.instanceId, CTX_ROOT: this.ctxRoot },
        encoding: 'utf8',
        timeout: this.readinessTimeoutMs,
      });
      if (stopped.status !== 0) {
        return this.failed(
          inventory,
          'Runtime could not be stopped cleanly.',
          boundedDiagnostic(stopped.stderr || stopped.stdout || 'Canonical stop command failed.'),
        );
      }
      const deadline = Date.now() + this.readinessTimeoutMs;
      while (Date.now() < deadline && this.readLiveOwner()) await this.sleep(this.readinessIntervalMs);
      if (this.readLiveOwner()) {
        return this.failed(inventory, 'Runtime stop did not settle.', 'The canonical owner remained live after the bounded stop window.');
      }
    }
    return this.start();
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

function parseRegistry(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) throw new Error('Enabled agent registry is not an object.');
  return value;
}

function writeAtomicJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.ao-${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function restoreRegistry(path: string, raw: string | null): void {
  try {
    if (raw === null) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    const temporary = `${path}.ao-restore-${process.pid}-${randomUUID()}.tmp`;
    writeFileSync(temporary, raw, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch {
    // The failed recovery result remains truthful even if registry rollback fails.
  }
}

function agentStartFailure(
  agentId: string,
  diagnostic: string,
  enabled = false,
): RuntimeAgentStartResult {
  return {
    status: 'failed', agentId, message: `Runtime ${agentId} could not be started safely.`,
    enabled, started: false, diagnostic: boundedDiagnostic(diagnostic),
  };
}

function sendStartAgent(
  instanceId: string,
  ctxRoot: string,
  agentName: string,
): Promise<{ readonly success: boolean; readonly error?: string }> {
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\cortextos-${instanceId}`
    : join(ctxRoot, 'daemon.sock');
  return new Promise(resolveResponse => {
    const socket = createConnection(socketPath);
    let data = '';
    let settled = false;
    const finish = (result: { readonly success: boolean; readonly error?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveResponse(result);
    };
    socket.on('connect', () => {
      socket.write(JSON.stringify({
        type: 'start-agent', agent: agentName, source: 'agent-operations daily-driver recovery',
      }));
    });
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => {
      try {
        const result = JSON.parse(data) as unknown;
        finish(isRecord(result) && result.success === true
          ? { success: true }
          : { success: false, error: isRecord(result) && typeof result.error === 'string'
            ? result.error : 'Daemon returned an invalid start response.' });
      } catch {
        finish({ success: false, error: 'Daemon returned an invalid start response.' });
      }
    });
    socket.on('error', error => finish({ success: false, error: error.message }));
    socket.setTimeout(5_000, () => finish({ success: false, error: 'Daemon start request timed out.' }));
  });
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
