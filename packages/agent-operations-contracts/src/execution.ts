import { randomUUID } from 'node:crypto';
import type { RuntimeCapability } from './runtime.js';

export interface ExecutionInputEnvelope {
  readonly version: 1;
  readonly instruction: string;
}

export const RUNTIME_FILESYSTEM_POLICIES = [
  'none',
  'read-only',
  'workspace-write',
] as const;
export type RuntimeFilesystemPolicy = (typeof RUNTIME_FILESYSTEM_POLICIES)[number];

export const RUNTIME_NETWORK_POLICIES = ['deny', 'allow'] as const;
export type RuntimeNetworkPolicy = (typeof RUNTIME_NETWORK_POLICIES)[number];

export const RUNTIME_ENVIRONMENT_POLICIES = ['empty', 'minimal', 'inherit'] as const;
export type RuntimeEnvironmentPolicy = (typeof RUNTIME_ENVIRONMENT_POLICIES)[number];

/**
 * Provider-neutral authority requested for one immutable Execution Plan.
 * Tool availability is deliberately absent: current Codex app-server cannot
 * prove that shell and every configured integration are disabled per turn.
 */
export interface RuntimeExecutionPolicy {
  readonly version: 1;
  readonly filesystem: RuntimeFilesystemPolicy;
  readonly network: RuntimeNetworkPolicy;
  readonly environment: RuntimeEnvironmentPolicy;
}

export const RESTRICTED_TEXT_EXECUTION_POLICY: RuntimeExecutionPolicy = {
  version: 1,
  filesystem: 'read-only',
  network: 'deny',
  environment: 'empty',
};

export function createRuntimeExecutionPolicy(
  policy: Omit<RuntimeExecutionPolicy, 'version'> & { readonly version?: 1 },
): RuntimeExecutionPolicy {
  if (policy.version !== undefined && policy.version !== 1) {
    throw new Error(`Unsupported runtime execution policy version: ${policy.version}`);
  }
  if (!(RUNTIME_FILESYSTEM_POLICIES as readonly unknown[]).includes(policy.filesystem)) {
    throw new Error(`Unsupported runtime filesystem policy: ${String(policy.filesystem)}`);
  }
  if (!(RUNTIME_NETWORK_POLICIES as readonly unknown[]).includes(policy.network)) {
    throw new Error(`Unsupported runtime network policy: ${String(policy.network)}`);
  }
  if (!(RUNTIME_ENVIRONMENT_POLICIES as readonly unknown[]).includes(policy.environment)) {
    throw new Error(`Unsupported runtime environment policy: ${String(policy.environment)}`);
  }
  return {
    version: 1,
    filesystem: policy.filesystem,
    network: policy.network,
    environment: policy.environment,
  };
}

/** True when effective authority is equal to or narrower than requested authority. */
export function isRuntimeExecutionPolicyNoBroaderThan(
  effective: RuntimeExecutionPolicy,
  requested: RuntimeExecutionPolicy,
): boolean {
  const filesystemOrder: readonly RuntimeFilesystemPolicy[] = ['none', 'read-only', 'workspace-write'];
  const networkOrder: readonly RuntimeNetworkPolicy[] = ['deny', 'allow'];
  const environmentOrder: readonly RuntimeEnvironmentPolicy[] = ['empty', 'minimal', 'inherit'];
  return effective.version === requested.version
    && filesystemOrder.indexOf(effective.filesystem) <= filesystemOrder.indexOf(requested.filesystem)
    && networkOrder.indexOf(effective.network) <= networkOrder.indexOf(requested.network)
    && environmentOrder.indexOf(effective.environment) <= environmentOrder.indexOf(requested.environment);
}

export type RuntimePolicyResolution =
  | { readonly supported: true; readonly effectivePolicy: RuntimeExecutionPolicy }
  | { readonly supported: false; readonly reason: string };

/** Resolve the nearest enforceable policy without ever broadening authority. */
export function resolveRuntimeExecutionPolicy(
  requested: RuntimeExecutionPolicy,
  capabilities: readonly RuntimeCapability[],
): RuntimePolicyResolution {
  const has = (capability: RuntimeCapability): boolean => capabilities.includes(capability);
  const filesystem = requested.filesystem === 'none'
    ? (has('filesystem-none') ? 'none' : null)
    : requested.filesystem === 'read-only'
      ? (has('filesystem-read-only') ? 'read-only' : has('filesystem-none') ? 'none' : null)
      : has('filesystem-workspace-write')
        ? 'workspace-write'
        : has('filesystem-read-only')
          ? 'read-only'
          : has('filesystem-none') ? 'none' : null;
  if (!filesystem) {
    return {
      supported: false,
      reason: `Runtime cannot enforce filesystem=${requested.filesystem} without broader access.`,
    };
  }

  const network = requested.network === 'deny'
    ? (has('network-denial') ? 'deny' : null)
    : 'allow';
  if (!network) {
    return { supported: false, reason: 'Runtime cannot enforce network=deny.' };
  }

  const environment = requested.environment === 'empty'
    ? (has('environment-empty') ? 'empty' : null)
    : requested.environment === 'minimal'
      ? (has('environment-minimal') ? 'minimal' : has('environment-empty') ? 'empty' : null)
      : 'inherit';
  if (!environment) {
    return {
      supported: false,
      reason: `Runtime cannot enforce environment=${requested.environment}.`,
    };
  }

  const effectivePolicy = createRuntimeExecutionPolicy({ filesystem, network, environment });
  if (!isRuntimeExecutionPolicyNoBroaderThan(effectivePolicy, requested)) {
    return { supported: false, reason: 'Resolved runtime policy would broaden requested authority.' };
  }
  return { supported: true, effectivePolicy };
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
  /** Absent only for truthful legacy Plans created before policy schema v6. */
  readonly requestedPolicy?: RuntimeExecutionPolicy;
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
  | 'runtime-policy-supported'
  | 'runtime-policy-unspecified'
  | 'runtime-policy-unsupported'
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
  readonly requestedPolicy: RuntimeExecutionPolicy | null;
  readonly effectivePolicy: RuntimeExecutionPolicy | null;
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
