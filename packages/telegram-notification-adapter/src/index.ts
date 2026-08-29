import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { TelegramAPI } from '../../../src/telegram/api.js';
import type {
  OperatorNotificationEvent,
  OperatorNotificationResult,
  OperatorNotifier,
} from '../../agent-operations-application/src/index.js';

export interface TelegramOperatorNotificationConfig {
  readonly botToken: string;
  readonly chatId: string;
}

export const AGENT_OPERATIONS_TELEGRAM_ENV_FILE = '.agent-operations/telegram.env';
export const TELEGRAM_NOTIFICATION_TEST_CONFIRMATION = 'TELEGRAM_TEST';
export const TELEGRAM_NOTIFICATION_TEST_MESSAGE = `✅ Agent Operations Telegram test

Notifications are connected.

No Job was executed.
No agent instruction was sent.`;

export interface TelegramMessageSender {
  sendMessage(
    chatId: string | number,
    text: string,
    replyMarkup?: object,
    options?: { readonly parseMode?: 'HTML' | null },
  ): Promise<unknown>;
}

export function loadTelegramOperatorNotificationConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelegramOperatorNotificationConfig | null {
  const botToken = environment['AO_TELEGRAM_BOT_TOKEN']?.trim();
  const chatId = environment['AO_TELEGRAM_CHAT_ID']?.trim();
  if (!botToken && !chatId) return null;
  if (!botToken || !chatId) {
    throw new Error('AO Telegram notifications require both AO_TELEGRAM_BOT_TOKEN and AO_TELEGRAM_CHAT_ID');
  }
  return { botToken, chatId };
}

/** Loads only the two AO Telegram variables from a local, ignored file. */
export function loadAgentOperationsTelegramEnvironmentFile(
  filePath: string = resolve(AGENT_OPERATIONS_TELEGRAM_ENV_FILE),
  environment: NodeJS.ProcessEnv = process.env,
): { readonly loaded: boolean; readonly configuredKeys: readonly string[] } {
  if (!existsSync(filePath)) return { loaded: false, configuredKeys: [] };
  if (process.platform !== 'win32' && (statSync(filePath).mode & 0o077) !== 0) {
    throw new Error('Agent Operations Telegram environment file must use permissions 0600');
  }
  const configuredKeys: string[] = [];
  for (const [index, sourceLine] of readFileSync(filePath, 'utf8').split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(AO_TELEGRAM_BOT_TOKEN|AO_TELEGRAM_CHAT_ID)=(.*)$/);
    if (!match) {
      throw new Error(`Unsupported Agent Operations Telegram environment entry on line ${index + 1}`);
    }
    const key = match[1];
    const value = unquote(match[2].trim());
    if (!value) throw new Error(`${key} must not be empty`);
    if (!environment[key]?.trim()) environment[key] = value;
    configuredKeys.push(key);
  }
  return { loaded: true, configuredKeys };
}

/** Delivery-only adapter. Telegram never reads or mutates Agent Operations state. */
export class TelegramOperatorNotifier implements OperatorNotifier {
  private readonly sender: TelegramMessageSender;

  constructor(
    private readonly config: TelegramOperatorNotificationConfig,
    sender?: TelegramMessageSender,
  ) {
    this.sender = sender ?? new TelegramAPI(config.botToken);
  }

  async notify(event: OperatorNotificationEvent): Promise<OperatorNotificationResult> {
    try {
      await this.sender.sendMessage(
        this.config.chatId,
        formatOperatorTelegramMessage(event),
        undefined,
        { parseMode: null },
      );
    } catch (error) {
      throw new Error(redactTelegramCredentials(errorMessage(error), this.config));
    }
    return { status: 'sent' };
  }
}

export type TelegramNotificationTestStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface TelegramNotificationTestReceipt {
  readonly id: string;
  readonly kind: 'telegram_test';
  readonly status: TelegramNotificationTestStatus;
  readonly configured: boolean;
  readonly deliveryClaimed: boolean;
  readonly realRequestCount: 0 | 1;
  readonly message?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attemptedAt?: string;
}

export interface TelegramNotificationTestRecorder {
  record(receipt: TelegramNotificationTestReceipt): Promise<void>;
}

/** Immutable local receipt files; no Job or Escalation row is created for a connectivity test. */
export class FileTelegramNotificationTestRecorder implements TelegramNotificationTestRecorder {
  constructor(readonly directory: string) {}

