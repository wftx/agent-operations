import type {
  AgentOperationsStateStore,
  AgentRuntimeAdapter,
  RuntimeFreshnessReport,
  RuntimeLifecycleAdapter,
} from '../../agent-operations-contracts/src/index.js';
import type { RuntimeFreshnessApplication, TrustProfileApplication } from './types.js';

export interface RuntimeFreshnessServiceOptions {
  readonly runtimeAgentId?: string;
  readonly expectedToolCatalogRevision: string;
  readonly expectedRevision?: string;
}

/** Compares source expectations to live loaded runtime identity before new work. */
export class RuntimeFreshnessService implements RuntimeFreshnessApplication {
  private readonly runtimeAgentId: string;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly runtime: AgentRuntimeAdapter,
    private readonly lifecycle: RuntimeLifecycleAdapter,
    private readonly trustProfiles: TrustProfileApplication,
    private readonly options: RuntimeFreshnessServiceOptions,
  ) {
    this.runtimeAgentId = options.runtimeAgentId ?? 'agent-operations/ao-orchestrator';
    if (!options.expectedToolCatalogRevision.trim()) throw new Error('Expected runtime tool catalog revision is required');
  }

  async inspect(): Promise<RuntimeFreshnessReport> {
    const agent = await this.runtime.getAgent(this.runtimeAgentId);
    const activeAcceptedWork = await this.countActiveAcceptedWork();
    const revisionCurrent = !this.options.expectedRevision
      || agent?.loadedRevision === this.options.expectedRevision;
    if (agent?.health.state === 'running'
      && agent.toolCatalogRevision === this.options.expectedToolCatalogRevision
      && revisionCurrent) {
      return {
        state: 'current', expectedToolCatalogRevision: this.options.expectedToolCatalogRevision,
        loadedToolCatalogRevision: agent.toolCatalogRevision, activeAcceptedWork,
        ...(this.options.expectedRevision ? { expectedRevision: this.options.expectedRevision } : {}),
        ...(agent.loadedRevision ? { loadedRevision: agent.loadedRevision } : {}),
        message: 'Runtime current',
      };
    }
    return {
      state: activeAcceptedWork ? 'restart-pending' : 'stale-blocked',
      expectedToolCatalogRevision: this.options.expectedToolCatalogRevision,
      ...(agent?.toolCatalogRevision ? { loadedToolCatalogRevision: agent.toolCatalogRevision } : {}),
      ...(this.options.expectedRevision ? { expectedRevision: this.options.expectedRevision } : {}),
      ...(agent?.loadedRevision ? { loadedRevision: agent.loadedRevision } : {}),
      activeAcceptedWork,
      message: activeAcceptedWork
        ? 'Runtime stale, active accepted work prevents restart'
        : 'Runtime is stale or its loaded tool catalog cannot be proven',
    };
  }

  async ensureCurrentForJob(jobId: string): Promise<RuntimeFreshnessReport> {
    const current = await this.inspect();
    if (current.state === 'current' || current.state === 'restart-pending') return current;
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const trust = await this.trustProfiles.effectiveForJob(job.id);
    if (!trust.policy.staleRuntimeAutoRestart || !this.lifecycle.restart) return current;
    const restarted = await this.lifecycle.restart();
    if (restarted.status === 'failed') {
      return { ...current, state: 'stale-blocked', message: `Runtime restart failed: ${restarted.message}` };
    }
    const verified = await this.inspect();
    return verified.state === 'current'
      ? verified
      : { ...verified, state: 'stale-blocked', message: 'Runtime restarted, but the current tool catalog was not verified' };
  }

  private async countActiveAcceptedWork(): Promise<number> {
    let count = 0;
    for (const job of await this.store.listJobs()) {
      for (const attempt of await this.store.listAttemptsForJob(job.id)) {
        if (attempt.status !== 'running') continue;
        const plan = await this.store.getExecutionPlanForAttempt(attempt.id);
        const dispatch = plan ? await this.store.getExecutionDispatchForPlan(plan.id) : null;
        if (dispatch && ['submitting', 'accepted', 'uncertain'].includes(dispatch.status)) count += 1;
      }
    }
    return count;
  }
}
