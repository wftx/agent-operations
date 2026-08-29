import type {
  AgentOperationsStateStore,
  DurableJob,
  DurableJobAttempt,
  DurableProject,
  DurableRepository,
  ExecutionRole,
  JobExecutionMode,
  JobStatus,
} from '../../agent-operations-contracts/src/index.js';
import {
  createAttemptId,
  createJobId,
  isActiveAttemptStatus,
} from '../../agent-operations-contracts/src/index.js';

export interface CreateJobInput {
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  readonly acceptanceCriteria?: string;
  readonly automaticReadOnlyCompletion?: boolean;
  readonly executionMode?: JobExecutionMode;
  readonly repositoryId?: string;
  readonly preferredRuntimeAgentId?: string;
}

export interface CreateAttemptInput {
  /** Actual runtime for this attempt. Omit to inherit the job preference. */
  readonly runtimeAgentId?: string;
  readonly executionRole?: ExecutionRole;
}

export interface JobDetail {
  readonly job: DurableJob;
  readonly effectiveStatus: JobStatus | 'in_progress';
  readonly project: DurableProject;
  readonly repository: DurableRepository | null;
  readonly attempts: readonly DurableJobAttempt[];
}

export interface JobLifecycleServiceOptions {
  readonly now?: () => Date;
  readonly jobIdFactory?: () => string;
  readonly attemptIdFactory?: () => string;
}

