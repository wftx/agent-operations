import type {
  AgentOperationsInstallation,
  AgentOperationsStateStore,
  DurableProject,
  DurableProjectConfiguration,
  DurableRepository,
  DurableRepositoryObservation,
  DurableRuntimeObservation,
  RepositoryCheckoutBinding,
} from '../persistence.js';
import { createRepositoryCheckoutBindingId } from '../persistence.js';
import {
  isRuntimeExecutionCapabilitiesNoBroaderThan,
  isRuntimeExecutionPolicyNoBroaderThan,
} from '../execution.js';
import type { DurableJob, DurableJobAttempt, NewDurableJobAttempt } from '../work.js';
import { isActiveAttemptStatus } from '../work.js';
import type { DurableExecutionPlan } from '../execution.js';
import type { DurableExecutionDispatch } from '../dispatch.js';
import type {
  DurableAttemptOutcomeDecision,
  DurableExecutionObservation,
} from '../observation.js';

export type InMemoryStateStoreOperation =
  | 'get-installation'
  | 'apply-configuration'
  | 'read'
  | 'record-repository-observation'
  | 'record-runtime-observation'
  | 'write-job'
  | 'write-attempt'
  | 'write-execution-plan'
  | 'write-execution-dispatch'
  | 'write-execution-observation'
  | 'write-attempt-outcome'
  | 'close';

export interface InMemoryAgentOperationsStateStoreOptions {
  readonly installation?: AgentOperationsInstallation;
  readonly failOperations?: readonly InMemoryStateStoreOperation[];
}

const DEFAULT_INSTALLATION: AgentOperationsInstallation = {
  id: 'installation:test',
  createdAt: '2026-01-01T00:00:00.000Z',
  label: 'Deterministic test installation',
};

function copyProject(value: DurableProject): DurableProject {
  return { ...value };
}

function copyRepository(value: DurableRepository): DurableRepository {
  return { ...value };
}

function copyBinding(value: RepositoryCheckoutBinding): RepositoryCheckoutBinding {
  return { ...value };
}

function copyRepositoryObservation(value: DurableRepositoryObservation): DurableRepositoryObservation {
  return { ...value };
}

function copyRuntimeObservation(value: DurableRuntimeObservation): DurableRuntimeObservation {
  return { ...value };
}

function copyJob(value: DurableJob): DurableJob {
  return { ...value };
}

function copyAttempt(value: DurableJobAttempt): DurableJobAttempt {
  return { ...value };
}

function copyExecutionPlan(value: DurableExecutionPlan): DurableExecutionPlan {
  return {
    ...value,
    input: { ...value.input },
    ...(value.requestedPolicy ? { requestedPolicy: { ...value.requestedPolicy } } : {}),
    ...(value.requestedCapabilities
      ? { requestedCapabilities: { ...value.requestedCapabilities } }
      : {}),
  };
}

function copyExecutionDispatch(value: DurableExecutionDispatch): DurableExecutionDispatch {
  return {
    ...value,
    ...(value.effectivePolicy ? { effectivePolicy: { ...value.effectivePolicy } } : {}),
    ...(value.effectiveCapabilities
      ? { effectiveCapabilities: { ...value.effectiveCapabilities } }
      : {}),
  };
}

function copyExecutionObservation(value: DurableExecutionObservation): DurableExecutionObservation {
  return { ...value };
}

function copyAttemptOutcomeDecision(value: DurableAttemptOutcomeDecision): DurableAttemptOutcomeDecision {
  return { ...value };
}

function isValidDispatchTransition(from: string, to: string): boolean {
  return from === 'prepared' && to === 'submitting'
    || from === 'submitting' && (to === 'accepted' || to === 'rejected' || to === 'uncertain');
}

