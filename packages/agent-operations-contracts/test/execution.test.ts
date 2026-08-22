import { describe, expect, it } from 'vitest';
import { createExecutionInputEnvelope, createExecutionPlanId } from '../src/index.js';

describe('Execution Plan contracts', () => {
  it('creates stable prefixed identities independent of plan content', () => {
    expect(createExecutionPlanId('1234')).toBe('plan:1234');
    expect(createExecutionPlanId()).toMatch(/^plan:[0-9a-f-]{36}$/);
  });

  it('creates only a minimal versioned plain-text input envelope', () => {
    expect(createExecutionInputEnvelope('  Investigate the failing test.  ')).toEqual({
      version: 1,
      instruction: 'Investigate the failing test.',
    });
    expect(() => createExecutionInputEnvelope('   ')).toThrow('Execution instruction is required');
  });
});
