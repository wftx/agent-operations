import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CortextOSConversationStateRepository,
  CortextOSOrchestratorConversationAdapter,
  EXPECTED_AO_ORCHESTRATOR_TOOL_CATALOG_REVISION,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('CortextOSOrchestratorConversationAdapter', () => {
  it('uses one stable CortextOS agent session and returns structured related Job IDs', async () => {
    const root = temporaryRoot();
    const state = new CortextOSConversationStateRepository(root, 'ao-orchestrator');
    let sequence = 0;
    const adapter = new CortextOSOrchestratorConversationAdapter({
      instanceId: 'default',
      ctxRoot: root,
      timeoutMs: 1_000,
      pollIntervalMs: 5,
      turnIdFactory: () => `conversation:${++sequence}`,
      requestSender: async request => {
        if (request.type === 'status') return readyInventory();
        const text = String((request.data as Record<string, unknown>).text);
        const turnId = text.match(/Turn ID: (conversation:[A-Za-z0-9-]+)/)![1]!;
        queueMicrotask(() => {
          state.recordToolResult(turnId, { ok: true, relatedJobIds: [`job:${sequence}`], data: {} });
          state.complete(turnId, `Created job ${sequence}.`, false, '2026-08-31T12:00:00.000Z');
        });
        return {
          success: true,
          data: { execution: { sessionId: 'provider-session-1', turnId: `provider-turn-${sequence}` } },
        };
      },
    });

    const first = await adapter.sendTurn({ message: 'Create the first Job.' });
    const second = await adapter.sendTurn({ message: 'Create the second Job.' });

    expect(first.sessionId).toBe('cortextos:default:ao-orchestrator');
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.turn.relatedJobIds).toEqual(['job:1']);
    expect(first.turn).toMatchObject({
      providerSessionId: 'provider-session-1',
      providerTurnId: 'provider-turn-1',
    });
    expect(second.turn.relatedJobIds).toEqual(['job:2']);
    expect((await adapter.getConversationState()).turns).toHaveLength(2);
  });

  it('fails truthfully while the dedicated runtime is offline and does not inject', async () => {
    const root = temporaryRoot();
    let injections = 0;
    const adapter = new CortextOSOrchestratorConversationAdapter({
      ctxRoot: root,
      requestSender: async request => {
        if (request.type === 'inject-agent') injections += 1;
        return { success: true, data: [] };
      },
    });
    await expect(adapter.sendTurn({ message: 'Create a Job.' })).rejects.toThrow('not registered');
    expect(injections).toBe(0);
    expect((await adapter.getConversationState()).runtimeState).toBe('offline');
  });

  it('uses the daemon structured status inventory for readiness', async () => {
    const root = temporaryRoot();
    const requests: string[] = [];
    const adapter = new CortextOSOrchestratorConversationAdapter({
      ctxRoot: root,
      requestSender: async request => {
        requests.push(String(request.type));
        return readyInventory();
      },
    });

    await expect(adapter.getConversationState()).resolves.toMatchObject({ runtimeState: 'ready' });
    expect(requests).toEqual(['status']);
  });

  it('fails closed before injection when the live runtime tool catalog is stale or absent', async () => {
    const root = temporaryRoot();
    let injections = 0;
    const adapter = new CortextOSOrchestratorConversationAdapter({
      ctxRoot: root,
      requestSender: async request => {
        if (request.type === 'inject-agent') injections += 1;
        return { success: true, data: [{ name: 'ao-orchestrator', status: 'running', pid: 24680 }] };
      },
    });

    await expect(adapter.sendTurn({ message: 'Create a Job.' })).rejects.toThrow('tool catalog is outdated');
    expect(injections).toBe(0);
    await expect(adapter.getConversationState()).resolves.toMatchObject({
      runtimeState: 'offline',
      runtimeReason: expect.stringContaining('Restart CortextOS'),
    });
  });

  it('reconciles an expired pending turn after web process restart', async () => {
    const root = temporaryRoot();
    const state = new CortextOSConversationStateRepository(root, 'ao-orchestrator');
    state.create({
      version: 1,
      id: 'conversation:stale',
      operatorMessage: 'A turn interrupted by web process shutdown.',
      relatedJobIds: [],
      clarificationRequired: false,
      status: 'pending',
      createdAt: '2026-08-31T11:55:00.000Z',
    });
    const adapter = new CortextOSOrchestratorConversationAdapter({
      ctxRoot: root,
      timeoutMs: 60_000,
      now: () => new Date('2026-08-31T12:00:00.000Z'),
      requestSender: async () => readyInventory(),
    });

    const conversation = await adapter.getConversationState();

    expect(conversation.runtimeState).toBe('ready');
    expect(conversation.turns[0]).toMatchObject({
      id: 'conversation:stale',
      status: 'failed',
      error: 'Timed out waiting for the persistent AO Orchestrator response.',
      completedAt: '2026-08-31T12:00:00.000Z',
    });
  });

  it('accepts only one structured completion for a turn', () => {
    const root = temporaryRoot();
    const state = new CortextOSConversationStateRepository(root, 'ao-orchestrator');
    state.create({
      version: 1,
      id: 'conversation:once',
      operatorMessage: 'Respond once.',
      relatedJobIds: [],
      clarificationRequired: false,
      status: 'pending',
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    state.complete('conversation:once', 'First response.', false, '2026-08-31T12:00:01.000Z');
    expect(() => state.complete(
      'conversation:once',
      'Duplicate response.',
      false,
      '2026-08-31T12:00:02.000Z',
    )).toThrow('already terminal');
  });
});

function readyInventory() {
  return {
    success: true,
    data: [{
      name: 'ao-orchestrator',
      status: 'running',
      pid: 24680,
      toolCatalogRevision: EXPECTED_AO_ORCHESTRATOR_TOOL_CATALOG_REVISION,
    }],
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ao-conversation-'));
  roots.push(root);
  return root;
}
