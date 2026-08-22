import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_STATUSES,
  JOB_STATUSES,
  createAttemptId,
  createJobId,
  isActiveAttemptStatus,
  isTerminalAttemptStatus,
} from '../src/index.js';

describe('Agent Operations work contracts', () => {
  it('creates prefixed identities independent of job content', () => {
    expect(createJobId('1234')).toBe('job:1234');
    expect(createAttemptId('5678')).toBe('attempt:5678');
    expect(createJobId()).toMatch(/^job:[0-9a-f-]{36}$/);
  });

  it('keeps the job lifecycle smaller than the derived read status', () => {
    expect(JOB_STATUSES).toEqual(['draft', 'ready', 'completed', 'cancelled']);
    expect(JOB_STATUSES).not.toContain('in_progress' as never);
    expect(JOB_STATUSES).not.toContain('failed' as never);
  });

  it('distinguishes active and terminal attempt states', () => {
    expect(ATTEMPT_STATUSES).toEqual(['created', 'running', 'completed', 'failed', 'cancelled']);
    expect(isActiveAttemptStatus('created')).toBe(true);
    expect(isActiveAttemptStatus('running')).toBe(true);
    expect(isTerminalAttemptStatus('failed')).toBe(true);
    expect(isTerminalAttemptStatus('completed')).toBe(true);
  });
});
