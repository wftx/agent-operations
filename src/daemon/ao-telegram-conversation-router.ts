import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  RuntimeExecutionCapabilitiesEnvelope,
  RuntimeExecutionPolicyEnvelope,
} from '../types/index.js';
import type { CorrelatedInjectionResult } from './agent-process.js';

type LogFn = (message: string) => void;

export interface AoTelegramConversationProcess {
  injectCorrelatedMessageDetailed(
    content: string,
    correlationId: string,
    executionPolicy?: RuntimeExecutionPolicyEnvelope,
    executionContext?: undefined,
    executionCapabilities?: RuntimeExecutionCapabilitiesEnvelope,
  ): Promise<CorrelatedInjectionResult>;
}

export interface AoTelegramConversationSender {
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export interface RouteAoTelegramConversationInput {
  readonly agentProcess: AoTelegramConversationProcess;
  readonly telegramApi: AoTelegramConversationSender;
  readonly chatId: number;
  readonly ctxRoot: string;
  readonly agentName: string;
  readonly messageId: number;
  readonly operatorMessage: string;
  readonly replyContext?: string;
  readonly log: LogFn;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Routes one native Telegram update through the same durable conversation
 * projection and exact correlated turn used by AO Web. A deterministic turn
 * ID makes Telegram redelivery a no op instead of another provider turn.
 */
export async function routeAoTelegramConversation(input: RouteAoTelegramConversationInput): Promise<void> {
  const state = new NativeConversationProjection(input.ctxRoot, input.agentName);
  const turnId = telegramTurnId(input.chatId, input.messageId);
  if (state.get(turnId)) {
    input.log(`Duplicate AO Telegram conversation update suppressed: ${turnId}`);
    return;
  }
  const now = input.now ?? (() => new Date());
  state.create({
    version: 1,
    id: turnId,
    operatorMessage: input.operatorMessage,
    relatedJobIds: [],
    clarificationRequired: false,
    status: 'pending',
    createdAt: now().toISOString(),
  });
  const submission = await input.agentProcess.injectCorrelatedMessageDetailed(
    buildTelegramTurnPrompt(turnId, input.operatorMessage, input.replyContext),
    turnId,
    undefined,
    undefined,
    { version: 1, repositoryRead: false, agentOperationsControl: true },
  );
  if (!submission.ok) {
    const reason = `The AO Orchestrator did not accept this Telegram turn: ${submission.message}`;
    state.fail(turnId, reason, now().toISOString());
    await input.telegramApi.sendMessage(input.chatId, 'Agent Operations could not safely accept that request. Open AO Web for details.');
    return;
  }
  if (!submission.sessionId || !submission.turnId) {
    const reason = 'CortextOS did not return exact Orchestrator turn identity.';
    state.fail(turnId, reason, now().toISOString());
    await input.telegramApi.sendMessage(input.chatId, 'Agent Operations could not verify the exact turn. No follow up was sent.');
    return;
  }
  state.recordExecutionReference(turnId, submission.sessionId, submission.turnId);
  const wait = input.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + (input.timeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    const turn = state.get(turnId);
    if (!turn) throw new Error(`AO Telegram conversation state disappeared: ${turnId}`);
    if (turn.status === 'completed') {
      await input.telegramApi.sendMessage(input.chatId, turn.response!);
      return;
    }
    if (turn.status === 'failed') {
      await input.telegramApi.sendMessage(input.chatId, 'Agent Operations could not complete that request. Open AO Web for details.');
      return;
    }
    await wait(input.pollIntervalMs ?? 250);
  }
  state.fail(turnId, 'Timed out waiting for the persistent AO Orchestrator response.', now().toISOString());
  await input.telegramApi.sendMessage(input.chatId, 'Agent Operations is still waiting on that request. Open AO Web before trying again.');
}

interface NativeConversationTurn {
  readonly version: 1;
  readonly id: string;
  readonly operatorMessage: string;
  readonly relatedJobIds: readonly string[];
  readonly clarificationRequired: boolean;
  readonly status: 'pending' | 'completed' | 'failed';
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly response?: string;
  readonly error?: string;
  readonly providerSessionId?: string;
  readonly providerTurnId?: string;
}

/** Same CortextOS owned JSON projection consumed by AO Web and the native tool bridge. */
class NativeConversationProjection {
  private readonly turnsDirectory: string;

  constructor(ctxRoot: string, agentName: string) {
    this.turnsDirectory = join(ctxRoot, 'state', agentName, 'web-conversation', 'turns');
  }

  create(turn: NativeConversationTurn): void {
    mkdirSync(this.turnsDirectory, { recursive: true, mode: 0o700 });
    const path = this.path(turn.id);
    if (existsSync(path)) throw new Error(`Conversation turn already exists: ${turn.id}`);
    atomicWrite(path, turn);
  }

  get(turnId: string): NativeConversationTurn | null {
    const path = this.path(turnId);
    if (!existsSync(path)) return null;
    return parseTurn(readFileSync(path, 'utf8'));
  }

  recordExecutionReference(turnId: string, providerSessionId: string, providerTurnId: string): void {
    this.update(turnId, turn => ({ ...turn, providerSessionId, providerTurnId }));
  }

  fail(turnId: string, error: string, completedAt: string): void {
    this.update(turnId, turn => ({ ...turn, status: 'failed', error: error.slice(0, 2_000), completedAt }));
  }

  private update(turnId: string, transform: (turn: NativeConversationTurn) => NativeConversationTurn): void {
    const path = this.path(turnId);
    const lockPath = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let descriptor: number | null = null;
    try {
      descriptor = acquireLock(lockPath);
      if (!existsSync(path)) throw new Error(`Conversation turn not found: ${turnId}`);
      atomicWrite(path, transform(parseTurn(readFileSync(path, 'utf8'))));
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

function parseTurn(raw: string): NativeConversationTurn {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed conversation turn');
  const turn = value as Record<string, unknown>;
  if (turn['version'] !== 1 || typeof turn['id'] !== 'string'
    || typeof turn['operatorMessage'] !== 'string' || !Array.isArray(turn['relatedJobIds'])
    || typeof turn['clarificationRequired'] !== 'boolean'
    || !['pending', 'completed', 'failed'].includes(String(turn['status']))
    || typeof turn['createdAt'] !== 'string') {
    throw new Error('Malformed conversation turn');
  }
  return turn as unknown as NativeConversationTurn;
}

function acquireLock(path: string): number {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { return openSync(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path); }
      catch { /* another process released the lock */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error('Timed out acquiring the CortextOS conversation turn lock');
}

function atomicWrite(path: string, turn: NativeConversationTurn): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(turn, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function telegramTurnId(chatId: number, messageId: number): string {
  const digest = createHash('sha256')
    .update(String(chatId))
    .update('\0')
    .update(String(messageId))
    .digest('hex')
    .slice(0, 32);
  return `conversation:telegram-${digest}`;
}

function buildTelegramTurnPrompt(turnId: string, operatorMessage: string, replyContext?: string): string {
  return [
    'BEGIN AGENT OPERATIONS TELEGRAM TURN',
    `Turn ID: ${turnId}`,
    '',
    'Operator message:',
    operatorMessage,
    ...(replyContext ? ['', 'Most recent AO Telegram context:', replyContext.slice(0, 3_500)] : []),
    '',
    'Use only the bounded native Agent Operations tools documented in your TOOLS.md.',
    'Resolve Projects by exact AO Project ID before mutation. Ask one concise clarification when a high impact detail is ambiguous.',
    'Red actions still require explicit human approval through the normal Agent Operations authority boundary.',
    `Before finishing, call ao.conversation.respond exactly once with --turn ${turnId}.`,
    'That response command is the only Telegram delivery path and must contain a concise operator facing response.',
    'END AGENT OPERATIONS TELEGRAM TURN',
  ].join('\n');
}
