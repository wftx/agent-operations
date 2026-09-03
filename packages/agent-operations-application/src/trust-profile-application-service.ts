import type {
  AgentOperationsStateStore,
  DurableTrustProfile,
  TrustProfilePolicy,
  TrustProfilePreset,
  TrustProfileScope,
} from '../../agent-operations-contracts/src/index.js';
import {
  CONSERVATIVE_TRUST_POLICY,
  createTrustProfileId,
  isTrustPolicyNoBroaderThan,
  policyForTrustPreset,
  validateTrustPolicy,
} from '../../agent-operations-contracts/src/index.js';
import type { EffectiveTrustProfile, SaveTrustProfileInput, TrustProfileApplication } from './types.js';

export class TrustProfileApplicationService implements TrustProfileApplication {
  private readonly now: () => Date;

  constructor(
    private readonly store: AgentOperationsStateStore,
    options: { readonly now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<readonly DurableTrustProfile[]> {
    return this.store.listTrustProfiles();
  }

  async save(input: SaveTrustProfileInput): Promise<DurableTrustProfile> {
    const scope = input.scope;
    const scopeId = scope === 'global' ? undefined : required(input.scopeId, `${scope} scope ID`);
    if (scope === 'project' && !await this.store.getProject(scopeId!)) throw new Error(`Project not found: ${scopeId}`);
    if (scope === 'job' && !await this.store.getJob(scopeId!)) throw new Error(`Job not found: ${scopeId}`);
    const profiles = await this.store.listTrustProfiles();
    const existing = profiles.find(profile => profile.scope === scope && profile.scopeId === scopeId);
    const parent = scope === 'job'
      ? await this.effectiveForProject((await this.store.getJob(scopeId!))!.projectId)
      : scope === 'project' ? await this.effectiveGlobal() : null;
    const policy = policyFromInput(input.preset, input.policy);
    if (scope === 'job' && parent && !isTrustPolicyNoBroaderThan(policy, parent.policy)) {
      throw new Error('A Job Trust Profile may restrict but cannot expand its Project policy ceiling');
    }
    const timestamp = this.now().toISOString();
    const profile: DurableTrustProfile = {
      id: existing?.id ?? createTrustProfileId(scope, scopeId), scope,
      ...(scopeId ? { scopeId } : {}),
      name: bounded(input.name ?? defaultName(scope, input.preset), 'Trust Profile name', 100),
      preset: input.preset, policy,
      revision: (existing?.revision ?? -1) + 1,
      createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
    };
    await this.store.saveTrustProfile(profile);
    return profile;
  }

  async effectiveForProject(projectId: string): Promise<EffectiveTrustProfile> {
    if (!await this.store.getProject(required(projectId, 'Project ID'))) throw new Error(`Project not found: ${projectId}`);
    const project = (await this.store.listTrustProfiles())
      .find(profile => profile.scope === 'project' && profile.scopeId === projectId);
    return project
      ? { profile: project, policy: { ...project.policy }, source: 'project' }
      : this.effectiveGlobal();
  }

  async effectiveForJob(jobId: string): Promise<EffectiveTrustProfile> {
    const job = await this.store.getJob(required(jobId, 'Job ID'));
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const jobProfile = (await this.store.listTrustProfiles())
      .find(profile => profile.scope === 'job' && profile.scopeId === jobId);
    if (!jobProfile) return this.effectiveForProject(job.projectId);
    const project = await this.effectiveForProject(job.projectId);
    if (!isTrustPolicyNoBroaderThan(jobProfile.policy, project.policy)) {
      throw new Error(`Job Trust Profile ${jobProfile.id} exceeds its current Project ceiling`);
    }
    return { profile: jobProfile, policy: { ...jobProfile.policy }, source: 'job' };
  }

  private async effectiveGlobal(): Promise<EffectiveTrustProfile> {
    const global = (await this.store.listTrustProfiles()).find(profile => profile.scope === 'global');
    return global
      ? { profile: global, policy: { ...global.policy }, source: 'global' }
      : { profile: null, policy: { ...CONSERVATIVE_TRUST_POLICY }, source: 'conservative-fallback' };
  }
}

function policyFromInput(preset: TrustProfilePreset, policy: TrustProfilePolicy | undefined): TrustProfilePolicy {
  if (preset === 'custom') {
    if (!policy) throw new Error('Custom Trust Profile requires an explicit policy');
    validateTrustPolicy(policy);
    return { ...policy, redActionsRequireHumanApproval: true };
  }
  if (policy) throw new Error(`${preset} Trust Profile uses its fixed preset policy`);
  return policyForTrustPreset(preset);
}

function defaultName(scope: TrustProfileScope, preset: TrustProfilePreset): string {
  const label = preset === 'daily-driver' ? 'Daily Driver' : preset === 'conservative' ? 'Conservative' : 'Custom';
  return `${label} ${scope} policy`;
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function bounded(value: string, field: string, maximum: number): string {
  const clean = required(value, field);
  if (clean.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return clean;
}
