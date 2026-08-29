import type {
  AgentOperationsStateStore,
  DurableExecutionPlan,
  DurableJob,
  DurableJobAttempt,
  DurableProject,
  DurableRepository,
  RepositoryCheckoutBinding,
  RuntimeExecutionCapabilities,
  RuntimeExecutionPolicy,
} from '../../agent-operations-contracts/src/index.js';
import {
  NO_RUNTIME_EXECUTION_CAPABILITIES,
  createExecutionInputEnvelope,
  createExecutionPlanId,
  createRuntimeExecutionCapabilities,
  createRuntimeExecutionPolicy,
} from '../../agent-operations-contracts/src/index.js';

export interface PrepareExecutionPlanInput {
  readonly projectId: string;
  readonly attemptId: string;
  readonly instruction: string;
  readonly requestedPolicy: RuntimeExecutionPolicy;
  readonly requestedCapabilities?: RuntimeExecutionCapabilities;
  readonly checkoutBindingId?: string;
  readonly repositoryWorkspaceId?: string;
}

export interface ExecutionPlanDetail {
  readonly plan: DurableExecutionPlan;
  readonly job: DurableJob;
  readonly attempt: DurableJobAttempt;
  readonly project: DurableProject;
  readonly repository: DurableRepository | null;
  readonly checkoutBinding: RepositoryCheckoutBinding | null;
}

export interface ExecutionPlanningServiceOptions {
  readonly now?: () => Date;
  readonly planIdFactory?: () => string;
}

/** Resolves durable AO identities into immutable intent. It has no execution capability. */
export class ExecutionPlanningService {
  private readonly now: () => Date;
  private readonly planIdFactory: () => string;

  constructor(
    private readonly store: AgentOperationsStateStore,
    options: ExecutionPlanningServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.planIdFactory = options.planIdFactory ?? (() => createExecutionPlanId());
  }

  async prepareExecutionPlan(input: PrepareExecutionPlanInput): Promise<DurableExecutionPlan> {
    const projectId = required(input.projectId, 'Project ID');
    const attemptId = required(input.attemptId, 'Attempt ID');
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const attempt = await this.store.getAttempt(attemptId);
    if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
    const job = await this.store.getJob(attempt.jobId);
    if (!job) throw new Error(`Job not found for Attempt ${attempt.id}: ${attempt.jobId}`);
    if (job.projectId !== projectId) {
      throw new Error(`Job ${job.id} does not belong to expected project ${projectId}`);
    }
    if (job.status !== 'ready') throw new Error(`Job ${job.id} must be ready to prepare an Execution Plan`);
    if (attempt.status !== 'created') {
      throw new Error(`Attempt ${attempt.id} must be created to prepare an Execution Plan`);
    }
    const activeAttempts = (await this.store.listAttemptsForJob(job.id))
      .filter(candidate => candidate.executionRole === attempt.executionRole
        && (candidate.status === 'created' || candidate.status === 'running'));
    if (activeAttempts.length !== 1 || activeAttempts[0].id !== attempt.id) {
      throw new Error(`Attempt ${attempt.id} must be the Job's only active ${attempt.executionRole} Attempt`);
    }
    if (!attempt.runtimeAgentId) {
      throw new Error(`Attempt ${attempt.id} requires an actual runtime assignment`);
    }
    if (await this.store.getExecutionPlanForAttempt(attempt.id)) {
      throw new Error(`Attempt already has an Execution Plan: ${attempt.id}`);
    }
    const runtimeIds = await this.store.listProjectRuntimeAgentIds(projectId);
    if (!runtimeIds.includes(attempt.runtimeAgentId)) {
      throw new Error(`Runtime ${attempt.runtimeAgentId} is not associated with project ${projectId}`);
    }

    const installation = await this.store.getInstallation();
    const checkout = await this.resolveCheckout(
      job,
      installation.id,
      input.checkoutBindingId,
    );
    const requestedPolicy = copyPolicy(input.requestedPolicy);
    const requestedCapabilities = copyCapabilities(
      input.requestedCapabilities ?? NO_RUNTIME_EXECUTION_CAPABILITIES,
    );
    if (requestedCapabilities.repositoryRead && !job.repositoryId) {
      throw new Error('Repository-read capability requires a repository-bound Job');
    }
    const workspace = input.repositoryWorkspaceId
      ? await this.store.getRepositoryWorkspace(input.repositoryWorkspaceId)
      : null;
    if (input.repositoryWorkspaceId && (!workspace || workspace.jobId !== job.id
      || workspace.repositoryId !== job.repositoryId
      || workspace.sourceCheckoutBindingId !== checkout?.id
      || !['active', 'reviewing', 'ready_for_approval'].includes(workspace.state))) {
      throw new Error(`Repository Workspace is not active for Job ${job.id}`);
    }
    if ((requestedCapabilities.repositoryPatch || requestedCapabilities.testRun
      || requestedCapabilities.gitInspect) && !workspace) {
      throw new Error('Write and Git tool capabilities require an isolated Repository Workspace');
    }
    if (requestedCapabilities.repositoryPatch && requestedPolicy.filesystem !== 'workspace-write') {
      throw new Error('Repository patch capability requires filesystem=workspace-write');
    }
    const plan: DurableExecutionPlan = {
      id: this.planIdFactory(),
      attemptId: attempt.id,
      jobId: job.id,
      projectId,
      installationId: installation.id,
      runtimeAgentId: attempt.runtimeAgentId,
      ...(job.repositoryId ? { repositoryId: job.repositoryId } : {}),
      ...(checkout ? { checkoutBindingId: checkout.id } : {}),
      ...(workspace ? { repositoryWorkspaceId: workspace.id } : {}),
      input: createExecutionInputEnvelope(input.instruction),
      requestedPolicy,
      requestedCapabilities,
      jobRevisionAtPreparation: job.revision,
      attemptRevisionAtPreparation: attempt.revision,
      createdAt: this.now().toISOString(),
    };
    await this.store.createExecutionPlan(plan);
    return plan;
  }

