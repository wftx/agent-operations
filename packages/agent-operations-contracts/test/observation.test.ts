import { describe, expect, it } from 'vitest';
import {
  FakeRuntimeExecutionObservationAdapter,
  createAttemptOutcomeDecisionId,
  createExecutionObservationId,
  isExactCompletionObservation,
} from '../src/index.js';

describe('execution observation contracts', () => {
  it('creates stable source-event identities and prefixed outcome IDs', () => {
    const id = createExecutionObservationId('dispatch:one', 'fake', 'turn:one');
    expect(id).toBe(createExecutionObservationId('dispatch:one', 'fake', 'turn:one'));
    expect(id).toMatch(/^observation:[a-f0-9]{64}$/);
    expect(id).not.toBe(createExecutionObservationId('dispatch:two', 'fake', 'turn:one'));
    expect(createAttemptOutcomeDecisionId('one')).toBe('outcome:one');
  });

  it('recognizes only exact, matching turn completion as exact completion evidence', () => {
    const base = {
      kind: 'turn-completed' as const,
      correlation: 'exact' as const,
      correlatedDispatchId: 'dispatch:one',
      dispatchId: 'dispatch:one',
    };
    expect(isExactCompletionObservation(base)).toBe(true);
    expect(isExactCompletionObservation({ ...base, kind: 'runtime-idle' })).toBe(false);
    expect(isExactCompletionObservation({ ...base, correlation: 'agent-level' })).toBe(false);
    expect(isExactCompletionObservation({ ...base, correlatedDispatchId: 'dispatch:other' })).toBe(false);
  });

  it('provides a deterministic, defensively-copying fake observer', async () => {
    const fixture = {
      source: 'fake',
      sourceEventId: 'turn:one',
      kind: 'turn-completed' as const,
      correlation: 'exact' as const,
      correlatedDispatchId: 'dispatch:one',
      observedAt: '2026-08-21T20:00:00.000Z',
    };
    const fake = new FakeRuntimeExecutionObservationAdapter([fixture]);
    const request = {
      dispatchId: 'dispatch:one',
      attemptId: 'attempt:one',
      runtimeAgentId: 'engineering/coder',
      acceptedAt: '2026-08-21T19:59:00.000Z',
    };
    const result = await fake.observe(request);
    (result[0] as { source: string }).source = 'mutated';
    expect((await fake.observe(request))[0].source).toBe('fake');
    expect(fake.callCount).toBe(2);
    expect(fake.requests).toEqual([request, request]);
    fake.setError(new Error('observer unavailable'));
    await expect(fake.observe(request)).rejects.toThrow('observer unavailable');
  });
});
