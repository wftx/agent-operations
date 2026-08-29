import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_NOTIFICATION_TEST_MESSAGE,
  TelegramOperatorNotifier,
  formatOperatorTelegramMessage,
  loadAgentOperationsTelegramEnvironmentFile,
  loadTelegramOperatorNotificationConfig,
  runTelegramNotificationTest,
  type TelegramMessageSender,
  type TelegramNotificationTestReceipt,
  type TelegramNotificationTestRecorder,
} from '../src/index.js';

const FAKE_BOT_TOKEN = ['123456789', 'fixture-token-value-never-used'].join(':');
const FAKE_CHAT_ID = ['-987', '654', '321'].join('');

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

class MemoryRecorder implements TelegramNotificationTestRecorder {
  readonly receipts: TelegramNotificationTestReceipt[] = [];

  async record(receipt: TelegramNotificationTestReceipt): Promise<void> {
    this.receipts.push(receipt);
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

  it('loads only dedicated AO keys from a restricted ignored local environment file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-telegram-env-'));
    try {
      const file = join(directory, 'telegram.env');
      writeFileSync(file, 'AO_TELEGRAM_BOT_TOKEN="local-token"\nAO_TELEGRAM_CHAT_ID=-123\n', { mode: 0o600 });
      chmodSync(file, 0o600);
      const environment: NodeJS.ProcessEnv = { AO_TELEGRAM_CHAT_ID: '-456' };
      expect(loadAgentOperationsTelegramEnvironmentFile(file, environment)).toEqual({
        loaded: true,
        configuredKeys: ['AO_TELEGRAM_BOT_TOKEN', 'AO_TELEGRAM_CHAT_ID'],
      });
      expect(environment).toMatchObject({
        AO_TELEGRAM_BOT_TOKEN: 'local-token',
        AO_TELEGRAM_CHAT_ID: '-456',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it('redacts dedicated credentials from normal delivery failures', async () => {
    const config = {
      botToken: FAKE_BOT_TOKEN,
      chatId: FAKE_CHAT_ID,
    };
    const notifier = new TelegramOperatorNotifier(config, {
      async sendMessage(): Promise<void> {
        throw new Error(`Rejected ${config.botToken} for ${config.chatId}`);
      },
    });
    const error = await notifier.notify({
      kind: 'needs_human',
      jobId: 'job:1',
      escalationId: 'escalation:1',
      title: 'Review required',
      reason: 'Choose the intended behavior.',
    }).catch(value => value as Error);
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain(config.botToken);
    expect(error.message).not.toContain(config.chatId);
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

  it('previews without a sender, delivery claim, or real request', async () => {
    const recorder = new MemoryRecorder();
    let senderCreated = false;
    const receipt = await runTelegramNotificationTest({
      environment: {},
      recorder,
      idFactory: () => 'dry-run',
      now: () => new Date('2026-08-28T20:00:00.000Z'),
      senderFactory: () => {
        senderCreated = true;
        return new FakeSender();
      },
    });
    expect(receipt).toMatchObject({
      status: 'skipped', configured: false, deliveryClaimed: false, realRequestCount: 0,
    });
    expect(senderCreated).toBe(false);
    expect(recorder.receipts).toEqual([receipt]);
  });

  it('requires the exact real-send confirmation before creating a delivery claim', async () => {
    const recorder = new MemoryRecorder();
    await expect(runTelegramNotificationTest({
      environment: { AO_TELEGRAM_BOT_TOKEN: 'test-token', AO_TELEGRAM_CHAT_ID: '123' },
      send: true,
      confirmation: 'WRONG',
      recorder,
    })).rejects.toThrow('--send --confirm TELEGRAM_TEST');
    expect(recorder.receipts).toEqual([]);
  });

  it('records one claimed and sent test delivery through a fake transport', async () => {
    const sender = new FakeSender();
    const recorder = new MemoryRecorder();
    const receipt = await runTelegramNotificationTest({
      environment: { AO_TELEGRAM_BOT_TOKEN: 'test-token', AO_TELEGRAM_CHAT_ID: '123' },
      send: true,
      confirmation: 'TELEGRAM_TEST',
      senderFactory: () => sender,
      recorder,
      idFactory: () => 'successful-test',
      now: () => new Date('2026-08-28T20:00:00.000Z'),
    });
    expect(receipt).toMatchObject({
      status: 'sent', configured: true, deliveryClaimed: true, realRequestCount: 1,
    });
    expect(sender.calls).toEqual([{
      chatId: '123', text: TELEGRAM_NOTIFICATION_TEST_MESSAGE, parseMode: null,
    }]);
    expect(recorder.receipts.map(value => value.status)).toEqual(['pending', 'sent']);
  });

  it('records a redacted failure without retrying the fake transport', async () => {
    const recorder = new MemoryRecorder();
    let calls = 0;
    const receipt = await runTelegramNotificationTest({
      environment: {
        AO_TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
        AO_TELEGRAM_CHAT_ID: FAKE_CHAT_ID,
      },
      send: true,
      confirmation: 'TELEGRAM_TEST',
      senderFactory: config => ({
        async sendMessage(): Promise<void> {
          calls += 1;
          throw new Error(`Rejected ${config.botToken} for ${config.chatId}`);
        },
      }),
      recorder,
      idFactory: () => 'failed-test',
      now: () => new Date('2026-08-28T20:00:00.000Z'),
    });
    expect(calls).toBe(1);
    expect(receipt).toMatchObject({ status: 'failed', deliveryClaimed: true, realRequestCount: 1 });
    expect(receipt.message).toContain('[REDACTED]');
    expect(receipt.message).not.toContain(FAKE_BOT_TOKEN);
    expect(receipt.message).not.toContain(FAKE_CHAT_ID);
    expect(recorder.receipts.map(value => value.status)).toEqual(['pending', 'failed']);
  });
});
