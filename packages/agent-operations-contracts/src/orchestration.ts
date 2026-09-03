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
export type EscalationResolutionClass = 'machine-resolvable' | 'operator-resolvable' | 'terminal';

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

/** Pure read model classification. Durable history remains unchanged. */
export function classifyEscalationResolution(
  escalation: Pick<DurableEscalation, 'reason' | 'summary'>,
): EscalationResolutionClass {
  if (escalation.reason === 'observation_timeout') return 'machine-resolvable';
  if (escalation.reason === 'runtime_failure'
    && /stale|preview process|tool catalog|ephemeral|observation failed/i.test(escalation.summary)) {
    return 'machine-resolvable';
  }
  if (escalation.reason === 'runtime_failure'
    && /^Worker Attempt \d+ ended cancelled without a resumable result\.$/.test(escalation.summary)) {
    return 'machine-resolvable';
  }
  if (escalation.reason === 'policy_blocked'
    && /runtime-disabled|runtime-stopped/i.test(escalation.summary)) {
    return 'machine-resolvable';
  }
  if (escalation.reason === 'human_judgment_required'
    || escalation.reason === 'review_failed_after_budget'
    || escalation.reason === 'reviewer_uncertain') return 'operator-resolvable';
  if (escalation.reason === 'policy_blocked'
    && /authentication|required credential|resource unavailable|missing information/i.test(escalation.summary)) {
    return 'operator-resolvable';
  }
  return 'terminal';
}

export function actionableEscalationText(
  escalation: Pick<DurableEscalation, 'reason' | 'summary'>,
): string {
  const classification = classifyEscalationResolution(escalation);
  if (classification === 'machine-resolvable') {
    return `AO can retry the local recovery step without resending accepted work. ${escalation.summary}`;
  }
  if (classification === 'operator-resolvable') {
    if (/authentication/i.test(escalation.summary)) return 'Preview authentication required. Open the Job and authenticate the exact local Preview Profile.';
    if (escalation.reason === 'review_failed_after_budget') return 'Choose whether to authorize exactly one additional Worker execution, or cancel the Job.';
    return `Your decision or guidance is required. ${escalation.summary}`;
  }
  return `AO cannot continue truthfully under the current capabilities. ${escalation.summary}`;
}
