import type {
  AgentOperationsStateStore,
  DurableJobRetirement,
  JobRetirementDisposition,
} from '../../agent-operations-contracts/src/index.js';
import { RepositoryWorkspaceService } from './repository-workspace-service.js';

export interface JobRetirementAssessment {
  readonly safe: boolean;
  readonly reasons: readonly string[];
}

/** Removes obsolete Jobs from active operations without deleting any history. */
export class JobRetirementService {
  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly workspaces: RepositoryWorkspaceService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async assess(jobId: string): Promise<JobRetirementAssessment> {
    const job = await this.store.getJob(jobId.trim());
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const reasons: string[] = [];
    const external = await this.store.getExternalActionPlan(job.id);
    if (external && ['executing','uncertain'].includes(external.state)) reasons.push('External action may have crossed its side effect boundary; reconcile before retirement');
    for (const attempt of await this.store.listAttemptsForJob(job.id)) {
      const plan = await this.store.getExecutionPlanForAttempt(attempt.id);
      const dispatch = plan ? await this.store.getExecutionDispatchForPlan(plan.id) : null;
      if (dispatch?.status === 'submitting' || dispatch?.status === 'uncertain'
        || (dispatch?.status === 'accepted' && (attempt.status === 'created' || attempt.status === 'running'))
        || ((attempt.status === 'created' || attempt.status === 'running') && (!dispatch || dispatch.status === 'prepared'))) {
        reasons.push(`Attempt ${attempt.id} may still cross or occupy the provider boundary`);
      }
    }
    const workspace = await this.store.getRepositoryWorkspaceForJob(job.id);
    if (workspace && ['preparing', 'active'].includes(workspace.state)) {
      reasons.push(`Repository Workspace ${workspace.id} is ${workspace.state}`);
    }
    return { safe: reasons.length === 0, reasons };
  }

  async retire(input: {
    readonly jobId: string;
    readonly disposition: JobRetirementDisposition;
    readonly reason: string;
    readonly actor: string;
    readonly evidenceReference?: string;
  }): Promise<DurableJobRetirement> {
    const jobId = input.jobId.trim();
    const existing = await this.store.getJobRetirement(jobId);
    const assessment = await this.assess(jobId);
    if (!assessment.safe) throw new Error(`Job ${jobId} cannot retire: ${assessment.reasons.join('; ')}`);
    if (existing) {
      await this.store.retireJob(existing);
      return existing;
    }
    if (input.disposition === 'externally-published' && !input.evidenceReference?.trim()) {
      throw new Error('Externally published retirement requires an evidence reference');
    }
    const workspace = await this.store.getRepositoryWorkspaceForJob(jobId);
    if (input.disposition === 'externally-published') {
      if (!workspace || workspace.state === 'cleaned'
        || !/^[0-9a-f]{40,64}$/i.test(input.evidenceReference!.trim())) {
        throw new Error('Externally published retirement requires an exact workspace commit reference');
      }
      const inspection = await this.workspaces.inspectForRetirement(workspace.id);
      if (!inspection.exists || !inspection.registered
        || inspection.repositoryId !== workspace.repositoryId
        || inspection.canonicalPath !== workspace.canonicalPath
        || inspection.branchName !== workspace.branchName
        || inspection.headRevision !== input.evidenceReference!.trim().toLowerCase()) {
        throw new Error('External publication evidence does not match the exact registered workspace HEAD');
      }
    }
    if (workspace && workspace.state !== 'cleaned') {
      const cleaned = await this.workspaces.cleanupForRetirement(workspace.id);
      if (cleaned.state !== 'cleaned') {
        throw new Error(`Repository Workspace ${workspace.id} was not safely released`);
      }
    }
    const retirement: DurableJobRetirement = {
      jobId,
      disposition: input.disposition,
      reason: required(input.reason, 'Retirement reason'),
      actor: required(input.actor, 'Retirement actor'),
      ...(input.evidenceReference?.trim()
        ? { evidenceReference: input.evidenceReference.trim() }
        : {}),
      retiredAt: this.now().toISOString(),
    };
    await this.store.retireJob(retirement);
    return retirement;
  }
}

function required(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required`);
  if (clean.length > 4_096) throw new Error(`${field} exceeds 4096 characters`);
  return clean;
}
