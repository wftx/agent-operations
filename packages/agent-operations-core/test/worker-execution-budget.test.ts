import { describe, expect, it } from 'vitest';
import { dispatchConsumesWorkerExecutionBudget } from '../src/index.js';

describe('Worker execution budget', () => {
  it.each([
    ['prepared', undefined, false],
    ['prepared', '2026-08-28T00:00:00.000Z', true],
    ['submitting', '2026-08-28T00:00:00.000Z', true],
    ['accepted', '2026-08-28T00:00:00.000Z', true],
    ['rejected', '2026-08-28T00:00:00.000Z', true],
    ['uncertain', '2026-08-28T00:00:00.000Z', true],
  ] as const)('%s with submittedAt=%s consumes=%s', (status, submittedAt, expected) => {
    expect(dispatchConsumesWorkerExecutionBudget({ status, submittedAt })).toBe(expected);
  });
});
