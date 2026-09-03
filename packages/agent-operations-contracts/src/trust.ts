import { createHash, randomUUID } from 'node:crypto';
import type { JobExecutionMode } from './work.js';

export const AUTONOMY_RISK_TIERS = ['green', 'yellow', 'red'] as const;
export type AutonomyRiskTier = (typeof AUTONOMY_RISK_TIERS)[number];

export const TRUST_PROFILE_PRESETS = ['conservative', 'daily-driver', 'custom'] as const;
export type TrustProfilePreset = (typeof TRUST_PROFILE_PRESETS)[number];

export type TrustProfileScope = 'global' | 'project' | 'job';

export interface TrustProfilePolicy {
  readonly readOnlyJobsAutoRun: boolean;
  readonly isolatedWriteJobsAutoRun: boolean;
  readonly maxGreenWorkerExecutions: number;
  readonly maxYellowWorkerExecutions: number;
  readonly maxGreenReviewerCycles: number;
  readonly maxYellowReviewerCycles: number;
  readonly validatedPreviewsAutoStart: boolean;
  readonly authenticatedPreviewsAllowed: boolean;
  readonly staleRuntimeAutoRestart: boolean;
  readonly buildsAndTestsAllowed: boolean;
  readonly assetTransformationsAllowed: boolean;
  /** This is invariant, not a configurable permission bit. */
  readonly redActionsRequireHumanApproval: true;
}

/** Durable autonomy policy. Machine paths and credentials are never part of identity. */
export interface DurableTrustProfile {
  readonly id: string;
  readonly scope: TrustProfileScope;
  readonly scopeId?: string;
  readonly name: string;
  readonly preset: TrustProfilePreset;
  readonly policy: TrustProfilePolicy;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const CONSERVATIVE_TRUST_POLICY: TrustProfilePolicy = Object.freeze({
  readOnlyJobsAutoRun: false,
  isolatedWriteJobsAutoRun: false,
  maxGreenWorkerExecutions: 2,
  maxYellowWorkerExecutions: 2,
  maxGreenReviewerCycles: 2,
  maxYellowReviewerCycles: 2,
  validatedPreviewsAutoStart: false,
  authenticatedPreviewsAllowed: false,
  staleRuntimeAutoRestart: false,
  buildsAndTestsAllowed: true,
  assetTransformationsAllowed: false,
  redActionsRequireHumanApproval: true,
});

export const DAILY_DRIVER_TRUST_POLICY: TrustProfilePolicy = Object.freeze({
  readOnlyJobsAutoRun: true,
  isolatedWriteJobsAutoRun: true,
  maxGreenWorkerExecutions: 5,
  maxYellowWorkerExecutions: 3,
  maxGreenReviewerCycles: 5,
  maxYellowReviewerCycles: 3,
  validatedPreviewsAutoStart: true,
  authenticatedPreviewsAllowed: true,
  staleRuntimeAutoRestart: true,
  buildsAndTestsAllowed: true,
  assetTransformationsAllowed: true,
  redActionsRequireHumanApproval: true,
});

export function policyForTrustPreset(preset: Exclude<TrustProfilePreset, 'custom'>): TrustProfilePolicy {
  return { ...(preset === 'daily-driver' ? DAILY_DRIVER_TRUST_POLICY : CONSERVATIVE_TRUST_POLICY) };
}

export function riskTierForExecutionMode(mode: JobExecutionMode): 'green' | 'yellow' {
  return mode === 'repository-write-isolated' ? 'yellow' : 'green';
}

export function workerMaximumForPolicy(policy: TrustProfilePolicy, mode: JobExecutionMode): number {
  return mode === 'repository-write-isolated'
    ? policy.maxYellowWorkerExecutions
    : policy.maxGreenWorkerExecutions;
}

export function reviewerMaximumForPolicy(policy: TrustProfilePolicy, mode: JobExecutionMode): number {
  return mode === 'repository-write-isolated'
    ? policy.maxYellowReviewerCycles
    : policy.maxGreenReviewerCycles;
}

/** Central autonomy gate. Red is never enabled by a Trust Profile. */
export function canAutonomouslyPerformRiskTier(
  policy: TrustProfilePolicy,
  tier: AutonomyRiskTier,
): boolean {
  if (tier === 'red') return false;
  return tier === 'green' ? policy.readOnlyJobsAutoRun : policy.isolatedWriteJobsAutoRun;
}

export function validateTrustProfile(profile: DurableTrustProfile): void {
  if (!profile.id.startsWith('trust-profile:') || !profile.name.trim()) {
    throw new Error(`Invalid Trust Profile: ${profile.id}`);
  }
  if (profile.scope === 'global' ? profile.scopeId !== undefined : !profile.scopeId?.trim()) {
    throw new Error('Trust Profile scope identity is invalid');
  }
  validateTrustPolicy(profile.policy);
}

export function validateTrustPolicy(policy: TrustProfilePolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (name.startsWith('max')) {
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 10) {
        throw new Error(`${name} must be an integer from 1 through 10`);
      }
    }
  }
  if (policy.redActionsRequireHumanApproval !== true) {
    throw new Error('Red actions must always require human approval');
  }
}

/** A Job restriction may narrow its parent policy but can never widen it. */
export function isTrustPolicyNoBroaderThan(
  candidate: TrustProfilePolicy,
  ceiling: TrustProfilePolicy,
): boolean {
  validateTrustPolicy(candidate);
  validateTrustPolicy(ceiling);
  const permissions = [
    'readOnlyJobsAutoRun',
    'isolatedWriteJobsAutoRun',
    'validatedPreviewsAutoStart',
    'authenticatedPreviewsAllowed',
    'staleRuntimeAutoRestart',
    'buildsAndTestsAllowed',
    'assetTransformationsAllowed',
  ] as const;
  if (permissions.some(name => candidate[name] && !ceiling[name])) return false;
  const maxima = [
    'maxGreenWorkerExecutions',
    'maxYellowWorkerExecutions',
    'maxGreenReviewerCycles',
    'maxYellowReviewerCycles',
  ] as const;
  return maxima.every(name => candidate[name] <= ceiling[name]);
}

export function createTrustProfileId(scope: TrustProfileScope, scopeId?: string): string {
  if (scope === 'global') return 'trust-profile:global';
  const value = scopeId?.trim();
  if (!value) throw new Error(`${scope} Trust Profile requires a scope ID`);
  const digest = createHash('sha256').update(scope).update('\0').update(value).digest('hex');
  return `trust-profile:${scope}:${digest}`;
}

export function createCustomTrustProfileId(uuid: string = randomUUID()): string {
  const value = uuid.trim();
  if (!value) throw new Error('Trust Profile UUID is required');
  return `trust-profile:custom:${value}`;
}

export const RED_ACTIONS = Object.freeze([
  'production-publish',
  'protected-branch-push-or-merge',
  'destructive-production-data-change',
  'consequential-external-message',
  'financial-commitment',
  'credential-or-security-change',
  'important-resource-deletion',
  'irreversible-production-system-change',
  'secret-access-broadening',
] as const);