  async record(receipt: TelegramNotificationTestReceipt): Promise<void> {
    if (!/^[a-z0-9-]+$/i.test(receipt.id)) throw new Error('Invalid Telegram test receipt ID');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const name = `${receipt.id}-${receipt.revision}-${receipt.status}.json`;
    const target = join(this.directory, name);
    const temporary = join(this.directory, `.${name}.${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  }
}

export interface TelegramNotificationTestOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly send?: boolean;
  readonly confirmation?: string;
  readonly senderFactory?: (config: TelegramOperatorNotificationConfig) => TelegramMessageSender;
  readonly recorder?: TelegramNotificationTestRecorder;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

/** One explicit connectivity check. This function has no retry or replay path. */
export async function runTelegramNotificationTest(
  options: TelegramNotificationTestOptions = {},
): Promise<TelegramNotificationTestReceipt> {
  const environment = options.environment ?? process.env;
  const send = options.send ?? false;
  if (send && options.confirmation !== TELEGRAM_NOTIFICATION_TEST_CONFIRMATION) {
    throw new Error(`Real Telegram testing requires --send --confirm ${TELEGRAM_NOTIFICATION_TEST_CONFIRMATION}`);
  }
  if (!send && options.confirmation) throw new Error('--confirm is valid only with --send');
  const config = loadTelegramOperatorNotificationConfig(environment);
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const id = (options.idFactory ?? randomUUID)();
  if (!send) {
    const preview: TelegramNotificationTestReceipt = {
      id,
      kind: 'telegram_test',
      status: 'skipped',
      configured: config !== null,
      deliveryClaimed: false,
      realRequestCount: 0,
      message: 'Dry run only; no Telegram request was made.',
      revision: 0,
      createdAt,
      updatedAt: createdAt,
    };
    await options.recorder?.record(preview);
    return preview;
  }
  if (!config) {
    throw new Error('AO Telegram notifications are not configured');
  }
  const pending: TelegramNotificationTestReceipt = {
    id,
    kind: 'telegram_test',
    status: 'pending',
    configured: true,
    deliveryClaimed: true,
    realRequestCount: 0,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
  };
  await options.recorder?.record(pending);
  let sender: TelegramMessageSender;
  try {
    sender = options.senderFactory?.(config) ?? new TelegramAPI(config.botToken);
  } catch (error) {
    const attemptedAt = now().toISOString();
    const failed: TelegramNotificationTestReceipt = {
      ...pending,
      status: 'failed',
      realRequestCount: 0,
      message: redactTelegramCredentials(errorMessage(error), config).slice(0, 2_000),
      revision: 1,
      updatedAt: attemptedAt,
      attemptedAt,
    };
    await recordTerminalReceipt(failed, options.recorder, config);
    return failed;
  }
  try {
    await sender.sendMessage(config.chatId, TELEGRAM_NOTIFICATION_TEST_MESSAGE, undefined, { parseMode: null });
    const attemptedAt = now().toISOString();
    const sent: TelegramNotificationTestReceipt = {
      ...pending,
      status: 'sent',
      realRequestCount: 1,
      revision: 1,
      updatedAt: attemptedAt,
      attemptedAt,
    };
    return await recordTerminalReceipt(sent, options.recorder, config);
  } catch (error) {
    const attemptedAt = now().toISOString();
    const failed: TelegramNotificationTestReceipt = {
      ...pending,
      status: 'failed',
      realRequestCount: 1,
      message: redactTelegramCredentials(errorMessage(error), config).slice(0, 2_000),
      revision: 1,
      updatedAt: attemptedAt,
      attemptedAt,
    };
    return await recordTerminalReceipt(failed, options.recorder, config);
  }
}

export function formatOperatorTelegramMessage(event: OperatorNotificationEvent): string {
  if (event.kind === 'job_completed') {
    return bounded(`✅ Agent Operations completed a job

${event.title}

Result:
${event.result}

Reviewer: PASS — ${event.reviewerSummary}
Worker attempts: ${event.workerAttemptCount}

Open Agent Operations for details.`);
  }
  return bounded(`⚠️ Agent Operations needs you

Job:
${event.title}

Reason:
${event.reason}${event.reviewerFeedback ? `

Reviewer feedback:
${event.reviewerFeedback}` : ''}

Open Agent Operations to respond.`);
}

function bounded(value: string): string {
  const clean = value.trim();
  return clean.length <= 3_500 ? clean : `${clean.slice(0, 3_497)}…`;
}

function redactTelegramCredentials(
  value: string,
  config: TelegramOperatorNotificationConfig,
): string {
  let redacted = value.replace(/\b\d{7,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]');
  for (const secret of [config.botToken, config.chatId]) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
  return value;
}

async function recordTerminalReceipt(
  receipt: TelegramNotificationTestReceipt,
  recorder: TelegramNotificationTestRecorder | undefined,
  config: TelegramOperatorNotificationConfig,
): Promise<TelegramNotificationTestReceipt> {
  try {
    await recorder?.record(receipt);
    return receipt;
  } catch (error) {
    const persistenceMessage = redactTelegramCredentials(errorMessage(error), config);
    return {
      ...receipt,
      message: [receipt.message, `Local receipt persistence failed: ${persistenceMessage}`]
        .filter(Boolean)
        .join(' ')
        .slice(0, 2_000),
    };
  }
}
