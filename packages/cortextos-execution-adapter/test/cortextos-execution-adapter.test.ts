import { describe, expect, it } from 'vitest';
import type { RuntimeDispatchRequest } from '../../agent-operations-contracts/src/index.js';
import {
  CortextOSExecutionAdapter,
  CortextOSExecutionTransportError,
} from '../src/index.js';

const REQUEST: RuntimeDispatchRequest = {
  dispatchId: 'dispatch:test',
  idempotencyKey: 'dispatch-plan:plan:test',
  runtimeAgentId: 'engineering/coder',
  executionPlanId: 'plan:test',
  input: { version: 1, instruction: 'Investigate the failing test.' },
  requestedPolicy: { version: 1, filesystem: 'read-only', network: 'deny', environment: 'empty' },
};

describe('CortextOSExecutionAdapter', () => {
  it('maps a structured Codex turn acknowledgement to one opaque external reference', async () => {
    const captured: unknown[] = [];
    const adapter = new CortextOSExecutionAdapter({
      requestSender: async (agentName, instruction, request) => {
        captured.push({ agentName, instruction, request });
        return {
          success: true,
          data: {
            message: 'Started a new correlated turn for agent coder',
            execution: {
              provider: 'codex',
              sessionId: 'thread-1',
              turnId: 'turn-1',
              effectivePolicy: REQUEST.requestedPolicy,
            },
          },
        };
      },
    });
    await expect(adapter.dispatch(REQUEST)).resolves.toEqual({
      status: 'accepted',
      externalReference: 'cortextos:codex-turn:v1:thread-1:turn-1',
      message: 'Started a new correlated turn for agent coder',
      effectivePolicy: REQUEST.requestedPolicy,
    });
    expect(captured).toEqual([{
      agentName: 'coder',
      instruction: 'Investigate the failing test.',
      request: REQUEST,
    }]);
  });

  it('keeps legacy acknowledged injection available only when exact correlation is disabled', async () => {
    const adapter = new CortextOSExecutionAdapter({
      requireExactTurnCorrelation: false,
      requestSender: async () => ({ success: true, data: 'Injected into agent coder' }),
    });
    await expect(adapter.dispatch(REQUEST)).resolves.toEqual({
      status: 'accepted',
      message: 'Injected into agent coder',
    });
  });

  it('treats acceptance without a valid exact turn identity as uncertain', async () => {
    const missing = new CortextOSExecutionAdapter({
      requestSender: async () => ({ success: true, data: 'legacy acknowledgement' }),
    });
    expect((await missing.dispatch(REQUEST)).status).toBe('uncertain');

    const malformed = new CortextOSExecutionAdapter({
      requestSender: async () => ({
        success: true,
        data: { execution: { provider: 'codex', sessionId: 'thread:bad', turnId: 'turn-1' } },
      }),
    });
    expect((await malformed.dispatch(REQUEST)).status).toBe('uncertain');
  });

  it.each(['NOT_FOUND', 'NOT_RUNNING', 'DEDUPED', 'INVALID_INPUT',
    'CORRELATION_UNSUPPORTED', 'RUNTIME_BUSY', 'MARKER_WRITE_FAILED'])(
    'maps explicit daemon rejection %s to rejected',
    async code => {
      const adapter = new CortextOSExecutionAdapter({
        requestSender: async () => ({ success: false, code, error: `Rejected: ${code}` }),
      });
      await expect(adapter.dispatch(REQUEST)).resolves.toEqual({
        status: 'rejected',
        ...(code === 'RUNTIME_BUSY' ? { code: 'RUNTIME_BUSY' } : {}),
        message: `Rejected: ${code}`,
      });
    },
  );

  it('preserves post-submission ambiguity reported by the daemon', async () => {
    const adapter = new CortextOSExecutionAdapter({
      requestSender: async () => ({
        success: false,
        code: 'SUBMISSION_UNCERTAIN',
        error: 'turn may have started before acknowledgement was lost',
      }),
    });
    await expect(adapter.dispatch(REQUEST)).resolves.toEqual({
      status: 'uncertain',
      code: 'SUBMISSION_UNCERTAIN',
      message: 'turn may have started before acknowledgement was lost',
    });
  });

  it('distinguishes proven pre-submission unavailability from ambiguous transport loss', async () => {
    const unavailable = new CortextOSExecutionAdapter({
      requestSender: async () => {
        throw new CortextOSExecutionTransportError('Daemon unavailable', false);
      },
    });
    await expect(unavailable.dispatch(REQUEST)).resolves.toEqual({
      status: 'rejected',
      message: 'Daemon unavailable',
    });

    const ambiguous = new CortextOSExecutionAdapter({
      requestSender: async () => {
        throw new CortextOSExecutionTransportError('Connection lost after write', true);
      },
    });
    await expect(ambiguous.dispatch(REQUEST)).resolves.toEqual({
      status: 'uncertain',
      message: 'CortextOS acknowledgement is uncertain: Connection lost after write',
    });
  });

  it('maps timeouts, arbitrary errors, and malformed acknowledgements to uncertain', async () => {
    const timeout = new CortextOSExecutionAdapter({
      requestSender: async () => {
        throw new CortextOSExecutionTransportError('Timed out', true);
      },
    });
    expect((await timeout.dispatch(REQUEST)).status).toBe('uncertain');

    const error = new CortextOSExecutionAdapter({
      requestSender: async () => { throw new Error('socket closed'); },
    });
    expect((await error.dispatch(REQUEST)).status).toBe('uncertain');

    const malformed = new CortextOSExecutionAdapter({ requestSender: async () => 'not json' });
    expect(await malformed.dispatch(REQUEST)).toEqual({
      status: 'uncertain',
      message: 'CortextOS daemon returned a malformed acknowledgement.',
    });
  });

  it('rejects an invalid AO runtime identity before any external request', async () => {
    let calls = 0;
    const adapter = new CortextOSExecutionAdapter({
      requestSender: async () => { calls++; return { success: true }; },
    });
    await expect(adapter.dispatch({ ...REQUEST, runtimeAgentId: 'invalid' }))
      .rejects.toThrow('Invalid Agent Operations runtime ID');
    expect(calls).toBe(0);
  });
});
