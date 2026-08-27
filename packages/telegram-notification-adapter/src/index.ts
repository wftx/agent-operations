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
    await this.sender.sendMessage(
      this.config.chatId,
      formatOperatorTelegramMessage(event),
      undefined,
      { parseMode: null },
    );
    return { status: 'sent' };
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