function required(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required`);
  return clean;
}

function optional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean || undefined;
}

/** AO-owned lifecycle policy. This service records work but cannot execute it. */
export class JobLifecycleService {
  private readonly store: AgentOperationsStateStore;
  private readonly now: () => Date;
  private readonly jobIdFactory: () => string;
  private readonly attemptIdFactory: () => string;

  constructor(store: AgentOperationsStateStore, options: JobLifecycleServiceOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.jobIdFactory = options.jobIdFactory ?? (() => createJobId());
    this.attemptIdFactory = options.attemptIdFactory ?? (() => createAttemptId());
  }

  async createJob(input: CreateJobInput): Promise<DurableJob> {
    const projectId = required(input.projectId, 'Project ID');
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (input.repositoryId) {
      const repositoryIds = await this.store.listProjectRepositoryIds(projectId);
      if (!repositoryIds.includes(input.repositoryId)) {
        throw new Error(`Repository ${input.repositoryId} is not associated with project ${projectId}`);
      }
    }
    if (input.preferredRuntimeAgentId) {
      await this.requireRuntimeAssociation(projectId, input.preferredRuntimeAgentId);
    }
    const timestamp = this.now().toISOString();
    const acceptanceCriteria = optional(input.acceptanceCriteria);
    if (input.automaticReadOnlyCompletion && !acceptanceCriteria) {
      throw new Error('Automatic read-only completion requires acceptance criteria');
    }
    const executionMode = input.executionMode ?? 'repository-read-only';
    if (executionMode === 'repository-write-isolated' && input.automaticReadOnlyCompletion) {
      throw new Error('Write Jobs cannot enable automatic read-only completion');
    }
    const job: DurableJob = {
      id: this.jobIdFactory(),
      projectId,
      title: required(input.title, 'Job title'),
      ...(optional(input.description) ? { description: optional(input.description) } : {}),
      ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
      ...(input.automaticReadOnlyCompletion ? { automaticReadOnlyCompletion: true } : {}),
      ...(input.executionMode ? { executionMode } : {}),
      status: 'draft',
      ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
      ...(input.preferredRuntimeAgentId
        ? { preferredRuntimeAgentId: input.preferredRuntimeAgentId }
        : {}),
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.createJob(job);
    return job;
  }

  async markJobReady(jobId: string): Promise<DurableJob> {
    const job = await this.requireJob(jobId);
    if (job.status !== 'draft') throw new Error(`Job ${job.id} cannot transition from ${job.status} to ready`);
    return this.transitionJob(job, 'ready');
  }

  async completeJob(jobId: string): Promise<DurableJob> {
    const job = await this.requireJob(jobId);
    if (job.status !== 'ready') throw new Error(`Job ${job.id} cannot transition from ${job.status} to completed`);
    const attempts = await this.store.listAttemptsForJob(job.id);
    if (attempts.some(attempt => isActiveAttemptStatus(attempt.status))) {
      throw new Error(`Job ${job.id} cannot complete while an attempt is active`);
    }
    if (!attempts.some(attempt => attempt.executionRole === 'worker'
      && attempt.status === 'completed')) {
      throw new Error(`Job ${job.id} requires a completed attempt from the Worker role before completion`);
    }
    return this.transitionJob(job, 'completed');
  }

  async cancelJob(jobId: string): Promise<DurableJob> {
    const job = await this.requireJob(jobId);
    if (job.status !== 'draft' && job.status !== 'ready') {
      throw new Error(`Job ${job.id} cannot transition from ${job.status} to cancelled`);
    }
    const attempts = await this.store.listAttemptsForJob(job.id);
    if (attempts.some(attempt => isActiveAttemptStatus(attempt.status))) {
      throw new Error(`Job ${job.id} cannot be cancelled while an attempt is active`);
    }
    return this.transitionJob(job, 'cancelled');
  }

  async createAttempt(jobId: string, input: CreateAttemptInput = {}): Promise<DurableJobAttempt> {
    const job = await this.requireJob(jobId);
    if (job.status !== 'ready') throw new Error(`Job ${job.id} must be ready before creating an attempt`);
    const runtimeAgentId = input.runtimeAgentId ?? job.preferredRuntimeAgentId;
    if (runtimeAgentId) await this.requireRuntimeAssociation(job.projectId, runtimeAgentId);
    const timestamp = this.now().toISOString();
    return this.store.createAttempt({
      id: this.attemptIdFactory(),
      jobId: job.id,
      ...(runtimeAgentId ? { runtimeAgentId } : {}),
      executionRole: input.executionRole ?? 'worker',
      status: 'created',
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async startAttempt(attemptId: string): Promise<DurableJobAttempt> {
    const attempt = await this.requireAttempt(attemptId);
    if (attempt.status !== 'created') {
      throw new Error(`Attempt ${attempt.id} cannot transition from ${attempt.status} to running`);
    }
    const job = await this.requireJob(attempt.jobId);
    if (job.status !== 'ready') throw new Error(`Job ${job.id} is not ready for an attempt`);
    const timestamp = this.now().toISOString();
    return this.transitionAttempt(attempt, {
      status: 'running',
      startedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async completeAttempt(attemptId: string, summary?: string): Promise<DurableJobAttempt> {
    const attempt = await this.requireRunningAttempt(attemptId, 'completed');
    const timestamp = this.now().toISOString();
    return this.transitionAttempt(attempt, {
      status: 'completed',
      finishedAt: timestamp,
      ...(optional(summary) ? { summary: optional(summary) } : {}),
      updatedAt: timestamp,
    });
  }

  async failAttempt(attemptId: string, failureReason: string): Promise<DurableJobAttempt> {
    const attempt = await this.requireRunningAttempt(attemptId, 'failed');
    const timestamp = this.now().toISOString();
    return this.transitionAttempt(attempt, {
      status: 'failed',
      failureReason: required(failureReason, 'Attempt failure reason'),
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async cancelAttempt(attemptId: string): Promise<DurableJobAttempt> {
    const attempt = await this.requireAttempt(attemptId);
    if (attempt.status !== 'created' && attempt.status !== 'running') {
      throw new Error(`Attempt ${attempt.id} cannot transition from ${attempt.status} to cancelled`);
    }
    const timestamp = this.now().toISOString();
    return this.transitionAttempt(attempt, {
      status: 'cancelled',
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async getJobDetail(jobId: string): Promise<JobDetail> {
    const job = await this.requireJob(jobId);
    const project = await this.store.getProject(job.projectId);
    if (!project) throw new Error(`Project not found for job ${job.id}: ${job.projectId}`);
    const repository = job.repositoryId ? await this.store.getRepository(job.repositoryId) : null;
    const attempts = await this.store.listAttemptsForJob(job.id);
    return {
      job,
      effectiveStatus: attempts.some(attempt => isActiveAttemptStatus(attempt.status))
        ? 'in_progress'
        : job.status,
      project,
      repository,
      attempts,
    };
  }

  private async transitionJob(job: DurableJob, status: JobStatus): Promise<DurableJob> {
    const next = {
      ...job,
      status,
      revision: job.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    await this.store.saveJobTransition(next, job.revision);
    return next;
  }

  private async transitionAttempt(
    attempt: DurableJobAttempt,
    change: Partial<DurableJobAttempt> & Pick<DurableJobAttempt, 'status' | 'updatedAt'>,
  ): Promise<DurableJobAttempt> {
    const next = { ...attempt, ...change, revision: attempt.revision + 1 };
    await this.store.saveAttemptTransition(next, attempt.revision);
    return next;
  }

  private async requireJob(id: string): Promise<DurableJob> {
    const job = await this.store.getJob(required(id, 'Job ID'));
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }

  private async requireAttempt(id: string): Promise<DurableJobAttempt> {
    const attempt = await this.store.getAttempt(required(id, 'Attempt ID'));
    if (!attempt) throw new Error(`Attempt not found: ${id}`);
    return attempt;
  }

  private async requireRunningAttempt(id: string, target: 'completed' | 'failed'): Promise<DurableJobAttempt> {
    const attempt = await this.requireAttempt(id);
    if (attempt.status !== 'running') {
      throw new Error(`Attempt ${attempt.id} cannot transition from ${attempt.status} to ${target}`);
    }
    return attempt;
  }

  private async requireRuntimeAssociation(projectId: string, runtimeAgentId: string): Promise<void> {
    const runtimeIds = await this.store.listProjectRuntimeAgentIds(projectId);
    if (!runtimeIds.includes(runtimeAgentId)) {
      throw new Error(`Runtime ${runtimeAgentId} is not associated with project ${projectId}`);
    }
  }
}
