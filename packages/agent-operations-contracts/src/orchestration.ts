import { randomUUID } from 'node:crypto';
import type { DurableJob, DurableJobAttempt } from './work.js';

export const ATTEMPT_REVIEW_DECISIONS = ['PASS', 'REVISION_REQUIRED', 'ESCALATE'] as const;
export type AttemptReviewDecision = (typeof ATTEMPT_REVIEW_DECISIONS)[number];

export const ESCALATION_REASONS = [
  'review_failed_after_budget',
  'reviewer_uncertain',
  'dispatch_rejected',
  'dispatch_uncertain',
  'runtime_failure',
  'exact_correlation_missing',
  'observation_timeout',
  'policy_blocked',
  'human_judgment_required',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export const EXECUTION_RESULT_MAX_CHARS = 16_384;

/** One validated semantic decision produced by a distinct Reviewer execution. */
export interface DurableAttemptReview {
  readonly id: string;
  readonly jobId: string;
  readonly workerAttemptId: string;
  readonly reviewerAttemptId: string;
  readonly reviewerRuntimeAgentId: string;
  readonly decision: AttemptReviewDecision;
  readonly summary: string;
  readonly feedback?: string;
  readonly createdAt: string;
}

/** A durable, unresolved boundary where AO requires an operator decision. */
export interface DurableEscalation {
  readonly id: string;
  readonly jobId: string;
  readonly attemptId?: string;
  readonly reviewId?: string;
  readonly reason: EscalationReason;
  readonly summary: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  /** Durable operator-facing explanation of how an ambiguity was resolved. */
  readonly resolutionSummary?: string;
}

export interface NeedsHumanItem {
  readonly escalation: DurableEscalation;
  readonly job: DurableJob;
  readonly latestAttempt: DurableJobAttempt | null;
  readonly latestReview: DurableAttemptReview | null;
  readonly resultText?: string;
}

export function createAttemptReviewId(uuid: string = randomUUID()): string {
  const value = uuid.trim();
  if (!value) throw new Error('Attempt Review UUID is required');
  return `review:${value}`;
}

export function createEscalationId(uuid: string = randomUUID()): string {
  const value = uuid.trim();
  if (!value) throw new Error('Escalation UUID is required');
  return `escalation:${value}`;
}
