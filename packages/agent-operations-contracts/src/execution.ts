import { randomUUID } from 'node:crypto';

export interface ExecutionInputEnvelope {
  readonly version: 1;
  readonly instruction: string;
}

/** Immutable, resolved intent for exactly one durable attempt. */
export interface DurableExecutionPlan {
  readonly id: string;
  readonly attemptId: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly runtimeAgentId: string;
  readonly repositoryId?: string;
  readonly checkoutBindingId?: string;
  readonly input: ExecutionInputEnvelope;
  readonly jobRevisionAtPreparation: number;
  readonly attemptRevisionAtPreparation: number;
  readonly createdAt: string;
}

export type ExecutionPreflightStatus = 'ready' | 'warning' | 'blocked';
export type ExecutionPreflightFindingSeverity = 'pass' | 'warning' | 'blocking';

export type ExecutionPreflightFindingCode =
  | 'plan-associations-valid'
  | 'plan-association-invalid'
  | 'job-ready'
  | 'job-missing'
  | 'job-not-ready'
  | 'plan-job-revision-stale'
  | 'attempt-created'
  | 'attempt-missing'
  | 'attempt-not-created'
  | 'plan-attempt-revision-stale'
  | 'runtime-associated'
  | 'runtime-not-associated'
  | 'runtime-adapter-available'
  | 'runtime-adapter-unavailable'
  | 'runtime-missing'
  | 'runtime-provider-unknown'
  | 'runtime-not-configured'
  | 'runtime-disabled'
  | 'runtime-running'
  | 'runtime-starting'
  | 'runtime-stopped'
  | 'runtime-degraded'
  | 'runtime-unknown'
  | 'runtime-working-directory-unavailable'
  | 'runtime-checkout-match'
  | 'runtime-checkout-mismatch'
  | 'no-repository-target'
  | 'checkout-binding-valid'
  | 'checkout-missing'
  | 'checkout-wrong-installation'
  | 'checkout-repository-mismatch'
  | 'checkout-available'
  | 'checkout-unavailable'
  | 'checkout-not-git'
  | 'repository-observation-unavailable'
  | 'repository-identity-valid'
  | 'repository-identity-mismatch'
  | 'working-tree-dirty'
  | 'detached-head';

export interface ExecutionPreflightFinding {
  readonly code: ExecutionPreflightFindingCode;
  readonly severity: ExecutionPreflightFindingSeverity;
  readonly message: string;
}

export interface ExecutionPreflightResult {
  readonly planId: string;
  readonly checkedAt: string;
  readonly status: ExecutionPreflightStatus;
  readonly dispatchable: boolean;
  readonly checks: readonly ExecutionPreflightFinding[];
}

export function createExecutionPlanId(uuid: string = randomUUID()): string {
  const value = uuid.trim();
  if (!value) throw new Error('Execution Plan UUID is required');
  return `plan:${value}`;
}

export function createExecutionInputEnvelope(instruction: string): ExecutionInputEnvelope {
  const clean = instruction.trim();
  if (!clean) throw new Error('Execution instruction is required');
  return { version: 1, instruction: clean };
}
