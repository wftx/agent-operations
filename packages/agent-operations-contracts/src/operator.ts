import { randomUUID } from 'node:crypto';

export const OPERATOR_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'needs_human',
  'failed',
  'cancelled',
] as const;
export type OperatorRunStatus = (typeof OPERATOR_RUN_STATUSES)[number];

/** Durable marker proving that this Job was explicitly accepted by the Operator. */
export interface DurableOperatorRun {
  readonly id: string;
  readonly jobId: string;
  readonly status: OperatorRunStatus;
  readonly failureMessage?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

/** Bounded operator input used only by a fresh Worker Attempt. */
export interface DurableHumanGuidance {
  readonly id: string;
  readonly jobId: string;
  readonly escalationId: string;
  readonly instruction: string;
  readonly createdAt: string;
}

/** One explicit operator authorization for one additional Worker execution. */
export interface DurableWorkerBudgetExtension {
  readonly id: string;
  readonly jobId: string;
  readonly escalationId: string;
  readonly additionalWorkerExecutions: 1;
  readonly createdAt: string;
}

export const OPERATOR_NOTIFICATION_KINDS = ['job_completed', 'needs_human'] as const;
export type OperatorNotificationKind = (typeof OPERATOR_NOTIFICATION_KINDS)[number];

export const OPERATOR_NOTIFICATION_DELIVERY_STATUSES = [
  'pending',
  'sent',
  'failed',
  'skipped',
] as const;
export type OperatorNotificationDeliveryStatus =
  (typeof OPERATOR_NOTIFICATION_DELIVERY_STATUSES)[number];

/** One durable, at-most-once delivery claim for a meaningful operator transition. */
export interface DurableOperatorNotificationDelivery {
  readonly id: string;
  readonly eventKey: string;
  readonly kind: OperatorNotificationKind;
  readonly jobId: string;
  readonly escalationId?: string;
  readonly status: OperatorNotificationDeliveryStatus;
  readonly message?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attemptedAt?: string;
}

export function createOperatorRunId(uuid: string = randomUUID()): string {
  return prefixedId('operator-run', uuid, 'Operator Run');
}

export function createHumanGuidanceId(uuid: string = randomUUID()): string {
  return prefixedId('guidance', uuid, 'Human Guidance');
}

export function createWorkerBudgetExtensionId(uuid: string = randomUUID()): string {
  return prefixedId('worker-budget-extension', uuid, 'Worker Budget Extension');
}

export function createOperatorNotificationDeliveryId(uuid: string = randomUUID()): string {
  return prefixedId('notification-delivery', uuid, 'Notification Delivery');
}

export function createOperatorNotificationEventKey(
  kind: OperatorNotificationKind,
  jobId: string,
  escalationId?: string,
): string {
  const cleanJobId = jobId.trim();
  if (!cleanJobId) throw new Error('Notification Job ID is required');
  if (kind === 'needs_human') {
    const cleanEscalationId = escalationId?.trim();
    if (!cleanEscalationId) throw new Error('Needs Me notification requires an Escalation ID');
    return `${kind}:${cleanEscalationId}`;
  }
  return `${kind}:${cleanJobId}`;
}

function prefixedId(prefix: string, uuid: string, field: string): string {
  const value = uuid.trim();
  if (!value) throw new Error(`${field} UUID is required`);
  return `${prefix}:${value}`;
}
