import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorConversationRuntime } from '../src/index.js';
import { OrchestratorConversationApplicationService } from '../src/index.js';

describe('OrchestratorConversationApplicationService', () => {
  it('delegates to the persistent runtime port without storing a transcript', async () => {
    const runtime: OrchestratorConversationRuntime = {
      sendTurn: vi.fn(async input => ({
        agentId: 'ao-orchestrator',
        sessionId: 'cortextos:default:ao-orchestrator',
        turn: {
          id: 'conversation:1',
          operatorMessage: input.message,
          relatedJobIds: ['job:1'],
          clarificationRequired: false,
          status: 'completed' as const,
          response: 'Created Job 1.',
          createdAt: '2026-08-31T12:00:00.000Z',
        },
      })),
      getConversationState: vi.fn(async () => ({
        agentId: 'ao-orchestrator',
        sessionId: 'cortextos:default:ao-orchestrator',
        runtimeState: 'ready' as const,
        turns: [],
      })),
    };
    const service = new OrchestratorConversationApplicationService(runtime);

    const first = await service.sendTurn({ message: '  Inspect Duck Face.  ' });
    const state = await service.getConversationState();

    expect(runtime.sendTurn).toHaveBeenCalledWith({ message: 'Inspect Duck Face.' });
    expect(first.sessionId).toBe(state.sessionId);
    expect(first.turn.relatedJobIds).toEqual(['job:1']);
  });

  it('rejects empty messages before runtime delegation', async () => {
    const runtime = { sendTurn: vi.fn(), getConversationState: vi.fn() } as unknown as OrchestratorConversationRuntime;
    const service = new OrchestratorConversationApplicationService(runtime);
    await expect(service.sendTurn({ message: '   ' })).rejects.toThrow('Message is required');
    expect(runtime.sendTurn).not.toHaveBeenCalled();
  });
});
