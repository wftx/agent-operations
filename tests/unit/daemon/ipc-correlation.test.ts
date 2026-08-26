import { describe, expect, it, vi } from 'vitest';
import type { IPCRequest } from '../../../src/types/index.js';
import { IPCServer } from '../../../src/daemon/ipc-server.js';
import { CortextOSExecutionAdapter } from '../../../packages/cortextos-execution-adapter/src/index.js';

const POLICY = { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const };

function socketCapture() {
  let body = '';
  return {
    socket: {
      write: vi.fn((value: string) => { body += value; }),
      end: vi.fn(),
    },
    response: () => JSON.parse(body) as Record<string, unknown>,
  };
}

function manager(overrides: Record<string, unknown> = {}) {
  return {
    injectAgentCorrelatedDetailed: vi.fn().mockResolvedValue({
      ok: true,
      provider: 'codex',
      sessionId: 'thread-1',
      turnId: 'turn-1',
      effectivePolicy: POLICY,
    }),
    injectAgentDetailed: vi.fn().mockReturnValue({ ok: true }),
    ...overrides,
  };
}

async function request(server: IPCServer, value: IPCRequest) {
  const captured = socketCapture();
  await (server as unknown as {
    handleRequest(request: IPCRequest, socket: unknown): Promise<void>;
  }).handleRequest(value, captured.socket);
  expect(captured.socket.end).toHaveBeenCalledOnce();
  return captured.response();
}

describe('inject-agent correlation-safe IPC mode', () => {
  it('round-trips the real AO adapter through an isolated daemon socket', async () => {
    const fake = manager();
    const server = new IPCServer(fake as never, process.env.CTX_INSTANCE_ID);
    await server.start();
    try {
      const adapter = new CortextOSExecutionAdapter();
      await expect(adapter.dispatch({
        dispatchId: 'dispatch:socket-roundtrip',
        idempotencyKey: 'dispatch-plan:socket-roundtrip',
        runtimeAgentId: 'rehearsal/coder',
        executionPlanId: 'plan:socket-roundtrip',
        input: { version: 1, instruction: 'One isolated fixture instruction.' },
        requestedPolicy: POLICY,
      })).resolves.toMatchObject({
        status: 'accepted',
        externalReference: 'cortextos:codex-turn:v1:thread-1:turn-1',
      });
      expect(fake.injectAgentCorrelatedDetailed).toHaveBeenCalledWith(
        'coder',
        'One isolated fixture instruction.',
        'dispatch-plan:socket-roundtrip',
        POLICY,
      );
    } finally {
      server.stop();
    }
  });

  it('returns a structured provider turn identity without waiting for completion', async () => {
    const fake = manager();
    const server = new IPCServer(fake as never, process.env.CTX_INSTANCE_ID);
    await expect(request(server, {
      type: 'inject-agent',
      agent: 'coder',
      data: {
        text: 'One bounded action.',
        requireNewTurn: true,
        correlationId: 'dispatch-plan:plan-1',
        executionPolicy: POLICY,
      },
      source: 'test fixture',
    })).resolves.toEqual({
      success: true,
      data: {
        message: 'Started a new correlated turn for agent coder',
        execution: {
          provider: 'codex',
          sessionId: 'thread-1',
          turnId: 'turn-1',
          effectivePolicy: POLICY,
        },
      },
    });
    expect(fake.injectAgentCorrelatedDetailed).toHaveBeenCalledWith(
      'coder',
      'One bounded action.',
      'dispatch-plan:plan-1',
      POLICY,
    );
    expect(fake.injectAgentDetailed).not.toHaveBeenCalled();
  });

  it.each([
    'RUNTIME_BUSY',
    'POLICY_UNSUPPORTED',
    'POLICY_MISMATCH',
    'MARKER_WRITE_FAILED',
    'SUBMISSION_UNCERTAIN',
  ])(
    'preserves the structured %s failure boundary',
    async code => {
      const fake = manager({
        injectAgentCorrelatedDetailed: vi.fn().mockResolvedValue({
          ok: false,
          code,
          message: `fixture ${code}`,
        }),
      });
      const server = new IPCServer(fake as never, process.env.CTX_INSTANCE_ID);
      await expect(request(server, {
        type: 'inject-agent',
        agent: 'coder',
        data: {
          text: 'One bounded action.',
          requireNewTurn: true,
          correlationId: 'dispatch-plan:plan-2',
        },
      })).resolves.toEqual({ success: false, error: `fixture ${code}`, code });
    },
  );

  it('validates correlation input before any injection', async () => {
    const fake = manager();
    const server = new IPCServer(fake as never, process.env.CTX_INSTANCE_ID);
    await expect(request(server, {
      type: 'inject-agent',
      agent: 'coder',
      data: { text: 'One bounded action.', requireNewTurn: true, correlationId: '' },
    })).resolves.toMatchObject({ success: false, code: 'INVALID_INPUT' });
    expect(fake.injectAgentCorrelatedDetailed).not.toHaveBeenCalled();
    expect(fake.injectAgentDetailed).not.toHaveBeenCalled();
  });

  it('rejects a malformed policy envelope before injection', async () => {
    const fake = manager();
    const server = new IPCServer(fake as never, process.env.CTX_INSTANCE_ID);
    await expect(request(server, {
      type: 'inject-agent',
      agent: 'coder',
      data: {
        text: 'One bounded action.',
        requireNewTurn: true,
        correlationId: 'dispatch-plan:invalid-policy',
        executionPolicy: { version: 1, filesystem: 'danger-full-access' },
      },
    })).resolves.toMatchObject({ success: false, code: 'INVALID_INPUT' });
    expect(fake.injectAgentCorrelatedDetailed).not.toHaveBeenCalled();
  });

  it('keeps legacy inject-agent behavior unchanged when opt-in fields are absent', async () => {
    const fake = manager();
    const server = new IPCServer(fake as never, process.env.CTX_INSTANCE_ID);
    await expect(request(server, {
      type: 'inject-agent',
      agent: 'coder',
      data: { text: 'Legacy message.' },
    })).resolves.toEqual({ success: true, data: 'Injected into agent coder' });
    expect(fake.injectAgentDetailed).toHaveBeenCalledWith('coder', 'Legacy message.');
    expect(fake.injectAgentCorrelatedDetailed).not.toHaveBeenCalled();
  });
});
