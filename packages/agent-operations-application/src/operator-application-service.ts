import type {
  AgentOperationsStateStore,
  DurableJob,
  DurableJobAttempt,
} from '../../agent-operations-contracts/src/index.js';
import {
  REPOSITORY_READ_EXECUTION_CAPABILITIES,
  RESTRICTED_TEXT_EXECUTION_POLICY,
  createEscalationId,
  isActiveAttemptStatus,
  isExactCompletionObservation,
} from '../../agent-operations-contracts/src/index.js';
import {
  JobLifecycleService,
  MVP_MAX_WORKER_ATTEMPTS,
  type OrchestrationPreview,
  type OrchestrationReadModel,
} from '../../agent-operations-core/src/index.js';
import type {
  OperatorApplication,
  OperatorAttemptStory,
  OperatorJobDetail,
  OperatorJobList,
  OperatorJobSummary,
  OperatorPolicyDefaults,
  OperatorProjectOption,
  OperatorRunSession,
  OperatorTaskInput,
  OperatorTaskPreview,
} from './types.js';

export interface OperatorOrchestrationPort {
  preview(jobId: string): Promise<OrchestrationPreview>;
  runJob(jobId: string): Promise<OrchestrationReadModel>;
}

export interface OperatorApplicationServiceOptions {
  readonly now?: () => Date;
}

export const OPERATOR_READ_ONLY_DEFAULTS: OperatorPolicyDefaults = {
  policy: { ...RESTRICTED_TEXT_EXECUTION_POLICY },
  capabilities: { ...REPOSITORY_READ_EXECUTION_CAPABILITIES },
  maxWorkerAttempts: MVP_MAX_WORKER_ATTEMPTS,
  reviewerEnabled: true,
  automaticReadOnlyCompletion: true,
};

/**
 * Job-shaped boundary used by both local operator surfaces. Read operations
 * inspect AO durable state only. runOperatorJob is the sole execution entry.
 */
