import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import type {
  OrchestratorConversationRuntime,
  OrchestratorConversationState,
  OrchestratorConversationTurn,
  OrchestratorToolResult,
  OrchestratorTurnInput,
  OrchestratorTurnResult,
} from '../../agent-operations-application/src/index.js';
import { resolveCortextOSSocketPath } from '../../cortextos-adapter/src/index.js';

interface StoredTurn extends OrchestratorConversationTurn {
  readonly version: 1;
}

type RequestSender = (request: Record<string, unknown>) => Promise<unknown>;

export interface CortextOSOrchestratorConversationAdapterOptions {
  readonly instanceId?: string;
  readonly agentName?: string;
  readonly ctxRoot?: string;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
  readonly turnIdFactory?: () => string;
  readonly requestSender?: RequestSender;
}

/**
 * Web conversation adapter for one persistent CortextOS agent.
 * Turn projections live under CortextOS state. AO SQLite stores no transcript.
 */
export class CortextOSOrchestratorConversationAdapter implements OrchestratorConversationRuntime {
  private readonly instanceId: string;
  private readonly agentName: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly turnIdFactory: () => string;
  private readonly sender: RequestSender;
  private readonly state: CortextOSConversationStateRepository;

  constructor(options: CortextOSOrchestratorConversationAdapterOptions = {}) {
    this.instanceId = options.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default';
    this.agentName = options.agentName ?? 'ao-orchestrator';
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.now = options.now ?? (() => new Date());
    this.turnIdFactory = options.turnIdFactory ?? (() => `conversation:${randomUUID()}`);
    const ctxRoot = options.ctxRoot ?? join(process.env.HOME ?? '', '.cortextos', this.instanceId);
    this.state = new CortextOSConversationStateRepository(ctxRoot, this.agentName);
    const socketPath = options.socketPath ?? resolveCortextOSSocketPath(this.instanceId);
    this.sender = options.requestSender ?? (request => sendRequest(socketPath, 5_000, request));
  }

