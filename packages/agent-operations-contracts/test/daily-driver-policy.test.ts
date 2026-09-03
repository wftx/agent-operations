import { describe, expect, it } from 'vitest';
import {
  actionableEscalationText,
  classifyEscalationResolution,
} from '../src/index.js';

describe('Daily Driver Needs Me policy', () => {
  it('classifies exact observation recovery as machine resolvable', () => {
    const escalation = {
      reason: 'observation_timeout' as const,
      summary: 'The accepted turn needs late exact completion reconciliation.',
    };
    expect(classifyEscalationResolution(escalation)).toBe('machine-resolvable');
    expect(actionableEscalationText(escalation)).toContain('without resending accepted work');
  });

  it('gives a direct action for authentication and exhausted revision budgets', () => {
    expect(actionableEscalationText({
      reason: 'policy_blocked',
      summary: 'Preview authentication required',
    })).toBe('Preview authentication required. Open the Job and authenticate the exact local Preview Profile.');
    expect(actionableEscalationText({
      reason: 'review_failed_after_budget',
      summary: 'Worker execution budget is exhausted.',
    })).toContain('authorize exactly one additional Worker execution');
  });

  it('does not present continuation when policy makes a failure terminal', () => {
    const escalation = {
      reason: 'policy_blocked' as const,
      summary: 'Required evidence cannot exist under the current capability.',
    };
    expect(classifyEscalationResolution(escalation)).toBe('terminal');
    expect(actionableEscalationText(escalation)).toContain('cannot continue truthfully');
  });
});