export class OperatorApplicationService implements OperatorApplication {
  private readonly lifecycle: JobLifecycleService;
  private readonly now: () => Date;
  private activeJobId?: string;
  private runReserved = false;
  private readonly sessions = new Map<string, OperatorRunSession>();
  private readonly runPromises = new Map<string, Promise<OperatorRunSession>>();

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly orchestration: OperatorOrchestrationPort,
    options: OperatorApplicationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.lifecycle = new JobLifecycleService(store, { now: this.now });
  }

  async listProjects(): Promise<readonly OperatorProjectOption[]> {
    const projects = await this.store.listProjects();
    return Promise.all(projects.map(async project => {
      const repositoryIds = await this.store.listProjectRepositoryIds(project.id);
      const repositories = (await Promise.all(repositoryIds.map(id => this.store.getRepository(id))))
        .filter(repository => repository !== null);
      const runtimeAgentIds = await this.store.listProjectRuntimeAgentIds(project.id);
      const unavailableReason = repositories.length === 0
        ? 'No repository is configured'
        : runtimeAgentIds.length === 0 ? 'No Worker/Reviewer runtime is configured' : undefined;
      return {
        project,
        repositories,
        runtimeAgentIds,
        runnable: !unavailableReason,
        ...(unavailableReason ? { unavailableReason } : {}),
      };
    }));
  }

  async previewTask(input: OperatorTaskInput): Promise<OperatorTaskPreview> {
    const task = boundedRequired(input.task, 'Task', 16_384);
    const acceptanceCriteria = boundedRequired(input.acceptanceCriteria, 'Acceptance criteria', 8_192);
    const projectId = required(input.projectId, 'Project');
    const repositoryId = required(input.repositoryId, 'Repository');
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const repositoryIds = await this.store.listProjectRepositoryIds(projectId);
    if (!repositoryIds.includes(repositoryId)) {
      throw new Error(`Repository ${repositoryId} is not configured for project ${projectId}`);
    }
    const repository = await this.store.getRepository(repositoryId);
    if (!repository) throw new Error(`Repository not found: ${repositoryId}`);
    const runtimeAgentIds = [...await this.store.listProjectRuntimeAgentIds(projectId)].sort();
    if (runtimeAgentIds.length === 0) {
      throw new Error(`Project ${projectId} has no configured Worker/Reviewer runtime`);
    }
    return {
      project,
      repository,
      runtimeAgentId: runtimeAgentIds[0],
      task,
      acceptanceCriteria,
      defaults: OPERATOR_READ_ONLY_DEFAULTS,
      executionAuthorized: false,
    };
  }

  async runOperatorJob(input: OperatorTaskInput): Promise<OperatorRunSession> {
    if (this.runReserved || this.activeJobId) {
      throw new Error(this.activeJobId
        ? `Operator orchestration is already running for Job ${this.activeJobId}`
        : 'Operator orchestration is already starting');
    }
    this.runReserved = true;
    try {
      const preview = await this.previewTask(input);
      const created = await this.lifecycle.createJob({
        projectId: preview.project.id,
        repositoryId: preview.repository.id,
        preferredRuntimeAgentId: preview.runtimeAgentId,
        title: taskTitle(preview.task),
        description: preview.task,
        acceptanceCriteria: preview.acceptanceCriteria,
        automaticReadOnlyCompletion: true,
      });
      const job = await this.lifecycle.markJobReady(created.id);
      const startedAt = this.now().toISOString();
      const session: OperatorRunSession = { jobId: job.id, status: 'running', startedAt };
      this.activeJobId = job.id;
      this.sessions.set(job.id, session);
      const promise = this.execute(job, session);
      this.runPromises.set(job.id, promise);
      void promise.catch(() => undefined);
      return session;
    } finally {
      this.runReserved = false;
    }
  }

  async waitForRun(jobId: string): Promise<OperatorRunSession> {
    const promise = this.runPromises.get(required(jobId, 'Job ID'));
    if (promise) return promise;
    const session = this.sessions.get(jobId);
    if (session) return session;
    throw new Error(`Operator run session not found: ${jobId}`);
  }

  async listJobs(filter: OperatorJobList = 'all'): Promise<readonly OperatorJobSummary[]> {
    const jobs = await this.store.listJobs();
    const summaries = await Promise.all(jobs.map(job => this.buildSummary(job)));
    return summaries
      .filter(summary => matchesFilter(summary, filter))
      .sort((left, right) => right.job.createdAt.localeCompare(left.job.createdAt));
  }

  async getJobDetail(jobId: string): Promise<OperatorJobDetail> {
    const job = await this.store.getJob(required(jobId, 'Job ID'));
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const summary = await this.buildSummary(job);
    const attempts = await this.store.listAttemptsForJob(job.id);
    const reviews = await this.store.listAttemptReviewsForJob(job.id);
    const escalations = await this.store.listEscalations(job.id);
    const stories = await Promise.all(attempts.map(attempt => this.buildAttemptStory(attempt)));
    const workerAttempts = stories
      .filter(story => story.attempt.executionRole === 'worker')
      .map(story => ({
        ...story,
        ...(reviews.find(review => review.workerAttemptId === story.attempt.id)
          ? { review: reviews.find(review => review.workerAttemptId === story.attempt.id)! }
          : {}),
      }));
    const reviewerAttempts = stories.filter(story => story.attempt.executionRole === 'reviewer');
    const finalWorkerResult = [...workerAttempts].reverse().find(story => story.resultText)?.resultText;
    const finalReview = reviews.at(-1);
    return {
      summary,
      acceptanceCriteria: job.acceptanceCriteria ?? '',
      workerAttempts,
      reviewerAttempts,
      reviews,
      escalations,
      ...(finalWorkerResult ? { finalWorkerResult } : {}),
      ...(finalReview ? { finalReview } : {}),
      ...(job.status === 'completed' ? { completedAt: job.updatedAt } : {}),
    };
  }

  private async execute(job: DurableJob, initial: OperatorRunSession): Promise<OperatorRunSession> {
    try {
      const preview = await this.orchestration.preview(job.id);
      if (!preview.eligible) {
        throw new Error(`Orchestration preflight failed: ${preview.findings.join('; ')}`);
      }
      const result = await this.orchestration.runJob(job.id);
      const status = result.needsHuman || result.finalDecision === 'ESCALATED' ? 'needs-human' : 'done';
      const completed: OperatorRunSession = {
        ...initial,
        status,
        finishedAt: this.now().toISOString(),
        message: status === 'done'
          ? 'Worker result passed independent review.'
          : 'Agent Operations stopped at a durable Needs Me boundary.',
      };
      this.sessions.set(job.id, completed);
      return completed;
    } catch (error) {
      const message = errorMessage(error);
      try {
        if ((await this.store.listEscalations(job.id, true)).length === 0) {
          await this.store.createEscalation({
            id: createEscalationId(),
            jobId: job.id,
            reason: 'runtime_failure',
            summary: `Operator orchestration stopped unexpectedly: ${message}`,
            createdAt: this.now().toISOString(),
          });
        }
        const escalated: OperatorRunSession = {
          ...initial,
          status: 'needs-human',
          finishedAt: this.now().toISOString(),
          message,
        };
        this.sessions.set(job.id, escalated);
        return escalated;
      } catch (persistenceError) {
        const failed: OperatorRunSession = {
          ...initial,
          status: 'failed',
          finishedAt: this.now().toISOString(),
          message: `${message}; durable escalation failed: ${errorMessage(persistenceError)}`,
        };
        this.sessions.set(job.id, failed);
        throw new Error(failed.message);
      }
    } finally {
      if (this.activeJobId === job.id) this.activeJobId = undefined;
    }
  }

  private async buildSummary(job: DurableJob): Promise<OperatorJobSummary> {
    const project = await this.store.getProject(job.projectId);
    const repository = job.repositoryId ? await this.store.getRepository(job.repositoryId) : null;
    const attempts = await this.store.listAttemptsForJob(job.id);
    const reviews = await this.store.listAttemptReviewsForJob(job.id);
    const unresolved = await this.store.listEscalations(job.id, true);
    const latestAttempt = attempts.at(-1) ?? null;
    const activeAttempt = [...attempts].reverse().find(attempt => isActiveAttemptStatus(attempt.status));
    const session = this.sessions.get(job.id);
    const currentRole = activeAttempt?.executionRole
      ?? (session?.status === 'running' ? latestAttempt?.executionRole ?? 'worker' : null);
    return {
      job,
      projectName: project?.name ?? job.projectId,
      repositoryName: repository?.name ?? job.repositoryId ?? 'No repository',
      latestAttempt,
      currentRole,
      orchestrationState: orchestrationState(job, activeAttempt, session, unresolved.length > 0),
      workerAttemptCount: attempts.filter(attempt => attempt.executionRole === 'worker').length,
      latestReviewDecision: reviews.at(-1)?.decision ?? null,
      needsHuman: unresolved.length > 0,
    };
  }

  private async buildAttemptStory(attempt: DurableJobAttempt): Promise<OperatorAttemptStory> {
    const plan = await this.store.getExecutionPlanForAttempt(attempt.id);
    const dispatch = plan ? await this.store.getExecutionDispatchForPlan(plan.id) : null;
    const observations = dispatch
      ? await this.store.listExecutionObservationsForDispatch(dispatch.id)
      : [];
    const exact = observations.find(isExactCompletionObservation);
    return {
      attempt,
      ...(exact?.resultText ? { resultText: exact.resultText } : {}),
      ...(plan ? { executionPlanId: plan.id } : {}),
      ...(dispatch ? { dispatchId: dispatch.id } : {}),
      ...(exact?.externalReference ?? dispatch?.externalReference
        ? { externalReference: exact?.externalReference ?? dispatch!.externalReference! }
        : {}),
    };
  }
}

function required(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required`);
  return clean;
}

function boundedRequired(value: string, field: string, max: number): string {
  const clean = required(value, field);
  if (clean.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return clean;
}

function taskTitle(task: string): string {
  const firstLine = task.split(/\r?\n/, 1)[0].trim();
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 97)}…`;
}

function orchestrationState(
  job: DurableJob,
  activeAttempt: DurableJobAttempt | undefined,
  session: OperatorRunSession | undefined,
  needsHuman: boolean,
): string {
  if (needsHuman) return 'Needs Me';
  if (job.status === 'completed') return 'Done';
  if (session?.status === 'running' || activeAttempt) {
    const role = activeAttempt?.executionRole ?? 'worker';
    return `${role === 'reviewer' ? 'Reviewer' : 'Worker'} running`;
  }
  if (session?.status === 'failed') return 'Run failed';
  if (job.status === 'ready') return 'Ready';
  return job.status === 'draft' ? 'New' : 'Cancelled';
}

function matchesFilter(summary: OperatorJobSummary, filter: OperatorJobList): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs-human') return summary.needsHuman;
  if (filter === 'done') return summary.job.status === 'completed';
  return summary.orchestrationState.endsWith('running');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