  async getExecutionPlanDetail(planId: string): Promise<ExecutionPlanDetail> {
    const plan = await this.store.getExecutionPlan(required(planId, 'Execution Plan ID'));
    if (!plan) throw new Error(`Execution Plan not found: ${planId}`);
    const [job, attempt, project, repository, bindings] = await Promise.all([
      this.store.getJob(plan.jobId),
      this.store.getAttempt(plan.attemptId),
      this.store.getProject(plan.projectId),
      plan.repositoryId ? this.store.getRepository(plan.repositoryId) : Promise.resolve(null),
      plan.checkoutBindingId ? this.store.listCheckoutBindings() : Promise.resolve([]),
    ]);
    if (!job || !attempt || !project) {
      throw new Error(`Execution Plan ${plan.id} references missing durable state`);
    }
    const checkoutBinding = plan.checkoutBindingId
      ? bindings.find(binding => binding.id === plan.checkoutBindingId) ?? null
      : null;
    return { plan, job, attempt, project, repository, checkoutBinding };
  }

  private async resolveCheckout(
    job: DurableJob,
    installationId: string,
    requestedId?: string,
  ): Promise<RepositoryCheckoutBinding | null> {
    if (!job.repositoryId) {
      if (requestedId) throw new Error('A repository-free Job cannot select a checkout binding');
      return null;
    }
    const repository = await this.store.getRepository(job.repositoryId);
    if (!repository) throw new Error(`Repository not found for Job ${job.id}: ${job.repositoryId}`);
    const repositoryIds = await this.store.listProjectRepositoryIds(job.projectId);
    if (!repositoryIds.includes(repository.id)) {
      throw new Error(`Repository ${repository.id} is not associated with project ${job.projectId}`);
    }
    const currentBindings = (await this.store.listCheckoutBindings(repository.id))
      .filter(binding => binding.installationId === installationId);
    if (requestedId) {
      const binding = currentBindings.find(candidate => candidate.id === requestedId);
      if (!binding) {
        throw new Error(
          `Checkout ${requestedId} is not configured for repository ${repository.id} on installation ${installationId}`,
        );
      }
      return binding;
    }
    if (currentBindings.length === 0) {
      throw new Error(`Repository ${repository.id} has no checkout on installation ${installationId}`);
    }
    if (currentBindings.length > 1) {
      throw new Error(`Repository ${repository.id} has multiple checkouts; checkoutBindingId is required`);
    }
    return currentBindings[0];
  }
}

function copyPolicy(policy: RuntimeExecutionPolicy): RuntimeExecutionPolicy {
  if (!policy) throw new Error('Requested runtime execution policy is required');
  return createRuntimeExecutionPolicy(policy);
}

function copyCapabilities(capabilities: RuntimeExecutionCapabilities): RuntimeExecutionCapabilities {
  return createRuntimeExecutionCapabilities(capabilities);
}

function required(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required`);
  return clean;
}
