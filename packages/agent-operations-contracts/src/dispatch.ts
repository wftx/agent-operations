import { randomUUID } from 'node:crypto';
import type {
  ExecutionInputEnvelope,
  RuntimeExecutionCapabilities,
  RuntimeExecutionContext,
  RuntimeExecutionPolicy,
} from './execution.js';

export const DISPATCH_STATUSES = [
  'prepared',
  'submitting',
  'accepted',
  'rejected',
  'uncertain',
] as const;

export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** One durable external-submission intent for one immutable Execution Plan. */
export interface DurableExecutionDispatch {
  readonly id: string;
  readonly executionPlanId: string;
  readonly attemptId: string;
  readonly jobId: string;
  readonly runtimeAgentId: string;
  readonly idempotencyKey: string;
  readonly status: DispatchStatus;
  /** Present after accepted policy-aware execution; absent for legacy history. */
  readonly effectivePolicy?: RuntimeExecutionPolicy;
  /** Present after accepted capability-aware execution; absent for legacy history. */
  readonly effectiveCapabilities?: RuntimeExecutionCapabilities;
  readonly externalReference?: string;
  readonly message?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt?: string;
  readonly acceptedAt?: string;
  readonly resolvedAt?: string;
}

export interface RuntimeDispatchRequest {
  readonly dispatchId: string;
  readonly idempotencyKey: string;
  readonly runtimeAgentId: string;
  readonly executionPlanId: string;
  readonly input: ExecutionInputEnvelope;
  readonly requestedPolicy: RuntimeExecutionPolicy;
  readonly requestedCapabilities: RuntimeExecutionCapabilities;
  /** Present only when AO resolved and revalidated a repository-bound checkout. */
  readonly executionContext?: RuntimeExecutionContext;
}

export type RuntimeDispatchResultCode =
  | 'POLICY_UNSUPPORTED'
  | 'POLICY_MISMATCH'
  | 'RUNTIME_BUSY'
  | 'SUBMISSION_UNCERTAIN'
  | 'RUNTIME_REJECTED';

export interface RuntimeDispatchResult {
  readonly status: 'accepted' | 'rejected' | 'uncertain';
  readonly code?: RuntimeDispatchResultCode;
  /** Required by AO before an accepted policy-aware result can be trusted. */
  readonly effectivePolicy?: RuntimeExecutionPolicy;
  /** Required by AO before an accepted capability-aware result can be trusted. */
  readonly effectiveCapabilities?: RuntimeExecutionCapabilities;
  readonly externalReference?: string;
  readonly message?: string;
}

/** Explicit mutation capability, deliberately separate from AgentRuntimeAdapter. */
export interface RuntimeExecutionAdapter {
  dispatch(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResult>;
}

export function createExecutionDispatchId(uuid: string = randomUUID()): string {
  const value = uuid.trim();
  if (!value) throw new Error('Execution Dispatch UUID is required');
  return `dispatch:${value}`;
}

export function createExecutionDispatchIdempotencyKey(executionPlanId: string): string {
  const value = executionPlanId.trim();
  if (!value) throw new Error('Execution Plan ID is required for dispatch idempotency');
  return `dispatch-plan:${value}`;
}

export function isTerminalDispatchStatus(status: DispatchStatus): boolean {
  return status === 'accepted' || status === 'rejected' || status === 'uncertain';
}
