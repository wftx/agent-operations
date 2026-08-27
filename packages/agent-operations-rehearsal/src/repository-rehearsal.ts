import { basename, resolve } from 'node:path';
import type {
  AgentOperationsStateStore,
  AgentRuntimeDetail,
  DurableExecutionPlan,
  DurableJob,
  DurableJobAttempt,
  ExecutionPreflightResult,
  RepositoryInventoryAdapter,
  RepositorySummary,
  RuntimeExecutionCapabilities,
  RuntimeExecutionPolicy,
} from '../../agent-operations-contracts/src/index.js';
import {
  REPOSITORY_READ_EXECUTION_CAPABILITIES,
  RESTRICTED_TEXT_EXECUTION_POLICY,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import {
  ExecutionPlanningService,
  ExecutionPreflightService,
  JobLifecycleService,
} from '../../agent-operations-core/src/index.js';

export const REPOSITORY_REHEARSAL_CONFIRMATION = 'REPOSITORY_REHEARSAL';
export const REPOSITORY_REHEARSAL_PROJECT_ID = 'ao-repository-read-only-rehearsal';
export const REPOSITORY_REHEARSAL_ID = 'remote:github.com/wftx/agent-operations';
export const REPOSITORY_REHEARSAL_CHECKOUT = resolve(
  process.env['AGENT_OPERATIONS_REPOSITORY_CHECKOUT'] ?? process.cwd(),
);

export const REPOSITORY_REHEARSAL_POLICY: RuntimeExecutionPolicy = {
  ...RESTRICTED_TEXT_EXECUTION_POLICY,
};

export const REPOSITORY_REHEARSAL_CAPABILITIES: RuntimeExecutionCapabilities = {
  ...REPOSITORY_READ_EXECUTION_CAPABILITIES,
};

export interface RepositoryRehearsalPreparation {
  readonly projectId: string;
  readonly job: DurableJob;
  readonly attempt: DurableJobAttempt;
  readonly plan: DurableExecutionPlan;
  readonly repository: RepositorySummary;
  readonly preflight: ExecutionPreflightResult;
}

export interface RepositoryRehearsalOptions {
  readonly now?: () => Date;
  readonly jobIdFactory?: () => string;
  readonly attemptIdFactory?: () => string;
  readonly planIdFactory?: () => string;
}

/** Repository capability preparation and preview only. It intentionally has no Dispatch capability. */
export class RepositoryRehearsalOperations {
  private readonly now: () => Date;
  private readonly lifecycle: JobLifecycleService;
  private readonly planning: ExecutionPlanningService;
  private readonly preflight: ExecutionPreflightService;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly repositories: RepositoryInventoryAdapter,
    runtimes: ConstructorParameters<typeof ExecutionPreflightService>[1],
    options: RepositoryRehearsalOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.lifecycle = new JobLifecycleService(store, {
      now: this.now,
      ...(options.jobIdFactory ? { jobIdFactory: options.jobIdFactory } : {}),
      ...(options.attemptIdFactory ? { attemptIdFactory: options.attemptIdFactory } : {}),
    });
    this.planning = new ExecutionPlanningService(store, {
      now: this.now,
      ...(options.planIdFactory ? { planIdFactory: options.planIdFactory } : {}),
    });
    this.preflight = new ExecutionPreflightService(
      store,
      runtimes,
      repositories,
      this.now,
      { requireExactTurnCorrelation: true },
    );
  }

  async prepare(
    runtime: AgentRuntimeDetail,
    checkoutPath = REPOSITORY_REHEARSAL_CHECKOUT,
  ): Promise<RepositoryRehearsalPreparation> {
    const repository = await this.requireExpectedRepository(checkoutPath);
    const installation = await this.store.getInstallation();
    const bindingId = createRepositoryCheckoutBindingId(installation.id, repository.repositoryRoot!);
    const existingProject = await this.store.getProject(REPOSITORY_REHEARSAL_PROJECT_ID);
    if (!existingProject) {
      const timestamp = this.now().toISOString();
      await this.store.applyProjectConfiguration({
        project: {
          id: REPOSITORY_REHEARSAL_PROJECT_ID,
          name: 'Agent Operations Repository Read-Only Rehearsal',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        repositories: [{
          id: repository.id,
          identityKind: repository.identityKind,
          name: repository.name || basename(repository.repositoryRoot!),
          ...(repository.primaryRemote?.identity
            ? { canonicalRemote: repository.primaryRemote.identity.canonical }
            : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        }],
        checkoutBindings: [{
          id: bindingId,
          repositoryId: repository.id,
          installationId: installation.id,
          canonicalPath: repository.repositoryRoot!,
          availability: repository.availability,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
        }],
        runtimeAgentIds: [runtime.id],
      });
    }

    await this.verifyConfiguration(runtime.id, repository.repositoryRoot!, bindingId);
    const jobs = await this.store.listJobs(REPOSITORY_REHEARSAL_PROJECT_ID);
    if (jobs.length > 1) throw new Error('Multiple repository rehearsal Jobs exist; refusing to choose automatically');
    if (jobs.length === 1) return this.loadExisting(jobs[0], repository);

    const job = await this.lifecycle.createJob({
      projectId: REPOSITORY_REHEARSAL_PROJECT_ID,
      title: 'Inspect RuntimeExecutionPolicy read-only',
      description: 'One repository-bound, read-only, network-denied, empty-environment rehearsal.',
      repositoryId: REPOSITORY_REHEARSAL_ID,
      preferredRuntimeAgentId: runtime.id,
    });
    const ready = await this.lifecycle.markJobReady(job.id);
    const { attempt, plan } = await this.createAttemptAndPlan(ready, runtime.id, bindingId);
    return {
      projectId: REPOSITORY_REHEARSAL_PROJECT_ID,
      job: ready,
      attempt,
      plan,
      repository,
      preflight: await this.preflight.preflight(plan.id),
    };
  }

  private async loadExisting(
    job: DurableJob,
    repository: RepositorySummary,
  ): Promise<RepositoryRehearsalPreparation> {
    const attempts = await this.store.listAttemptsForJob(job.id);
    const active = attempts.filter(attempt => attempt.status === 'created' || attempt.status === 'running');
    if (active.length > 1) throw new Error(`Repository rehearsal Job ${job.id} has multiple active Attempts`);
    if (!active.length) {
      if (job.status !== 'ready') throw new Error(`Repository rehearsal Job ${job.id} is ${job.status}, not ready`);
      const bindings = await this.store.listCheckoutBindings(REPOSITORY_REHEARSAL_ID);
      const binding = bindings.find(candidate => candidate.canonicalPath === repository.repositoryRoot);
      if (!binding) throw new Error('Repository rehearsal checkout binding is unavailable');
      const runtimeIds = await this.store.listProjectRuntimeAgentIds(REPOSITORY_REHEARSAL_PROJECT_ID);
      if (runtimeIds.length !== 1) throw new Error('Repository rehearsal requires exactly one runtime');
      const created = await this.createAttemptAndPlan(job, runtimeIds[0], binding.id);
      return {
        projectId: REPOSITORY_REHEARSAL_PROJECT_ID,
        job,
        attempt: created.attempt,
        plan: created.plan,
        repository,
        preflight: await this.preflight.preflight(created.plan.id),
      };
    }
    const plan = await this.store.getExecutionPlanForAttempt(active[0].id);
    if (!plan) throw new Error(`Repository rehearsal Attempt ${active[0].id} has no Execution Plan`);
    if (plan.repositoryId !== REPOSITORY_REHEARSAL_ID) throw new Error('Existing repository rehearsal Plan targets another repository');
    return {
      projectId: REPOSITORY_REHEARSAL_PROJECT_ID,
      job,
      attempt: active[0],
      plan,
      repository,
      preflight: await this.preflight.preflight(plan.id),
    };
  }

  private async createAttemptAndPlan(
    job: DurableJob,
    runtimeId: string,
    bindingId: string,
  ): Promise<{ attempt: DurableJobAttempt; plan: DurableExecutionPlan }> {
    const attempt = await this.lifecycle.createAttempt(job.id, { runtimeAgentId: runtimeId });
    const plan = await this.planning.prepareExecutionPlan({
      projectId: REPOSITORY_REHEARSAL_PROJECT_ID,
      attemptId: attempt.id,
      checkoutBindingId: bindingId,
      instruction: repositoryRehearsalInstruction(),
      requestedPolicy: REPOSITORY_REHEARSAL_POLICY,
      requestedCapabilities: REPOSITORY_REHEARSAL_CAPABILITIES,
    });
    return { attempt, plan };
  }

  private async requireExpectedRepository(checkoutPath: string): Promise<RepositorySummary> {
    const repository = await this.repositories.inspectRepository(checkoutPath);
    if (repository.availability !== 'available' || !repository.repositoryRoot) {
      throw new Error(repository.reason ?? `Repository checkout is ${repository.availability}`);
    }
    if (repository.id !== REPOSITORY_REHEARSAL_ID) {
      throw new Error(`Repository identity mismatch: expected ${REPOSITORY_REHEARSAL_ID}, observed ${repository.id}`);
    }
    return repository;
  }

  private async verifyConfiguration(
    runtimeId: string,
    canonicalPath: string,
    bindingId: string,
  ): Promise<void> {
    const repositoryIds = await this.store.listProjectRepositoryIds(REPOSITORY_REHEARSAL_PROJECT_ID);
    const runtimeIds = await this.store.listProjectRuntimeAgentIds(REPOSITORY_REHEARSAL_PROJECT_ID);
    const binding = (await this.store.listCheckoutBindings(REPOSITORY_REHEARSAL_ID))
      .find(candidate => candidate.id === bindingId);
    if (!repositoryIds.includes(REPOSITORY_REHEARSAL_ID)
      || !runtimeIds.includes(runtimeId)
      || binding?.canonicalPath !== canonicalPath) {
      throw new Error('Existing repository rehearsal configuration does not match the selected runtime and checkout');
    }
  }
}

export function repositoryRehearsalInstruction(): string {
  return [
    'Inspect this repository read-only.',
    'Identify the repository-relative file that defines the RuntimeExecutionPolicy contract and report its three policy dimensions.',
    'Do not modify anything, run Git mutation commands, or contact external services.',
  ].join(' ');
}
