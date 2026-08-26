import { describe, expect, it } from 'vitest';
import {
  DISPATCH_STATUSES,
  FakeRuntimeExecutionAdapter,
  createExecutionDispatchId,
  createExecutionDispatchIdempotencyKey,
  isTerminalDispatchStatus,
} from '../src/index.js';

describe('Execution Dispatch contracts', () => {
  it('creates prefixed IDs and deterministic Plan-scoped idempotency keys', () => {
    expect(createExecutionDispatchId('1234')).toBe('dispatch:1234');
    expect(createExecutionDispatchId()).toMatch(/^dispatch:[0-9a-f-]{36}$/);
    expect(createExecutionDispatchIdempotencyKey('plan:one')).toBe('dispatch-plan:plan:one');
    expect(createExecutionDispatchIdempotencyKey('plan:one'))
      .toBe(createExecutionDispatchIdempotencyKey('plan:one'));
  });

  it('keeps acceptance, rejection, and ambiguity distinct', () => {
    expect(DISPATCH_STATUSES).toEqual(['prepared', 'submitting', 'accepted', 'rejected', 'uncertain']);
    expect(isTerminalDispatchStatus('accepted')).toBe(true);
    expect(isTerminalDispatchStatus('rejected')).toBe(true);
    expect(isTerminalDispatchStatus('uncertain')).toBe(true);
    expect(isTerminalDispatchStatus('submitting')).toBe(false);
  });

  it('provides a deterministic fake with call capture and thrown-error behavior', async () => {
    const fake = new FakeRuntimeExecutionAdapter({ status: 'rejected', message: 'No capacity' });
    const request = {
      dispatchId: 'dispatch:test',
      idempotencyKey: 'dispatch-plan:plan:test',
      runtimeAgentId: 'engineering/coder',
      executionPlanId: 'plan:test',
      input: { version: 1 as const, instruction: 'Inspect.' },
      requestedPolicy: { version: 1 as const, filesystem: 'read-only' as const, network: 'deny' as const, environment: 'empty' as const },
    };
    await expect(fake.dispatch(request)).resolves.toEqual({ status: 'rejected', message: 'No capacity' });
    expect(fake.callCount).toBe(1);
    expect(fake.requests).toEqual([request]);
    fake.setError(new Error('ambiguous transport'));
    await expect(fake.dispatch(request)).rejects.toThrow('ambiguous transport');
    expect(fake.callCount).toBe(2);
  });
});
