import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CortextOSConversationStateRepository } from '../../../packages/cortextos-conversation-adapter/src/index.js';
import {
  routeAoTelegramConversation,
  telegramTurnId,
} from '../../../src/daemon/ao-telegram-conversation-router.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('AO Telegram conversation routing', () => {
  it('uses one exact correlated Orchestrator turn and returns its bounded response', async () => {
    const root = temporaryRoot();
    const state = new CortextOSConversationStateRepository(root, 'ao-orchestrator');
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const inject = vi.fn(async (_prompt: string, correlationId: string) => {
      queueMicrotask(() => state.complete(
        correlationId,
        'I found the Project and created one read only Job.',
        false,
        '2026-09-02T12:00:01.000Z',
      ));
      return {
        ok: true as const,
        provider: 'codex' as const,
        sessionId: 'provider-session',
        turnId: 'provider-turn',
      };
    });

    await routeAoTelegramConversation({
      agentProcess: { injectCorrelatedMessageDetailed: inject },
      telegramApi: { sendMessage },
      chatId: 1234,
      ctxRoot: root,
      agentName: 'ao-orchestrator',
      messageId: 99,
      operatorMessage: 'Check the Duck Face Project.',
      replyContext: '⚠️ AO needs you\nFrusterio Pulse\nPreview authentication required.\n/jobs/job%3Aone',
      log: vi.fn(),
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    const id = telegramTurnId(1234, 99);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith(
      expect.stringContaining('Check the Duck Face Project.'),
      id,
      undefined,
      undefined,
      { version: 1, repositoryRead: false, agentOperationsControl: true },
    );
    expect(inject.mock.calls[0]![0]).toContain('Frusterio Pulse');
    expect(inject.mock.calls[0]![0]).toContain('Ask one concise clarification');
    expect(inject.mock.calls[0]![0]).toContain('Red actions still require explicit human approval');
    expect(sendMessage).toHaveBeenCalledWith(1234, 'I found the Project and created one read only Job.');
    expect(state.get(id)).toMatchObject({
      status: 'completed',
      providerSessionId: 'provider-session',
      providerTurnId: 'provider-turn',
    });
  });

  it('suppresses a redelivered Telegram update without another turn or response', async () => {
    const root = temporaryRoot();
    const id = telegramTurnId(1234, 99);
    const state = new CortextOSConversationStateRepository(root, 'ao-orchestrator');
    state.create({
      version: 1,
      id,
      operatorMessage: 'Already handled.',
      relatedJobIds: [],
      clarificationRequired: false,
      status: 'pending',
      createdAt: '2026-09-02T12:00:00.000Z',
    });
    const inject = vi.fn();
    const sendMessage = vi.fn();

    await routeAoTelegramConversation({
      agentProcess: { injectCorrelatedMessageDetailed: inject },
      telegramApi: { sendMessage },
      chatId: 1234,
      ctxRoot: root,
      agentName: 'ao-orchestrator',
      messageId: 99,
      operatorMessage: 'Already handled.',
      log: vi.fn(),
    });

    expect(inject).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('returns one concise clarification when reply context does not identify a Job', async () => {
    const root = temporaryRoot();
    const state = new CortextOSConversationStateRepository(root, 'ao-orchestrator');
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const inject = vi.fn(async (_prompt: string, correlationId: string) => {
      queueMicrotask(() => state.complete(
        correlationId,
        'Which Project and Job should I apply that guidance to?',
        true,
        '2026-09-02T12:00:01.000Z',
      ));
      return { ok: true as const, provider: 'codex' as const, sessionId: 'session', turnId: 'turn' };
    });

    await routeAoTelegramConversation({
      agentProcess: { injectCorrelatedMessageDetailed: inject }, telegramApi: { sendMessage },
      chatId: 1234, ctxRoot: root, agentName: 'ao-orchestrator', messageId: 101,
      operatorMessage: 'Give it another attempt.', log: vi.fn(), timeoutMs: 1_000, pollIntervalMs: 1,
    });

    expect(inject).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(1234, 'Which Project and Job should I apply that guidance to?');
    expect(state.get(telegramTurnId(1234, 101))).toMatchObject({
      status: 'completed', clarificationRequired: true, relatedJobIds: [],
    });
  });

  it('fails closed and reports no exact turn when the runtime rejects the submission', async () => {
    const root = temporaryRoot();
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });

    await routeAoTelegramConversation({
      agentProcess: {
        injectCorrelatedMessageDetailed: vi.fn().mockResolvedValue({
          ok: false, code: 'RUNTIME_BUSY', message: 'runtime busy',
        }),
      },
      telegramApi: { sendMessage },
      chatId: 1234,
      ctxRoot: root,
      agentName: 'ao-orchestrator',
      messageId: 100,
      operatorMessage: 'Do one thing.',
      log: vi.fn(),
    });

    expect(new CortextOSConversationStateRepository(root, 'ao-orchestrator')
      .get(telegramTurnId(1234, 100))).toMatchObject({ status: 'failed' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ao-telegram-conversation-'));
  roots.push(root);
  return root;
}
