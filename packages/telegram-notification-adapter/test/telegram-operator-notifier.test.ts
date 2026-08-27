import { describe, expect, it } from 'vitest';
import {
  TelegramOperatorNotifier,
  formatOperatorTelegramMessage,
  loadTelegramOperatorNotificationConfig,
  type TelegramMessageSender,
} from '../src/index.js';

class FakeSender implements TelegramMessageSender {
  readonly calls: Array<{ chatId: string | number; text: string; parseMode?: 'HTML' | null }> = [];

  async sendMessage(
    chatId: string | number,
    text: string,
    _replyMarkup?: object,
    options?: { readonly parseMode?: 'HTML' | null },
  ): Promise<void> {
    this.calls.push({ chatId, text, ...(options ? { parseMode: options.parseMode } : {}) });
  }
}

describe('TelegramOperatorNotifier', () => {
  it('requires dedicated AO credentials without exposing their values', () => {
    expect(loadTelegramOperatorNotificationConfig({})).toBeNull();
    expect(() => loadTelegramOperatorNotificationConfig({ AO_TELEGRAM_BOT_TOKEN: 'secret' }))
      .toThrow('require both AO_TELEGRAM_BOT_TOKEN and AO_TELEGRAM_CHAT_ID');
    expect(loadTelegramOperatorNotificationConfig({
      AO_TELEGRAM_BOT_TOKEN: 'secret',
      AO_TELEGRAM_CHAT_ID: '123',
    })).toEqual({ botToken: 'secret', chatId: '123' });
  });

  it('sends one concise plain-text completion notification through the injected transport', async () => {
    const sender = new FakeSender();
    const notifier = new TelegramOperatorNotifier({ botToken: 'not-used', chatId: '123' }, sender);
    expect(await notifier.notify({
      kind: 'job_completed',
      jobId: 'job:1',
      title: 'Find the policy contract',
      result: 'packages/contracts/src/execution.ts',
      reviewerSummary: 'All criteria satisfied.',
      workerAttemptCount: 1,
    })).toEqual({ status: 'sent' });
    expect(sender.calls).toEqual([expect.objectContaining({
      chatId: '123',
      parseMode: null,
      text: expect.stringContaining('Reviewer: PASS'),
    })]);
  });

  it('formats Needs Me without IDs, transcripts, or interactive controls', () => {
    const text = formatOperatorTelegramMessage({
      kind: 'needs_human',
      jobId: 'job:hidden',
      escalationId: 'escalation:hidden',
      title: 'Investigate failing payment test',
      reason: 'Reviewer cannot determine intended behavior.',
      reviewerFeedback: 'Choose the intended behavior.',
    });
    expect(text).toContain('Agent Operations needs you');
    expect(text).toContain('Choose the intended behavior.');
    expect(text).not.toContain('job:hidden');
    expect(text).not.toContain('escalation:hidden');
  });
});