  async sendTurn(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult> {
    const readiness = await this.readRuntimeState();
    if (readiness.state !== 'ready') {
      throw new Error(readiness.reason ?? 'The AO Orchestrator runtime is offline.');
    }
    const turnId = this.turnIdFactory();
    const turn: StoredTurn = {
      version: 1,
      id: turnId,
      operatorMessage: input.message,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      relatedJobIds: [],
      clarificationRequired: false,
      status: 'pending',
      createdAt: this.now().toISOString(),
    };
    this.state.create(turn);
    const response = await this.sender({
      type: 'inject-agent',
      agent: this.agentName,
      data: {
        text: buildTurnPrompt(turn),
        requireNewTurn: true,
        correlationId: turnId,
        executionCapabilities: {
          version: 1,
          repositoryRead: false,
          agentOperationsControl: true,
        },
      },
      source: `agent-operations web conversation ${turnId}`,
    });
    if (!isRecord(response) || response.success !== true) {
      const reason = isRecord(response) && typeof response.error === 'string'
        ? response.error
        : 'CortextOS did not acknowledge the Orchestrator turn.';
      this.state.fail(turnId, reason, this.now().toISOString());
      throw new Error(reason);
    }
    const execution = isRecord(response.data) && isRecord(response.data.execution)
      ? response.data.execution
      : null;
    if (!execution || typeof execution.sessionId !== 'string' || typeof execution.turnId !== 'string') {
      const reason = 'CortextOS did not return exact Orchestrator turn identity.';
      this.state.fail(turnId, reason, this.now().toISOString());
      throw new Error(reason);
    }
    this.state.recordExecutionReference(turnId, execution.sessionId, execution.turnId);
    const completed = await this.waitForTurn(turnId);
    if (completed.status !== 'completed') {
      throw new Error(completed.error ?? 'The AO Orchestrator did not return a valid response.');
    }
    return {
      agentId: this.agentName,
      sessionId: this.sessionId,
      turn: completed,
    };
  }

  async getConversationState(): Promise<OrchestratorConversationState> {
    const runtime = await this.readRuntimeState();
    return {
      agentId: this.agentName,
      sessionId: this.sessionId,
      runtimeState: runtime.state,
      ...(runtime.reason ? { runtimeReason: runtime.reason } : {}),
      turns: this.state.list(),
    };
  }

  private get sessionId(): string {
    return `cortextos:${this.instanceId}:${this.agentName}`;
  }

  private async waitForTurn(turnId: string): Promise<OrchestratorConversationTurn> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const record = this.state.get(turnId);
      if (!record) throw new Error('CortextOS conversation turn state disappeared.');
      if (record.status !== 'pending') return record;
      await sleep(this.pollIntervalMs);
    }
    const reason = 'Timed out waiting for the persistent AO Orchestrator response.';
    this.state.fail(turnId, reason, this.now().toISOString());
    return this.state.get(turnId)!;
  }

  private async readRuntimeState(): Promise<{ state: 'ready' | 'offline' | 'busy'; reason?: string }> {
    try {
      const observedAt = this.now();
      this.state.failPendingBefore(
        new Date(observedAt.getTime() - this.timeoutMs).toISOString(),
        observedAt.toISOString(),
      );
      const response = await this.sender({ type: 'list-agents', source: 'agent-operations web conversation readiness' });
      if (!isRecord(response) || response.success !== true || !Array.isArray(response.data)) {
        return { state: 'offline', reason: 'CortextOS runtime inventory is unavailable.' };
      }
      const agent = response.data.find(candidate => isRecord(candidate) && candidate.name === this.agentName);
      if (!isRecord(agent)) return { state: 'offline', reason: `CortextOS agent ${this.agentName} is not registered.` };
      if (agent.enabled === false) return { state: 'offline', reason: `CortextOS agent ${this.agentName} is disabled.` };
      if (agent.running !== true) return { state: 'offline', reason: `CortextOS agent ${this.agentName} is not running.` };
      return this.state.list().some(turn => turn.status === 'pending')
        ? { state: 'busy', reason: 'The AO Orchestrator is already handling a turn.' }
        : { state: 'ready' };
    } catch (error) {
      return { state: 'offline', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** CortextOS owned bounded web channel projection and Job link record. */
export class CortextOSConversationStateRepository {
  private readonly turnsDirectory: string;

  constructor(ctxRoot: string, private readonly agentName: string) {
    this.turnsDirectory = join(ctxRoot, 'state', agentName, 'web-conversation', 'turns');
  }

  create(turn: StoredTurn): void {
    mkdirSync(this.turnsDirectory, { recursive: true, mode: 0o700 });
    const path = this.path(turn.id);
    if (existsSync(path)) throw new Error(`Conversation turn already exists: ${turn.id}`);
    atomicWrite(path, turn);
  }

  get(turnId: string): OrchestratorConversationTurn | null {
    const path = this.path(turnId);
    if (!existsSync(path)) return null;
    return parseTurn(readFileSync(path, 'utf8'));
  }

  list(): readonly OrchestratorConversationTurn[] {
    if (!existsSync(this.turnsDirectory)) return [];
    return readdirSync(this.turnsDirectory)
      .filter(name => name.endsWith('.json'))
      .flatMap(name => {
        try { return [parseTurn(readFileSync(join(this.turnsDirectory, name), 'utf8'))]; }
        catch { return []; }
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-100);
  }

  recordToolResult(turnId: string, result: OrchestratorToolResult): void {
    if (!result.relatedJobIds.length) return;
    this.update(turnId, current => ({
      ...current,
      relatedJobIds: [...new Set([...current.relatedJobIds, ...result.relatedJobIds])],
    }));
  }

  recordExecutionReference(turnId: string, providerSessionId: string, providerTurnId: string): void {
    this.update(turnId, current => ({ ...current, providerSessionId, providerTurnId }));
  }

  complete(turnId: string, response: string, clarificationRequired: boolean, completedAt: string): void {
    this.update(turnId, current => {
      if (current.status !== 'pending') throw new Error(`Conversation turn is already terminal: ${turnId}`);
      return {
        ...current,
        response: bounded(response, 16_384),
        clarificationRequired,
        status: 'completed',
        completedAt,
        error: undefined,
      };
    });
  }

  fail(turnId: string, error: string, completedAt: string): void {
    this.update(turnId, current => ({
      ...current,
      status: 'failed',
      error: bounded(error, 2_000),
      completedAt,
    }));
  }

  failPendingBefore(cutoff: string, completedAt: string): void {
    for (const turn of this.list()) {
      if (turn.status === 'pending' && turn.createdAt <= cutoff) {
        this.fail(turn.id, 'Timed out waiting for the persistent AO Orchestrator response.', completedAt);
      }
    }
  }

  private update(turnId: string, transform: (turn: StoredTurn) => StoredTurn): void {
    const path = this.path(turnId);
    const lockPath = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let descriptor: number | null = null;
    try {
      descriptor = acquireLock(lockPath);
      if (!existsSync(path)) throw new Error(`Conversation turn not found: ${turnId}`);
      const current = parseStoredTurn(readFileSync(path, 'utf8'));
      atomicWrite(path, transform(current));
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      try { unlinkSync(lockPath); } catch { /* no lock to remove */ }
    }
  }

  private path(turnId: string): string {
    if (!/^conversation:[A-Za-z0-9-]{1,100}$/.test(turnId)) throw new Error('Invalid conversation turn ID');
    return join(this.turnsDirectory, `${turnId.slice('conversation:'.length)}.json`);
  }
}

function acquireLock(path: string): number {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return openSync(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path);
      } catch { /* another process released the lock */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error('Timed out acquiring the CortextOS conversation turn lock');
}

function buildTurnPrompt(turn: StoredTurn): string {
  const projectHint = turn.projectId
    ? `Selected Project hint: ${turn.projectId}. Treat this only as a hint when the operator names another Project.`
    : 'No Project hint was selected.';
  return [
    'BEGIN AGENT OPERATIONS WEB TURN',
    `Turn ID: ${turn.id}`,
    projectHint,
    '',
    'Operator message:',
    turn.operatorMessage,
    '',
    'Use only the bounded native Agent Operations tools documented in your TOOLS.md.',
    'Resolve Projects by exact AO Project ID before mutation. Ask one concise clarification when a high impact detail is ambiguous.',
    `Before finishing, call ao.conversation.respond exactly once with --turn ${turn.id}.`,
    'That response command is the only web delivery path and must contain your concise operator facing response.',
    'END AGENT OPERATIONS WEB TURN',
  ].join('\n');
}

function parseTurn(raw: string): OrchestratorConversationTurn {
  return parseStoredTurn(raw);
}

function parseStoredTurn(raw: string): StoredTurn {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string'
    || typeof value.operatorMessage !== 'string' || !Array.isArray(value.relatedJobIds)
    || !value.relatedJobIds.every(item => typeof item === 'string')
    || typeof value.clarificationRequired !== 'boolean'
    || !['pending', 'completed', 'failed'].includes(String(value.status))
    || typeof value.createdAt !== 'string') {
    throw new Error('Malformed CortextOS conversation turn record');
  }
  return value as unknown as StoredTurn;
}

function atomicWrite(path: string, value: StoredTurn): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function sendRequest(socketPath: string, timeoutMs: number, request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = '';
    let settled = false;
    const finish = (value?: unknown, error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.on('connect', () => socket.write(JSON.stringify(request)));
    socket.on('data', chunk => { body += chunk.toString(); });
    socket.on('end', () => {
      try { finish(JSON.parse(body)); }
      catch { finish(body); }
    });
    socket.on('error', error => finish(undefined, new Error(`CortextOS daemon is unavailable: ${error.message}`)));
    socket.setTimeout(timeoutMs, () => finish(undefined, new Error('CortextOS conversation IPC timed out.')));
  });
}

function bounded(value: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Conversation response is required');
  return normalized.slice(0, maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