function validateDispatchShape(dispatch: DurableExecutionDispatch): void {
  const terminal = dispatch.status === 'accepted'
    || dispatch.status === 'rejected'
    || dispatch.status === 'uncertain';
  if (dispatch.status === 'prepared'
    && (dispatch.submittedAt || dispatch.acceptedAt || dispatch.resolvedAt)) {
    throw new Error('Prepared Dispatch cannot have submission or resolution timestamps');
  }
  if (dispatch.status === 'submitting'
    && (!dispatch.submittedAt || dispatch.acceptedAt || dispatch.resolvedAt)) {
    throw new Error('Submitting Dispatch requires only a submission timestamp');
  }
  if (terminal && (!dispatch.submittedAt || !dispatch.resolvedAt)) {
    throw new Error('Terminal Dispatch requires submission and resolution timestamps');
  }
  if ((dispatch.status === 'accepted') !== Boolean(dispatch.acceptedAt)) {
    throw new Error('Only an accepted Dispatch has an acceptance timestamp');
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} is required`);
}

function rejectDuplicates(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    requireNonEmpty(value, field);
    if (seen.has(value)) throw new Error(`Duplicate ${field}: ${value}`);
    seen.add(value);
  }
}

/** Deterministic, defensively-copying state store for AO domain tests. */
export class InMemoryAgentOperationsStateStore implements AgentOperationsStateStore {
  private readonly installation: AgentOperationsInstallation;
  private readonly failOperations: ReadonlySet<InMemoryStateStoreOperation>;
  private readonly projects = new Map<string, DurableProject>();
  private readonly repositories = new Map<string, DurableRepository>();
  private readonly bindings = new Map<string, RepositoryCheckoutBinding>();
  private readonly projectRepositories = new Map<string, Set<string>>();
  private readonly projectRuntimeAgents = new Map<string, Set<string>>();
  private readonly repositoryObservations = new Map<string, DurableRepositoryObservation[]>();
  private readonly runtimeObservations = new Map<string, DurableRuntimeObservation[]>();
  private readonly jobs = new Map<string, DurableJob>();
  private readonly attempts = new Map<string, DurableJobAttempt>();
  private readonly executionPlans = new Map<string, DurableExecutionPlan>();
  private readonly executionDispatches = new Map<string, DurableExecutionDispatch>();
  private readonly executionObservations = new Map<string, DurableExecutionObservation>();
  private readonly attemptOutcomeDecisions = new Map<string, DurableAttemptOutcomeDecision>();
  private closed = false;

  constructor(options: InMemoryAgentOperationsStateStoreOptions = {}) {
    this.installation = { ...(options.installation ?? DEFAULT_INSTALLATION) };
    this.failOperations = new Set(options.failOperations ?? []);
  }

  async getInstallation(): Promise<AgentOperationsInstallation> {
    this.assertAvailable('get-installation');
    return { ...this.installation };
  }

  async applyProjectConfiguration(configuration: DurableProjectConfiguration): Promise<void> {
    this.assertAvailable('apply-configuration');
    const { project, repositories, checkoutBindings, runtimeAgentIds } = configuration;
    requireNonEmpty(project.id, 'Project ID');
    requireNonEmpty(project.name, 'Project name');
    rejectDuplicates(repositories.map(item => item.id), 'repository ID');
    rejectDuplicates(checkoutBindings.map(item => item.id), 'checkout binding ID');
    rejectDuplicates(runtimeAgentIds, 'runtime agent ID');

    const repositoryIds = new Set(repositories.map(item => item.id));
    for (const repository of repositories) {
      requireNonEmpty(repository.id, 'Repository ID');
      if (repository.identityKind === 'remote'
        && (!repository.canonicalRemote || repository.id !== `remote:${repository.canonicalRemote}`)) {
        throw new Error(`Remote repository ${repository.id} has inconsistent canonical identity`);
      }
      if (repository.identityKind === 'local'
        && (!repository.id.startsWith('local:') || repository.canonicalRemote !== undefined)) {
        throw new Error(`Local repository ${repository.id} has inconsistent local identity`);
      }
      const existing = this.repositories.get(repository.id);
      if (existing && (existing.identityKind !== repository.identityKind
        || existing.canonicalRemote !== repository.canonicalRemote)) {
        throw new Error(`Repository identity conflict for ${repository.id}`);
      }
    }
    for (const binding of checkoutBindings) {
      if (!repositoryIds.has(binding.repositoryId)) {
        throw new Error(`Checkout ${binding.id} references unknown repository ${binding.repositoryId}`);
      }
      if (binding.installationId !== this.installation.id) {
        throw new Error(`Checkout ${binding.id} belongs to another installation`);
      }
      if (binding.id !== createRepositoryCheckoutBindingId(binding.installationId, binding.canonicalPath)) {
        throw new Error(`Checkout binding ID does not match its installation and path: ${binding.id}`);
      }
      const pathConflict = [...this.bindings.values()].find(candidate =>
        candidate.installationId === binding.installationId
        && candidate.canonicalPath === binding.canonicalPath
        && candidate.repositoryId !== binding.repositoryId);
      if (pathConflict) {
        throw new Error(`Checkout path identity conflict: ${binding.canonicalPath} is already bound to ${pathConflict.repositoryId}`);
      }
      const idConflict = this.bindings.get(binding.id);
      if (idConflict && (idConflict.repositoryId !== binding.repositoryId
        || idConflict.installationId !== binding.installationId
        || idConflict.canonicalPath !== binding.canonicalPath)) {
        throw new Error(`Checkout binding identity conflict for ${binding.id}`);
      }
    }

    const existingProject = this.projects.get(project.id);
    this.projects.set(project.id, {
      ...copyProject(project),
      createdAt: existingProject?.createdAt ?? project.createdAt,
    });
    for (const repository of repositories) {
      const existing = this.repositories.get(repository.id);
      this.repositories.set(repository.id, {
        ...copyRepository(repository),
        createdAt: existing?.createdAt ?? repository.createdAt,
      });
    }
    for (const binding of checkoutBindings) {
      const existing = this.bindings.get(binding.id);
      this.bindings.set(binding.id, {
        ...copyBinding(binding),
        firstSeenAt: existing?.firstSeenAt ?? binding.firstSeenAt,
      });
    }
    this.projectRepositories.set(project.id, new Set(repositoryIds));
    this.projectRuntimeAgents.set(project.id, new Set(runtimeAgentIds));
  }

  async getProject(id: string): Promise<DurableProject | null> {
    this.assertAvailable('read');
    const value = this.projects.get(id);
    return value ? copyProject(value) : null;
  }

  async listProjects(): Promise<readonly DurableProject[]> {
    this.assertAvailable('read');
    return [...this.projects.values()].sort((a, b) => a.id.localeCompare(b.id)).map(copyProject);
  }

  async getRepository(id: string): Promise<DurableRepository | null> {
    this.assertAvailable('read');
    const value = this.repositories.get(id);
    return value ? copyRepository(value) : null;
  }

  async listRepositories(): Promise<readonly DurableRepository[]> {
    this.assertAvailable('read');
    return [...this.repositories.values()].sort((a, b) => a.id.localeCompare(b.id)).map(copyRepository);
  }

  async listCheckoutBindings(repositoryId?: string): Promise<readonly RepositoryCheckoutBinding[]> {
    this.assertAvailable('read');
    return [...this.bindings.values()]
      .filter(binding => !repositoryId || binding.repositoryId === repositoryId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(copyBinding);
  }

  async listProjectRepositoryIds(projectId: string): Promise<readonly string[]> {
    this.assertAvailable('read');
    return [...(this.projectRepositories.get(projectId) ?? [])].sort();
  }

  async listProjectRuntimeAgentIds(projectId: string): Promise<readonly string[]> {
    this.assertAvailable('read');
    return [...(this.projectRuntimeAgents.get(projectId) ?? [])].sort();
  }

  async recordRepositoryObservation(observation: DurableRepositoryObservation): Promise<void> {
    this.assertAvailable('record-repository-observation');
    const binding = this.bindings.get(observation.checkoutBindingId);
    if (!binding || binding.repositoryId !== observation.repositoryId) {
      throw new Error(`Unknown repository checkout association: ${observation.checkoutBindingId}`);
    }
    const values = this.repositoryObservations.get(observation.checkoutBindingId) ?? [];
    values.push(copyRepositoryObservation(observation));
    this.repositoryObservations.set(observation.checkoutBindingId, values);
  }

  async getLatestRepositoryObservation(checkoutBindingId: string): Promise<DurableRepositoryObservation | null> {
    this.assertAvailable('read');
    const values = this.repositoryObservations.get(checkoutBindingId) ?? [];
    const latest = values.reduce<DurableRepositoryObservation | undefined>(
      (candidate, value) => !candidate || value.observedAt >= candidate.observedAt ? value : candidate,
      undefined,
    );
    return latest ? copyRepositoryObservation(latest) : null;
  }

  async recordRuntimeObservation(observation: DurableRuntimeObservation): Promise<void> {
    this.assertAvailable('record-runtime-observation');
    if (!this.projectRuntimeAgents.get(observation.projectId)?.has(observation.agentId)) {
      throw new Error(`Unknown project runtime association: ${observation.projectId}/${observation.agentId}`);
    }
    const key = `${observation.projectId}\0${observation.agentId}`;
    const values = this.runtimeObservations.get(key) ?? [];
    values.push(copyRuntimeObservation(observation));
    this.runtimeObservations.set(key, values);
  }

  async getLatestRuntimeObservation(projectId: string, agentId: string): Promise<DurableRuntimeObservation | null> {
    this.assertAvailable('read');
    const values = this.runtimeObservations.get(`${projectId}\0${agentId}`) ?? [];
    const latest = values.reduce<DurableRuntimeObservation | undefined>(
      (candidate, value) => !candidate || value.observedAt >= candidate.observedAt ? value : candidate,
      undefined,
    );
    return latest ? copyRuntimeObservation(latest) : null;
  }

  async createJob(job: DurableJob): Promise<void> {
    this.assertAvailable('write-job');
    requireNonEmpty(job.id, 'Job ID');
    requireNonEmpty(job.title, 'Job title');
    if (!job.id.startsWith('job:')) throw new Error(`Invalid Agent Operations job ID: ${job.id}`);
    if (job.status !== 'draft' || job.revision !== 0) throw new Error('New jobs must be draft at revision 0');
    if (!this.projects.has(job.projectId)) throw new Error(`Unknown project for job: ${job.projectId}`);
    if (job.repositoryId && !this.projectRepositories.get(job.projectId)?.has(job.repositoryId)) {
      throw new Error(`Repository ${job.repositoryId} is not associated with project ${job.projectId}`);
    }
    if (job.preferredRuntimeAgentId
      && !this.projectRuntimeAgents.get(job.projectId)?.has(job.preferredRuntimeAgentId)) {
      throw new Error(`Runtime ${job.preferredRuntimeAgentId} is not associated with project ${job.projectId}`);
    }
    if (this.jobs.has(job.id)) throw new Error(`Duplicate job ID: ${job.id}`);
    this.jobs.set(job.id, copyJob(job));
  }

  async getJob(id: string): Promise<DurableJob | null> {
    this.assertAvailable('read');
    const job = this.jobs.get(id);
    return job ? copyJob(job) : null;
  }

  async listJobs(projectId?: string): Promise<readonly DurableJob[]> {
    this.assertAvailable('read');
    return [...this.jobs.values()]
      .filter(job => !projectId || job.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(copyJob);
  }

  async saveJobTransition(job: DurableJob, expectedRevision: number): Promise<void> {
    this.assertAvailable('write-job');
    const existing = this.jobs.get(job.id);
    if (!existing) throw new Error(`Job not found: ${job.id}`);
    if (existing.revision !== expectedRevision || job.revision !== expectedRevision + 1) {
      throw new Error(`Stale job revision for ${job.id}; expected ${existing.revision}`);
    }
    if (existing.projectId !== job.projectId
      || existing.repositoryId !== job.repositoryId
      || existing.preferredRuntimeAgentId !== job.preferredRuntimeAgentId
      || existing.createdAt !== job.createdAt) {
      throw new Error(`Job transition cannot rewrite durable identity or assignment: ${job.id}`);
    }
    this.jobs.set(job.id, copyJob(job));
  }

  async createAttempt(attempt: NewDurableJobAttempt): Promise<DurableJobAttempt> {
    this.assertAvailable('write-attempt');
    if (!attempt.id.startsWith('attempt:')) throw new Error(`Invalid Agent Operations attempt ID: ${attempt.id}`);
    if (attempt.status !== 'created' || attempt.revision !== 0) {
      throw new Error('New attempts must be created at revision 0');
    }
    const job = this.jobs.get(attempt.jobId);
    if (!job) throw new Error(`Unknown job for attempt: ${attempt.jobId}`);
    if (attempt.runtimeAgentId
      && !this.projectRuntimeAgents.get(job.projectId)?.has(attempt.runtimeAgentId)) {
      throw new Error(`Runtime ${attempt.runtimeAgentId} is not associated with project ${job.projectId}`);
    }
    if (this.attempts.has(attempt.id)) throw new Error(`Duplicate attempt ID: ${attempt.id}`);
    const jobAttempts = [...this.attempts.values()].filter(candidate => candidate.jobId === attempt.jobId);
    if (jobAttempts.some(candidate => isActiveAttemptStatus(candidate.status))) {
      throw new Error(`Job ${attempt.jobId} already has an active attempt`);
    }
    const created: DurableJobAttempt = {
      ...attempt,
      sequence: Math.max(0, ...jobAttempts.map(candidate => candidate.sequence)) + 1,
    };
    this.attempts.set(created.id, copyAttempt(created));
    return copyAttempt(created);
  }

  async getAttempt(id: string): Promise<DurableJobAttempt | null> {
    this.assertAvailable('read');
    const attempt = this.attempts.get(id);
    return attempt ? copyAttempt(attempt) : null;
  }

  async listAttemptsForJob(jobId: string): Promise<readonly DurableJobAttempt[]> {
    this.assertAvailable('read');
    return [...this.attempts.values()]
      .filter(attempt => attempt.jobId === jobId)
      .sort((a, b) => a.sequence - b.sequence)
      .map(copyAttempt);
  }

  async saveAttemptTransition(attempt: DurableJobAttempt, expectedRevision: number): Promise<void> {
    this.assertAvailable('write-attempt');
    const existing = this.attempts.get(attempt.id);
    if (!existing) throw new Error(`Attempt not found: ${attempt.id}`);
    if (existing.revision !== expectedRevision || attempt.revision !== expectedRevision + 1) {
      throw new Error(`Stale attempt revision for ${attempt.id}; expected ${existing.revision}`);
    }
    if (existing.jobId !== attempt.jobId
      || existing.sequence !== attempt.sequence
      || existing.runtimeAgentId !== attempt.runtimeAgentId
      || existing.createdAt !== attempt.createdAt) {
      throw new Error(`Attempt transition cannot rewrite durable identity or assignment: ${attempt.id}`);
    }
    this.attempts.set(attempt.id, copyAttempt(attempt));
  }

  async createExecutionPlan(plan: DurableExecutionPlan): Promise<void> {
    this.assertAvailable('write-execution-plan');
    requireNonEmpty(plan.id, 'Execution Plan ID');
    requireNonEmpty(plan.input.instruction, 'Execution instruction');
    if (!plan.id.startsWith('plan:')) throw new Error(`Invalid Execution Plan ID: ${plan.id}`);
    if (plan.input.version !== 1) throw new Error(`Unsupported execution input version: ${plan.input.version}`);
    if (!plan.requestedPolicy) throw new Error('New Execution Plans require an explicit runtime execution policy');
    if (!plan.requestedCapabilities) throw new Error('New Execution Plans require explicit runtime tool capabilities');
    if (plan.jobRevisionAtPreparation < 0 || plan.attemptRevisionAtPreparation < 0) {
      throw new Error('Execution Plan revisions must be non-negative');
    }
    const installation = this.installation;
    if (plan.installationId !== installation.id) {
      throw new Error(`Execution Plan belongs to another installation: ${plan.installationId}`);
    }
    const job = this.jobs.get(plan.jobId);
    if (!job || job.projectId !== plan.projectId) {
      throw new Error(`Invalid Execution Plan job/project association: ${plan.jobId}`);
    }
    const attempt = this.attempts.get(plan.attemptId);
    if (!attempt || attempt.jobId !== job.id) {
      throw new Error(`Invalid Execution Plan attempt/job association: ${plan.attemptId}`);
    }
    if (attempt.runtimeAgentId !== plan.runtimeAgentId) {
      throw new Error(`Execution Plan runtime does not match Attempt: ${plan.attemptId}`);
    }
    if (job.revision !== plan.jobRevisionAtPreparation
      || attempt.revision !== plan.attemptRevisionAtPreparation) {
      throw new Error('Execution Plan preparation revisions do not match current durable state');
    }
    if (job.repositoryId !== plan.repositoryId) {
      throw new Error(`Execution Plan repository does not match Job: ${plan.jobId}`);
    }
    if ((plan.repositoryId === undefined) !== (plan.checkoutBindingId === undefined)) {
      throw new Error('Execution Plan repository and checkout must both be present or both be absent');
    }
    if (plan.checkoutBindingId) {
      const binding = this.bindings.get(plan.checkoutBindingId);
      if (!binding
        || binding.repositoryId !== plan.repositoryId
        || binding.installationId !== plan.installationId) {
        throw new Error(`Invalid Execution Plan checkout association: ${plan.checkoutBindingId}`);
      }
    }
    if (this.executionPlans.has(plan.id)) throw new Error(`Duplicate Execution Plan ID: ${plan.id}`);
    if ([...this.executionPlans.values()].some(candidate => candidate.attemptId === plan.attemptId)) {
      throw new Error(`Attempt already has an Execution Plan: ${plan.attemptId}`);
    }
    this.executionPlans.set(plan.id, copyExecutionPlan(plan));
  }

  async getExecutionPlan(id: string): Promise<DurableExecutionPlan | null> {
    this.assertAvailable('read');
    const plan = this.executionPlans.get(id);
    return plan ? copyExecutionPlan(plan) : null;
  }

  async getExecutionPlanForAttempt(attemptId: string): Promise<DurableExecutionPlan | null> {
    this.assertAvailable('read');
    const plan = [...this.executionPlans.values()].find(candidate => candidate.attemptId === attemptId);
    return plan ? copyExecutionPlan(plan) : null;
  }

  async createExecutionDispatch(dispatch: DurableExecutionDispatch): Promise<void> {
    this.assertAvailable('write-execution-dispatch');
    requireNonEmpty(dispatch.id, 'Execution Dispatch ID');
    requireNonEmpty(dispatch.idempotencyKey, 'Execution Dispatch idempotency key');
    if (!dispatch.id.startsWith('dispatch:')) throw new Error(`Invalid Execution Dispatch ID: ${dispatch.id}`);
    if (dispatch.status !== 'prepared' || dispatch.revision !== 0) {
      throw new Error('New Execution Dispatches must be prepared at revision 0');
    }
    validateDispatchShape(dispatch);
    const plan = this.executionPlans.get(dispatch.executionPlanId);
    if (!plan
      || plan.attemptId !== dispatch.attemptId
      || plan.jobId !== dispatch.jobId
      || plan.runtimeAgentId !== dispatch.runtimeAgentId) {
      throw new Error(`Invalid Execution Dispatch Plan associations: ${dispatch.id}`);
    }
    if (this.executionDispatches.has(dispatch.id)) {
      throw new Error(`Duplicate Execution Dispatch ID: ${dispatch.id}`);
    }
    if ([...this.executionDispatches.values()].some(candidate =>
      candidate.executionPlanId === dispatch.executionPlanId)) {
      throw new Error(`Execution Plan already has a Dispatch: ${dispatch.executionPlanId}`);
    }
    if ([...this.executionDispatches.values()].some(candidate =>
      candidate.idempotencyKey === dispatch.idempotencyKey)) {
      throw new Error(`Duplicate Execution Dispatch idempotency key: ${dispatch.idempotencyKey}`);
    }
    this.executionDispatches.set(dispatch.id, copyExecutionDispatch(dispatch));
  }

  async getExecutionDispatch(id: string): Promise<DurableExecutionDispatch | null> {
    this.assertAvailable('read');
    const dispatch = this.executionDispatches.get(id);
    return dispatch ? copyExecutionDispatch(dispatch) : null;
  }

  async getExecutionDispatchForPlan(executionPlanId: string): Promise<DurableExecutionDispatch | null> {
    this.assertAvailable('read');
    const dispatch = [...this.executionDispatches.values()]
      .find(candidate => candidate.executionPlanId === executionPlanId);
    return dispatch ? copyExecutionDispatch(dispatch) : null;
  }

  async saveExecutionDispatchTransition(
    dispatch: DurableExecutionDispatch,
    expectedRevision: number,
  ): Promise<void> {
    this.assertAvailable('write-execution-dispatch');
    const existing = this.executionDispatches.get(dispatch.id);
    if (!existing) throw new Error(`Execution Dispatch not found: ${dispatch.id}`);
    if (existing.revision !== expectedRevision || dispatch.revision !== expectedRevision + 1) {
      throw new Error(`Stale Execution Dispatch revision for ${dispatch.id}`);
    }
    if (existing.executionPlanId !== dispatch.executionPlanId
      || existing.attemptId !== dispatch.attemptId
      || existing.jobId !== dispatch.jobId
      || existing.runtimeAgentId !== dispatch.runtimeAgentId
      || existing.idempotencyKey !== dispatch.idempotencyKey
      || existing.createdAt !== dispatch.createdAt) {
      throw new Error(`Execution Dispatch transition cannot rewrite durable identity: ${dispatch.id}`);
    }
    if (!isValidDispatchTransition(existing.status, dispatch.status)) {
      throw new Error(`Execution Dispatch cannot transition from ${existing.status} to ${dispatch.status}`);
    }
    if (dispatch.status !== 'accepted' && (dispatch.effectivePolicy || dispatch.effectiveCapabilities)) {
      throw new Error(`Only an accepted Execution Dispatch may record effective policy and capabilities: ${dispatch.id}`);
    }
    if (dispatch.status === 'accepted') {
      const requestedPolicy = this.executionPlans.get(dispatch.executionPlanId)?.requestedPolicy;
      if (requestedPolicy && (!dispatch.effectivePolicy
        || !isRuntimeExecutionPolicyNoBroaderThan(dispatch.effectivePolicy, requestedPolicy))) {
        throw new Error(`Accepted Execution Dispatch must record a non-broader effective policy: ${dispatch.id}`);
      }
      if (!requestedPolicy && dispatch.effectivePolicy) {
        throw new Error(`Legacy Execution Dispatch cannot invent effective policy: ${dispatch.id}`);
      }
      const requestedCapabilities = this.executionPlans.get(dispatch.executionPlanId)?.requestedCapabilities;
      if (requestedCapabilities && (!dispatch.effectiveCapabilities
        || !isRuntimeExecutionCapabilitiesNoBroaderThan(
          dispatch.effectiveCapabilities,
          requestedCapabilities,
        ))) {
        throw new Error(`Accepted Execution Dispatch must record non-broader effective capabilities: ${dispatch.id}`);
      }
      if (!requestedCapabilities && dispatch.effectiveCapabilities) {
        throw new Error(`Legacy Execution Dispatch cannot invent effective capabilities: ${dispatch.id}`);
      }
    }
    validateDispatchShape(dispatch);
    this.executionDispatches.set(dispatch.id, copyExecutionDispatch(dispatch));
  }

  async appendExecutionObservation(observation: DurableExecutionObservation): Promise<boolean> {
    this.assertAvailable('write-execution-observation');
    requireNonEmpty(observation.id, 'Execution Observation ID');
    requireNonEmpty(observation.source, 'Execution Observation source');
    requireNonEmpty(observation.sourceEventId, 'Execution Observation source event ID');
    const dispatch = this.executionDispatches.get(observation.dispatchId);
    if (!dispatch || dispatch.status !== 'accepted' || dispatch.attemptId !== observation.attemptId) {
      throw new Error(`Invalid Execution Observation Dispatch association: ${observation.id}`);
    }
    if (observation.correlation === 'exact'
      && observation.correlatedDispatchId !== observation.dispatchId) {
      throw new Error(`Exact Execution Observation must identify its Dispatch: ${observation.id}`);
    }
    if (observation.correlation !== 'exact' && observation.correlatedDispatchId !== undefined) {
      throw new Error(`Non-exact Execution Observation cannot identify a Dispatch: ${observation.id}`);
    }
    const duplicate = this.executionObservations.get(observation.id)
      ?? [...this.executionObservations.values()].find(candidate =>
        candidate.dispatchId === observation.dispatchId
        && candidate.source === observation.source
        && candidate.sourceEventId === observation.sourceEventId);
    if (duplicate) return false;
    this.executionObservations.set(observation.id, copyExecutionObservation(observation));
    return true;
  }

  async listExecutionObservationsForDispatch(
    dispatchId: string,
  ): Promise<readonly DurableExecutionObservation[]> {
    this.assertAvailable('read');
    return [...this.executionObservations.values()]
      .filter(observation => observation.dispatchId === dispatchId)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id))
      .map(copyExecutionObservation);
  }

  async createAttemptOutcomeDecision(decision: DurableAttemptOutcomeDecision): Promise<void> {
    this.assertAvailable('write-attempt-outcome');
    requireNonEmpty(decision.id, 'Attempt Outcome Decision ID');
    const dispatch = this.executionDispatches.get(decision.dispatchId);
    const attempt = this.attempts.get(decision.attemptId);
    if (!dispatch || dispatch.status !== 'accepted' || dispatch.attemptId !== decision.attemptId || !attempt) {
      throw new Error(`Invalid Attempt Outcome Decision associations: ${decision.id}`);
    }
    if (decision.outcome === 'completed' && !decision.summary?.trim()) {
      throw new Error('Completed Attempt Outcome Decision requires a summary');
    }
    if (decision.outcome === 'failed' && !decision.reason?.trim()) {
      throw new Error('Failed Attempt Outcome Decision requires a reason');
    }
    if (decision.evidenceObservationId) {
      const evidence = this.executionObservations.get(decision.evidenceObservationId);
      if (!evidence || evidence.dispatchId !== decision.dispatchId || evidence.attemptId !== decision.attemptId) {
        throw new Error(`Invalid outcome evidence Observation: ${decision.evidenceObservationId}`);
      }
    }
    if (this.attemptOutcomeDecisions.has(decision.attemptId)) {
      throw new Error(`Attempt already has an Outcome Decision: ${decision.attemptId}`);
    }
    if ([...this.attemptOutcomeDecisions.values()].some(candidate => candidate.id === decision.id)) {
      throw new Error(`Duplicate Attempt Outcome Decision ID: ${decision.id}`);
    }
    this.attemptOutcomeDecisions.set(decision.attemptId, copyAttemptOutcomeDecision(decision));
  }

  async getAttemptOutcomeDecision(attemptId: string): Promise<DurableAttemptOutcomeDecision | null> {
    this.assertAvailable('read');
    const decision = this.attemptOutcomeDecisions.get(attemptId);
    return decision ? copyAttemptOutcomeDecision(decision) : null;
  }

  async close(): Promise<void> {
    this.assertAvailable('close');
    this.closed = true;
  }

  private assertAvailable(operation: InMemoryStateStoreOperation): void {
    if (this.closed) throw new Error('Agent Operations state store is closed');
    if (this.failOperations.has(operation)) throw new Error(`Simulated persistence failure: ${operation}`);
  }
}
