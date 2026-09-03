import type {
  AgentOperationsStateStore,
  AgentRuntimeAdapter,
  ExecutionRuntimeReadinessReport,
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

  async ensureExecutionAgentForJob(
    jobId: string,
    runtimeAgentId: string,
  ): Promise<ExecutionRuntimeReadinessReport> {
    const cleanAgentId = runtimeAgentId.trim();
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const associated = await this.store.listProjectRuntimeAgentIds(job.projectId);
    if (!associated.includes(cleanAgentId)) {
      return this.executionReadiness(
        cleanAgentId, 'blocked', 0, false, false,
        `Runtime ${cleanAgentId} is not associated with Project ${job.projectId}.`,
      );
    }
    const freshness = await this.ensureCurrentForJob(jobId);
    if (freshness.state !== 'current') {
      return this.executionReadiness(
        cleanAgentId, 'blocked', freshness.activeAcceptedWork, false, false,
        freshness.message, undefined, false, false,
      );
    }
    let agent = await this.runtime.getAgent(cleanAgentId);
    const revisionCurrent = !this.options.expectedRevision
      || agent?.loadedRevision === this.options.expectedRevision;
    if (agent?.configured && agent.enabled !== false && agent.health.state === 'running' && revisionCurrent) {
      return this.executionReadiness(
        cleanAgentId, 'ready', freshness.activeAcceptedWork, false, false,
        `Execution runtime ${cleanAgentId} is ready.`, agent.loadedRevision,
      );
    }
    const trust = await this.trustProfiles.effectiveForJob(job.id);
    if (!trust.policy.staleRuntimeAutoRestart || !this.lifecycle.ensureAgentRunning) {
      return this.executionReadiness(
        cleanAgentId, 'blocked', freshness.activeAcceptedWork, false, false,
        `Execution runtime ${cleanAgentId} requires explicit enablement or startup.`, agent?.loadedRevision,
        revisionCurrent,
      );
    }
    const activeAcceptedWork = await this.countActiveAcceptedWork();
    if (activeAcceptedWork > 0) {
      return this.executionReadiness(
        cleanAgentId, 'blocked', activeAcceptedWork, false, false,
        'Active submitting, accepted, or uncertain execution prevents Worker runtime recovery.',
        agent?.loadedRevision, revisionCurrent,
      );
    }
    const recovered = await this.lifecycle.ensureAgentRunning(cleanAgentId);
    if (recovered.status === 'failed') {
      return this.executionReadiness(
        cleanAgentId, 'failed', 0, recovered.enabled, recovered.started,
        `${recovered.message}${recovered.diagnostic ? ` ${recovered.diagnostic}` : ''}`,
        agent?.loadedRevision, revisionCurrent,
      );
    }
    agent = await this.runtime.getAgent(cleanAgentId);
    const verifiedRevision = !this.options.expectedRevision
      || agent?.loadedRevision === this.options.expectedRevision;
    const verifiedFreshness = await this.inspect();
    const ready = Boolean(agent?.configured && agent.enabled !== false
      && agent.health.state === 'running' && verifiedRevision
      && verifiedFreshness.state === 'current');
    return this.executionReadiness(
      cleanAgentId, ready ? 'ready' : 'failed', 0,
      recovered.enabled, recovered.started,
      ready
        ? `Execution runtime ${cleanAgentId} was recovered and verified.`
        : `Execution runtime ${cleanAgentId} started, but revision or tool catalog verification failed.`,
      agent?.loadedRevision, verifiedRevision, verifiedFreshness.state === 'current',
    );
  }

  private executionReadiness(
    agentId: string,
    state: ExecutionRuntimeReadinessReport['state'],
    activeAcceptedWork: number,
    automaticallyEnabled: boolean,
    automaticallyStarted: boolean,
    message: string,
    loadedRevision?: string,
    runtimeRevisionCurrent = true,
    toolCatalogCurrent = true,
  ): ExecutionRuntimeReadinessReport {
    return {
      state, agentId, activeAcceptedWork, automaticallyEnabled, automaticallyStarted,
      runtimeRevisionCurrent, toolCatalogCurrent, message,
      ...(loadedRevision ? { loadedRevision } : {}),
    };
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
