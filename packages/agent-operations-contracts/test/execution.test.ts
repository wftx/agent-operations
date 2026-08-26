import { describe, expect, it } from 'vitest';
import {
  createExecutionInputEnvelope,
  createExecutionPlanId,
  createRuntimeExecutionPolicy,
  isRuntimeExecutionPolicyNoBroaderThan,
  resolveRuntimeExecutionPolicy,
} from '../src/index.js';

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

  it('resolves exact or stricter effective policy and never broadens authority', () => {
    const requested = createRuntimeExecutionPolicy({
      filesystem: 'workspace-write',
      network: 'allow',
      environment: 'minimal',
    });
    const resolution = resolveRuntimeExecutionPolicy(requested, [
      'filesystem-read-only',
      'network-denial',
      'environment-empty',
    ]);
    expect(resolution).toEqual({
      supported: true,
      effectivePolicy: {
        version: 1,
        filesystem: 'read-only',
        network: 'allow',
        environment: 'empty',
      },
    });
    if (resolution.supported) {
      expect(isRuntimeExecutionPolicyNoBroaderThan(resolution.effectivePolicy, requested)).toBe(true);
      expect(isRuntimeExecutionPolicyNoBroaderThan(requested, resolution.effectivePolicy)).toBe(false);
    }
  });

  it('fails closed when a requested restriction is not enforceable', () => {
    expect(resolveRuntimeExecutionPolicy({
      version: 1,
      filesystem: 'none',
      network: 'deny',
      environment: 'empty',
    }, ['filesystem-read-only', 'network-denial', 'environment-empty'])).toEqual({
      supported: false,
      reason: 'Runtime cannot enforce filesystem=none without broader access.',
    });
  });
});
