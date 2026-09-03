import type {
  AgentOperationsStateStore,
  AgentRuntimeAdapter,
  RuntimeLifecycleAdapter,
  DurableJob,
  DurableJobAttempt,
  DurableEscalation,
  DurableOperatorRun,
  DurableJobRetirement,
  DurableRepositoryRestoreAction,
  JobRetirementDisposition,
} from '../../agent-operations-contracts/src/index.js';
import {
  REPOSITORY_READ_EXECUTION_CAPABILITIES,
  RESTRICTED_TEXT_EXECUTION_POLICY,
  REPOSITORY_WRITE_EXECUTION_CAPABILITIES,
  createHumanGuidanceId,
  createWorkerBudgetExtensionId,
  createEscalationId,
  createAttemptReviewId,
  createOperatorRunId,
  isActiveAttemptStatus,
  isExactCompletionObservation,
  executionModeForJob,
  workerMaximumForPolicy,
  classifyEscalationResolution,
  canAutonomouslyPerformRiskTier,
  riskTierForExecutionMode,
} from '../../agent-operations-contracts/src/index.js';
import {
  JobLifecycleService,
  JobRetirementService,
  RepositoryRestoreService,
  DEFAULT_GLOBAL_ACTIVE_REPOSITORY_WORKSPACE_LIMIT,
  isActiveRepositoryWorkspace,
  MVP_MAX_WORKER_ATTEMPTS,
  readWorkerExecutionBudget,
  parseReviewerResult,
  type OrchestrationPreview,
  type OrchestrationReadModel,
  type TimedOutExecutionReconciliation,
} from '../../agent-operations-core/src/index.js';
import type { OperatorNotifier } from './notification.js';
import { OperatorRunner } from './operator-runner.js';
import { TrustProfileApplicationService } from './trust-profile-application-service.js';
import type {
  OperatorApplication,
  OperatorAttemptStory,
  OperatorEscalationAction,
  OperatorEscalationKind,
  OperatorExecutionStage,
  OperatorJobDetail,
  OperatorJobList,
  OperatorJobSummary,
  OperatorPolicyDefaults,
  OperatorProjectOption,
  OperatorRuntimeStatus,
  OperatorRunSession,
  OperatorTaskInput,
  OperatorTaskPreview,
  TrustProfileApplication,
  RuntimeFreshnessApplication,
} from './types.js';

export interface OperatorOrchestrationPort {
  preview(jobId: string): Promise<OrchestrationPreview>;
  runJob(jobId: string): Promise<OrchestrationReadModel>;
  reconcileTimedOutExecution(escalationId: string): Promise<TimedOutExecutionReconciliation>;
}

export interface OperatorApplicationServiceOptions {
  readonly now?: () => Date;
  readonly runtime?: AgentRuntimeAdapter;
  readonly runtimeLifecycle?: RuntimeLifecycleAdapter;
  readonly notifier?: OperatorNotifier;
  readonly operatorRunIdFactory?: () => string;
  readonly humanGuidanceIdFactory?: () => string;
  readonly workerBudgetExtensionIdFactory?: () => string;
  readonly escalationIdFactory?: () => string;
  /** Persist mutations without waking this process's runner. Used by bounded external tool adapters. */
  readonly deferRunnerWake?: boolean;
  readonly trustProfiles?: TrustProfileApplication;
  readonly runtimeFreshness?: RuntimeFreshnessApplication;
  readonly jobRetirement?: JobRetirementService;
  readonly repositoryRestore?: RepositoryRestoreService;
}

export const OPERATOR_READ_ONLY_DEFAULTS: OperatorPolicyDefaults = {
  policy: { ...RESTRICTED_TEXT_EXECUTION_POLICY },
  capabilities: { ...REPOSITORY_READ_EXECUTION_CAPABILITIES },
  maxWorkerAttempts: MVP_MAX_WORKER_ATTEMPTS,
  reviewerEnabled: true,
  automaticReadOnlyCompletion: true,
};

export const OPERATOR_ISOLATED_WRITE_DEFAULTS: OperatorPolicyDefaults = {
  policy: { version: 1, filesystem: 'workspace-write', network: 'deny', environment: 'empty' },
  capabilities: { ...REPOSITORY_WRITE_EXECUTION_CAPABILITIES },
  maxWorkerAttempts: MVP_MAX_WORKER_ATTEMPTS,
  reviewerEnabled: true,
  automaticReadOnlyCompletion: false,
};

/**
 * Job-shaped boundary used by both local operator surfaces. Read operations
 * inspect AO durable state only. runOperatorJob is the sole execution entry.
 */
export class OperatorApplicationService implements OperatorApplication {
  private readonly lifecycle: JobLifecycleService;
  private readonly now: () => Date;
  private runReserved = false;
  private readonly runner: OperatorRunner;
  private readonly runtime?: AgentRuntimeAdapter;
  private readonly runtimeLifecycle?: RuntimeLifecycleAdapter;
  private readonly operatorRunIdFactory: () => string;
  private readonly humanGuidanceIdFactory: () => string;
  private readonly workerBudgetExtensionIdFactory: () => string;
  private readonly escalationIdFactory: () => string;
  private readonly deferRunnerWake: boolean;
  private readonly trustProfiles: TrustProfileApplication;
  private readonly runtimeFreshness?: RuntimeFreshnessApplication;
  private readonly jobRetirement?: JobRetirementService;
  private readonly repositoryRestore?: RepositoryRestoreService;
  private reconciliationPromise: Promise<void> | null = null;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly orchestration: OperatorOrchestrationPort,
    options: OperatorApplicationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.lifecycle = new JobLifecycleService(store, { now: this.now });
    this.runtime = options.runtime;
    this.runtimeLifecycle = options.runtimeLifecycle;
    this.operatorRunIdFactory = options.operatorRunIdFactory ?? (() => createOperatorRunId());
    this.humanGuidanceIdFactory = options.humanGuidanceIdFactory ?? (() => createHumanGuidanceId());
    this.workerBudgetExtensionIdFactory = options.workerBudgetExtensionIdFactory
      ?? (() => createWorkerBudgetExtensionId());
    this.escalationIdFactory = options.escalationIdFactory ?? (() => createEscalationId());
    this.deferRunnerWake = options.deferRunnerWake ?? false;
    this.trustProfiles = options.trustProfiles ?? new TrustProfileApplicationService(store, { now: this.now });
    this.runtimeFreshness = options.runtimeFreshness;
    this.jobRetirement = options.jobRetirement;
    this.repositoryRestore = options.repositoryRestore;
    this.runner = new OperatorRunner(store, orchestration, {
      now: this.now,
      ...(options.notifier ? { notifier: options.notifier } : {}),
      ...(options.runtimeFreshness ? { runtimeFreshness: options.runtimeFreshness } : {}),
    });
  }

  startRunner(): void {
    if (this.reconciliationPromise) return;
    const reconciliation = this.reconcileMachineResolvableRuns().catch(() => undefined);
    this.reconciliationPromise = reconciliation;
    void reconciliation.finally(() => {
      if (this.reconciliationPromise === reconciliation) this.reconciliationPromise = null;
      this.runner.start();
    });
  }

  async getRuntimeStatus(): Promise<OperatorRuntimeStatus> {
    if (!this.runtime) {
      return { state: 'offline', label: 'Offline', reason: 'Runtime inventory is not configured.' };
    }
    try {
      const health = await this.runtime.getHealth();
      const agents = await this.runtime.listAgents();
      const ready = agents.some(agent => agent.configured && agent.enabled !== false
        && agent.health.state === 'running');
      if (health.state === 'available' && ready) return { state: 'ready', label: 'Ready' };
      if (health.state === 'unavailable') {
        return { state: 'offline', label: 'Offline', ...(health.reason ? { reason: health.reason } : {}) };
      }
      return {
        state: 'degraded',
        label: 'Needs attention',
        reason: health.reason ?? 'No configured runtime is currently running.',
      };
    } catch (error) {
      return { state: 'offline', label: 'Offline', reason: errorMessage(error) };
    }
  }

  async startRuntime() {
    if (!this.runtimeLifecycle) throw new Error('Runtime startup is not configured.');
    return this.runtimeLifecycle.start();
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
    const title = input.title === undefined ? undefined : boundedRequired(input.title, 'Title', 200);
    const task = boundedRequired(input.task, 'Task', 16_384);
    const acceptanceCriteria = boundedRequired(input.acceptanceCriteria, 'Acceptance criteria', 8_192);
    const projectId = required(input.projectId, 'Project');
    const repositoryId = required(input.repositoryId, 'Repository');
    const executionMode = input.executionMode ?? 'repository-read-only';
    if (executionMode !== 'repository-read-only' && executionMode !== 'repository-write-isolated') {
      throw new Error('Execution mode must be repository read only or isolated repository write');
    }
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
    for (const inputId of input.inputIds ?? []) {
      const durableInput = await this.store.getInput(inputId);
      if (!durableInput) throw new Error(`Input not found: ${inputId}`);
      if (durableInput.projectId && durableInput.projectId !== projectId) {
        throw new Error(`Input ${inputId} belongs to another Project`);
      }
    }
    if (input.browserEvidenceRequirement) validateBrowserEvidenceRequirement(input.browserEvidenceRequirement);
    const trust = await this.trustProfiles.effectiveForProject(projectId);
    const defaults = executionMode === 'repository-write-isolated'
      ? { ...OPERATOR_ISOLATED_WRITE_DEFAULTS,
          maxWorkerAttempts: workerMaximumForPolicy(trust.policy, executionMode) }
      : { ...OPERATOR_READ_ONLY_DEFAULTS,
          maxWorkerAttempts: workerMaximumForPolicy(trust.policy, executionMode) };
    return {
      project,
      repository,
      runtimeAgentId: runtimeAgentIds[0],
      ...(title ? { title } : {}),
      task,
      acceptanceCriteria,
      defaults,
      executionMode,
      executionAuthorized: false,
      ...(input.inputIds?.length ? { inputIds: [...input.inputIds] } : {}),
      ...(input.browserEvidenceRequirement
        ? { browserEvidenceRequirement: { ...input.browserEvidenceRequirement, viewport: { ...input.browserEvidenceRequirement.viewport } } }
        : {}),
    };
  }

  async runOperatorJob(input: OperatorTaskInput): Promise<OperatorRunSession> {
    const active = (await this.store.listOperatorRuns())
      .find(run => run.status === 'pending' || run.status === 'running');
    if (this.runReserved || active) {
      throw new Error(active
        ? `Operator orchestration is already running for Job ${active.jobId}`
        : 'Operator orchestration is already starting');
    }
    this.runReserved = true;
    try {
      const preview = await this.previewTask(input);
      if (preview.executionMode === 'repository-write-isolated') {
        const active = (await this.store.listRepositoryWorkspaces()).filter(isActiveRepositoryWorkspace);
        const occupied = active.find(workspace => workspace.repositoryId === preview.repository.id);
        if (occupied) {
          throw new Error(`Write Job ${occupied.jobId} already owns the isolated workspace for repository ${preview.repository.id}`);
        }
        if (active.length >= DEFAULT_GLOBAL_ACTIVE_REPOSITORY_WORKSPACE_LIMIT) {
          throw new Error(`The global active isolated workspace limit of ${DEFAULT_GLOBAL_ACTIVE_REPOSITORY_WORKSPACE_LIMIT} is reached`);
        }
      }
      const created = await this.lifecycle.createJob({
        projectId: preview.project.id,
        repositoryId: preview.repository.id,
        preferredRuntimeAgentId: preview.runtimeAgentId,
        title: preview.title ?? taskTitle(preview.task),
        description: preview.task,
        acceptanceCriteria: preview.acceptanceCriteria,
        executionMode: preview.executionMode,
        automaticReadOnlyCompletion: preview.executionMode === 'repository-read-only',
      });
      const job = await this.lifecycle.markJobReady(created.id);
      if (input.inputIds?.length) await this.store.attachInputsToJob(job.id, input.inputIds);
      if (preview.browserEvidenceRequirement) {
        await this.store.setJobBrowserEvidenceRequirement(job.id, preview.browserEvidenceRequirement);
      }
      const createdAt = this.now().toISOString();
      await this.store.createOperatorRun({
        id: this.operatorRunIdFactory(),
        jobId: job.id,
        status: 'pending',
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      });
      if (!this.deferRunnerWake) void this.runner.wake();
      return { jobId: job.id, status: 'pending', startedAt: createdAt };
    } finally {
      this.runReserved = false;
    }
  }

  async waitForRun(jobId: string): Promise<OperatorRunSession> {
    if (this.reconciliationPromise) await this.reconciliationPromise;
    return toRunSession(await this.runner.waitForRun(required(jobId, 'Job ID')));
  }

  async provideGuidanceAndContinue(
    escalationId: string,
    instruction: string,
  ): Promise<OperatorRunSession> {
    const escalation = await this.requireUnresolvedEscalation(escalationId);
    const attempts = await this.store.listAttemptsForJob(escalation.jobId);
    if (!await this.allowsGuidedContinuation(escalation, attempts)) {
      throw new Error(`Escalation ${escalation.id} does not permit guided continuation`);
    }
    const bounded = boundedRequired(instruction, 'Guidance', 4_096);
    if (attempts.some(attempt => isActiveAttemptStatus(attempt.status))) {
      throw new Error('Guided continuation requires no active Attempt');
    }
    const workerMaximum = await this.workerMaximumForJob(escalation.jobId);
    const workerBudget = await readWorkerExecutionBudget(
      this.store,
      attempts,
      workerMaximum,
    );
    if (workerBudget.exhausted) {
      throw new Error(`Worker execution budget of ${workerMaximum} is exhausted`);
    }
    if (await this.hasUncertainDispatch(attempts)) {
      throw new Error('Guided continuation is forbidden while a Dispatch is uncertain');
    }
    const timestamp = this.now().toISOString();
    const run = await this.requireOperatorRun(escalation.jobId);
    if (run.status !== 'needs_human') throw new Error(`Operator Run ${run.id} is ${run.status}`);
    const pending: DurableOperatorRun = {
      ...run,
      status: 'pending',
      failureMessage: undefined,
      revision: run.revision + 1,
      updatedAt: timestamp,
      startedAt: undefined,
      finishedAt: undefined,
    };
    await this.store.createHumanGuidanceAndResumeOperatorRun({
      id: this.humanGuidanceIdFactory(),
      jobId: escalation.jobId,
      escalationId: escalation.id,
      instruction: bounded,
      createdAt: timestamp,
    }, timestamp, pending, run.revision);
    void this.runner.wake();
    return toRunSession(pending);
  }

  async authorizeOneMoreWorkerAttempt(
    escalationId: string,
    instruction?: string,
  ): Promise<OperatorRunSession> {
    const escalation = await this.requireUnresolvedEscalation(escalationId);
    const attempts = await this.store.listAttemptsForJob(escalation.jobId);
    if (attempts.some(attempt => isActiveAttemptStatus(attempt.status))) {
      throw new Error('Worker budget extension requires no active Attempt');
    }
    if (await this.hasUncertainDispatch(attempts)) {
      throw new Error('Worker budget extension is forbidden while a Dispatch is uncertain');
    }
    const workerBudget = await readWorkerExecutionBudget(
      this.store,
      attempts,
      await this.workerMaximumForJob(escalation.jobId),
    );
    if (!workerBudget.exhausted
      || !await this.allowsWorkerBudgetExtension(escalation, attempts)) {
      throw new Error(`Escalation ${escalation.id} does not permit a Worker budget extension`);
    }
    const bounded = instruction?.trim();
    if (bounded && bounded.length > 4_096) throw new Error('Guidance exceeds 4096 characters');
    const timestamp = this.now().toISOString();
    const run = await this.requireOperatorRun(escalation.jobId);
    if (run.status !== 'needs_human') throw new Error(`Operator Run ${run.id} is ${run.status}`);
    const pending: DurableOperatorRun = {
      ...run,
      status: 'pending',
      failureMessage: undefined,
      revision: run.revision + 1,
      updatedAt: timestamp,
      startedAt: undefined,
      finishedAt: undefined,
    };
    await this.store.authorizeWorkerBudgetExtensionAndResumeOperatorRun({
      id: this.workerBudgetExtensionIdFactory(),
      jobId: escalation.jobId,
      escalationId: escalation.id,
      additionalWorkerExecutions: 1,
      createdAt: timestamp,
    }, bounded ? {
      id: this.humanGuidanceIdFactory(),
      jobId: escalation.jobId,
      escalationId: escalation.id,
      instruction: bounded,
      createdAt: timestamp,
    } : null, timestamp, 'Operator authorized exactly one additional Worker execution.', pending, run.revision);
    if (!this.deferRunnerWake) void this.runner.wake();
    return toRunSession(pending);
  }

  async cancelEscalatedJob(escalationId: string): Promise<OperatorRunSession> {
    const escalation = await this.requireUnresolvedEscalation(escalationId);
    const attempts = await this.store.listAttemptsForJob(escalation.jobId);
    if (attempts.some(attempt => isActiveAttemptStatus(attempt.status))) {
      throw new Error('Job cannot be cancelled while an Attempt may still be executing');
    }
    if (await this.hasUncertainDispatch(attempts)) {
      throw new Error('Job cannot be cancelled while a Dispatch is uncertain');
    }
    await this.lifecycle.cancelJob(escalation.jobId);
    const timestamp = this.now().toISOString();
    await this.store.resolveEscalation(escalation.id, timestamp);
    const run = await this.requireOperatorRun(escalation.jobId);
    if (run.status !== 'needs_human') throw new Error(`Operator Run ${run.id} is ${run.status}`);
    const cancelled: DurableOperatorRun = {
      ...run,
      status: 'cancelled',
      revision: run.revision + 1,
      updatedAt: timestamp,
      finishedAt: timestamp,
    };
    await this.store.saveOperatorRunTransition(cancelled, run.revision);
    return toRunSession(cancelled);
  }

  async reconcileTimedOutExecution(escalationId: string): Promise<OperatorRunSession> {
    const id = required(escalationId, 'Escalation ID');
    const escalation = await this.store.getEscalation(id);
    if (!escalation) throw new Error(`Escalation not found: ${id}`);
    const existingRun = await this.requireOperatorRun(escalation.jobId);
    if (escalation.resolvedAt) return toRunSession(existingRun);
    if (!isRecoverableObservationEscalation(escalation)) {
      throw new Error(`Escalation ${id} is not a recoverable execution observation failure`);
    }
    if (existingRun.status !== 'needs_human') {
      throw new Error(`Operator Run ${existingRun.id} is ${existingRun.status}`);
    }
    const result = await this.orchestration.reconcileTimedOutExecution(escalation.id);
    if (result.status === 'still-running' || result.status === 'unresolved') {
      return {
        ...toRunSession(existingRun),
        message: result.message,
      };
    }
    const timestamp = this.now().toISOString();
    if (result.status === 'completed') {
      const reconciledAttempt = await this.store.getAttempt(result.attemptId);
      if (!reconciledAttempt) throw new Error(`Attempt not found: ${result.attemptId}`);
      if (reconciledAttempt.executionRole === 'reviewer') {
        const parsed = parseReviewerResult(result.resultText);
        const attempts = await this.store.listAttemptsForJob(escalation.jobId);
        const worker = attempts.find(candidate => candidate.executionRole === 'worker'
          && candidate.roleSequence === reconciledAttempt.roleSequence);
        if (!worker) {
          throw new Error(`Reviewer Attempt ${reconciledAttempt.id} has no matching Worker Attempt`);
        }
        const reviews = await this.store.listAttemptReviewsForJob(escalation.jobId);
        let review = reviews.find(candidate => candidate.reviewerAttemptId === reconciledAttempt.id);
        if (!review) {
          review = {
            id: createAttemptReviewId(),
            jobId: escalation.jobId,
            workerAttemptId: worker.id,
            reviewerAttemptId: reconciledAttempt.id,
            reviewerRuntimeAgentId: reconciledAttempt.runtimeAgentId!,
            decision: parsed.decision,
            summary: parsed.summary,
            ...(parsed.feedback ? { feedback: parsed.feedback } : {}),
            createdAt: timestamp,
          };
          await this.store.createAttemptReview(review);
        }
        if (parsed.decision !== 'PASS') {
          await this.store.resolveEscalationAndCreateEscalation(
            escalation.id,
            timestamp,
            `Resolved by late exact Reviewer completion of existing Dispatch ${result.dispatchId}; no task was resent.`,
            {
              id: this.escalationIdFactory(),
              jobId: escalation.jobId,
              attemptId: worker.id,
              reviewId: review.id,
              reason: 'human_judgment_required',
              summary: parsed.decision === 'REVISION_REQUIRED'
                ? `Reviewer requested revision after late exact reconciliation: ${parsed.feedback ?? parsed.summary}`
                : parsed.feedback ?? parsed.summary,
              createdAt: timestamp,
            },
          );
          return toRunSession(existingRun);
        }
      }
      const pending: DurableOperatorRun = {
        ...existingRun,
        status: 'pending',
        failureMessage: undefined,
        revision: existingRun.revision + 1,
        updatedAt: timestamp,
        startedAt: undefined,
        finishedAt: undefined,
      };
      await this.store.resolveEscalationAndResumeOperatorRun(
        escalation.id,
        timestamp,
        `Resolved by late exact completion of existing Dispatch ${result.dispatchId}; no task was resent.`,
        pending,
        existingRun.revision,
      );
      void this.runner.wake();
      return toRunSession(pending);
    }
    if (result.status !== 'failed') throw new Error(`Unsupported reconciliation status: ${result.status}`);
    await this.store.resolveEscalationAndCreateEscalation(
      escalation.id,
      timestamp,
      `Resolved by exact late failure evidence for existing Dispatch ${result.dispatchId}; no task was resent.`,
      {
        id: this.escalationIdFactory(),
        jobId: escalation.jobId,
        attemptId: result.attemptId,
        reason: 'runtime_failure',
        summary: `The timed-out accepted execution later reported failure: ${result.reason}`,
        createdAt: timestamp,
      },
    );
    void this.runner.wake();
    return toRunSession(existingRun);
  }

  async listJobs(filter: OperatorJobList = 'all'): Promise<readonly OperatorJobSummary[]> {
    const jobs = await this.store.listJobs();
    const summaries = await Promise.all(jobs.map(job => this.buildSummary(job)));
    return summaries
      .filter(summary => matchesFilter(summary, filter))
      .sort((left, right) => right.job.createdAt.localeCompare(left.job.createdAt));
  }

  async retireJob(jobId: string, input: {
    readonly disposition: JobRetirementDisposition;
    readonly reason: string;
    readonly evidenceReference?: string;
    readonly actor: string;
  }): Promise<DurableJobRetirement> {
    if (!this.jobRetirement) throw new Error('Job retirement is not configured');
    return this.jobRetirement.retire({ jobId, ...input });
  }

  async listRepositoryRestoreActions(): Promise<readonly DurableRepositoryRestoreAction[]> {
    return this.store.listRepositoryRestoreActions();
  }

  async prepareRepositoryRestore(input: Parameters<RepositoryRestoreService['prepare']>[0]): Promise<DurableRepositoryRestoreAction> {
    if (!this.repositoryRestore) throw new Error('Repository Restore is not configured');
    return this.repositoryRestore.prepare(input);
  }

  async approveAndExecuteRepositoryRestore(id: string, approvedBy: string): Promise<DurableRepositoryRestoreAction> {
    if (!this.repositoryRestore) throw new Error('Repository Restore is not configured');
    return this.repositoryRestore.approveAndExecute(id, approvedBy);
  }

  async getJobDetail(jobId: string): Promise<OperatorJobDetail> {
    const job = await this.store.getJob(required(jobId, 'Job ID'));
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const summary = await this.buildSummary(job);
    const attempts = await this.store.listAttemptsForJob(job.id);
    const reviews = await this.store.listAttemptReviewsForJob(job.id);
    const escalations = await this.store.listEscalations(job.id);
    const guidance = await this.store.listHumanGuidance(job.id);
    const workerBudgetExtensions = await this.store.listWorkerBudgetExtensions(job.id);
    const notificationDeliveries = await this.store.listOperatorNotificationDeliveries(job.id);
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
    const repositoryWorkspace = await this.store.getRepositoryWorkspaceForJob(job.id);
    const browserEvidenceRequirement = await this.store.getJobBrowserEvidenceRequirement(job.id);
    const previewSession = await this.store.getPreviewSessionForJob(job.id);
    const previewProfile = previewSession ? await this.store.getPreviewProfile(previewSession.profileId) : null;
    const browserEvidence = await this.store.listBrowserEvidenceForJob(job.id);
    const authenticatedPreviewSession = [...await this.store.listAuthenticatedPreviewSessions(job.projectId)]
      .reverse().find(session => !previewProfile || session.previewProfileId === previewProfile.id);
    const inputs = (await Promise.all((await this.store.listJobInputIds(job.id)).map(id => this.store.getInput(id))))
      .filter(value => value !== null)
      .map(value => ({
        id: value.id, displayName: value.displayName, mimeType: value.mimeType,
        byteSize: value.byteSize, sha256: value.sha256, sourceType: value.sourceType,
        ...(value.originalUrl ? { originalUrl: value.originalUrl } : {}),
        ...(value.finalUrl ? { finalUrl: value.finalUrl } : {}),
        ...(value.projectId ? { projectId: value.projectId } : {}),
        createdAt: value.createdAt,
      }));
    const escalationActions = Object.fromEntries(await Promise.all(escalations.map(async escalation => [
      escalation.id,
      await this.actionsForEscalation(escalation, attempts),
    ])));
    const escalationKinds = Object.fromEntries(escalations.map(escalation => [
      escalation.id,
      classifyEscalation(escalation, escalationActions[escalation.id] ?? []),
    ]));
    const retirementAssessment = this.jobRetirement
      ? await this.jobRetirement.assess(job.id)
      : { safe: false, reasons: ['Job retirement is not configured'] };
    return {
      summary,
      acceptanceCriteria: job.acceptanceCriteria ?? '',
      workerAttempts,
      reviewerAttempts,
      reviews,
      escalations,
      guidance,
      workerBudgetExtensions,
      notificationDeliveries,
      inputs,
      escalationActions,
      escalationKinds,
      retirementAllowed: retirementAssessment.safe && summary.retirement === null,
      retirementReasons: retirementAssessment.reasons,
      ...(finalWorkerResult ? { finalWorkerResult } : {}),
      ...(finalReview ? { finalReview } : {}),
      ...(job.status === 'completed' ? { completedAt: job.updatedAt } : {}),
      ...(repositoryWorkspace ? { repositoryWorkspace } : {}),
      ...(browserEvidenceRequirement ? { browserEvidenceRequirement } : {}),
      ...(previewSession ? { previewSession } : {}),
      ...(previewProfile ? { previewProfile } : {}),
      ...(browserEvidence.length ? { browserEvidence } : {}),
      ...(authenticatedPreviewSession ? { authenticatedPreviewSession } : {}),
    };
  }

  private async buildSummary(job: DurableJob): Promise<OperatorJobSummary> {
    const project = await this.store.getProject(job.projectId);
    const repository = job.repositoryId ? await this.store.getRepository(job.repositoryId) : null;
    const attempts = await this.store.listAttemptsForJob(job.id);
    const reviews = await this.store.listAttemptReviewsForJob(job.id);
    const unresolved = await this.store.listEscalations(job.id, true);
    const latestAttempt = attempts.at(-1) ?? null;
    const activeAttempt = [...attempts].reverse().find(attempt => isActiveAttemptStatus(attempt.status));
    const operatorRun = await this.store.getOperatorRunForJob(job.id);
    const workerMaximum = await this.workerMaximumForJob(job.id);
    const workerBudget = await readWorkerExecutionBudget(
      this.store,
      attempts,
      workerMaximum,
    );
    const currentRole = activeAttempt?.executionRole ?? null;
    const retirement = await this.store.getJobRetirement(job.id);
    const currentStage = retirement
      ? 'Archived' as const
      : await this.deriveStage(job, attempts, reviews, unresolved, operatorRun);
    const startedAt = operatorRun?.startedAt;
    const finishedAt = operatorRun?.finishedAt;
    return {
      job,
      projectName: project?.name ?? job.projectId,
      repositoryName: repository?.name ?? job.repositoryId ?? 'No repository',
      latestAttempt,
      currentRole,
      orchestrationState: currentStage,
      workerAttemptCount: attempts.filter(attempt => attempt.executionRole === 'worker').length,
      workerExecutionCount: workerBudget.consumed,
      automaticWorkerExecutionLimit: workerMaximum,
      humanWorkerBudgetExtensionCount: workerBudget.humanExtensions.length,
      authorizedWorkerExecutionLimit: workerBudget.authorizedMaximum,
      latestReviewDecision: reviews.at(-1)?.decision ?? null,
      needsHuman: unresolved.length > 0,
      operatorRun,
      currentStage,
      retirement,
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(startedAt ? { durationMs: Math.max(0, new Date(finishedAt ?? this.now()).getTime() - new Date(startedAt).getTime()) } : {}),
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

  private async deriveStage(
    job: DurableJob,
    attempts: readonly DurableJobAttempt[],
    reviews: readonly { readonly decision: string; readonly workerAttemptId: string }[],
    unresolved: readonly DurableEscalation[],
    run: DurableOperatorRun | null,
  ): Promise<OperatorExecutionStage> {
    const needsHuman = unresolved.length > 0;
    const workspace = await this.store.getRepositoryWorkspaceForJob(job.id);
    if (workspace?.state === 'ready_for_approval'
      && unresolved.some(escalation => escalation.reason === 'human_judgment_required'
        && escalation.summary.startsWith('Ready for Approval.'))) return 'Ready for Approval';
    if (needsHuman || run?.status === 'needs_human') return 'Needs Me';
    if (job.status === 'completed' || run?.status === 'completed') return 'Completed';
    if (job.status === 'cancelled' || run?.status === 'cancelled') return 'Cancelled';
    if (run?.status === 'failed') return 'Failed';
    if (run?.status === 'pending') return 'Accepted';
    const active = [...attempts].reverse().find(attempt => isActiveAttemptStatus(attempt.status));
    if (active) {
      const workerBudget = await readWorkerExecutionBudget(
        this.store,
        attempts,
        await this.workerMaximumForJob(job.id),
      );
      const plan = await this.store.getExecutionPlanForAttempt(active.id);
      if (!plan) {
        return active.executionRole === 'reviewer'
          ? 'Preparing Reviewer'
          : workerBudget.consumed > 0 ? 'Preparing Revision' : 'Preparing Worker';
      }
      const dispatch = await this.store.getExecutionDispatchForPlan(plan.id);
      if (!dispatch || dispatch.status === 'prepared') {
        return active.executionRole === 'reviewer'
          ? 'Preparing Reviewer'
          : workerBudget.consumed > 0 ? 'Preparing Revision' : 'Preparing Worker';
      }
      if (dispatch.status === 'accepted') {
        const observations = await this.store.listExecutionObservationsForDispatch(dispatch.id);
        const providerRunning = observations.some(observation => observation.kind === 'runtime-running')
          && !observations.some(isExactCompletionObservation);
        if (active.executionRole === 'reviewer') {
          return providerRunning ? 'Executing Reviewer' : 'Capturing Review';
        }
        return providerRunning ? 'Executing Worker' : 'Capturing Worker Result';
      }
    }
    const workers = attempts.filter(attempt => attempt.executionRole === 'worker');
    const latestWorker = workers.at(-1);
    const latestReview = latestWorker
      ? reviews.find(review => review.workerAttemptId === latestWorker.id)
      : undefined;
    if (latestReview?.decision === 'REVISION_REQUIRED') return 'Preparing Revision';
    if (latestWorker?.status === 'completed' && !latestReview) return 'Preparing Reviewer';
    return run ? 'Accepted' : job.status === 'draft' ? 'Accepted' : 'Preparing Worker';
  }

  private async actionsForEscalation(
    escalation: Awaited<ReturnType<AgentOperationsStateStore['getEscalation']>> & {},
    attempts: readonly DurableJobAttempt[],
  ): Promise<readonly OperatorEscalationAction[]> {
    if (escalation.resolvedAt) return [];
    if (isRecoverableObservationEscalation(escalation) && escalation.attemptId) {
      const attempt = attempts.find(candidate => candidate.id === escalation.attemptId);
      const plan = attempt ? await this.store.getExecutionPlanForAttempt(attempt.id) : null;
      const dispatch = plan ? await this.store.getExecutionDispatchForPlan(plan.id) : null;
      const outcome = attempt ? await this.store.getAttemptOutcomeDecision(attempt.id) : null;
      if (attempt
        && (attempt.status === 'running' || outcome !== null)
        && dispatch?.status === 'accepted'
        && Boolean(dispatch.externalReference)) return ['reconcile-execution'];
      return [];
    }
    if (attempts.some(attempt => isActiveAttemptStatus(attempt.status))
      || await this.hasUncertainDispatch(attempts)) return [];
    const actions: OperatorEscalationAction[] = [];
    const workerBudget = await readWorkerExecutionBudget(
      this.store,
      attempts,
      await this.workerMaximumForJob(escalation.jobId),
    );
    if (workerBudget.exhausted
      && await this.allowsWorkerBudgetExtension(escalation, attempts)) {
      actions.push('authorize-worker-budget-extension');
    } else if (await this.allowsGuidedContinuation(escalation, attempts)
      && !workerBudget.exhausted) {
      actions.push('provide-guidance');
    }
    const job = await this.store.getJob(escalation.jobId);
    if (job?.status === 'ready') actions.push('cancel-job');
    return actions;
  }

  private async allowsGuidedContinuation(
    escalation: Awaited<ReturnType<AgentOperationsStateStore['getEscalation']>> & {},
    attempts: readonly DurableJobAttempt[],
  ): Promise<boolean> {
    if (escalation.reason === 'human_judgment_required') {
      return !escalation.summary.startsWith('Ready for Approval.');
    }
    if (escalation.reason === 'reviewer_uncertain') return true;
    if (escalation.reason !== 'policy_blocked' || !escalation.attemptId) return false;
    const attempt = attempts.find(candidate => candidate.id === escalation.attemptId);
    if (!attempt || attempt.executionRole !== 'worker' || attempt.status !== 'cancelled') return false;
    const plan = await this.store.getExecutionPlanForAttempt(attempt.id);
    if (!plan) return false;
    return await this.store.getExecutionDispatchForPlan(plan.id) === null;
  }

  private async allowsWorkerBudgetExtension(
    escalation: Awaited<ReturnType<AgentOperationsStateStore['getEscalation']>> & {},
    attempts: readonly DurableJobAttempt[],
  ): Promise<boolean> {
    if (!escalation.attemptId || !escalation.reviewId) return false;
    const attempt = attempts.find(candidate => candidate.id === escalation.attemptId);
    if (!attempt || attempt.executionRole !== 'worker' || attempt.status !== 'completed') return false;
    const review = await this.store.getAttemptReviewForWorkerAttempt(attempt.id);
    return review?.id === escalation.reviewId && review.decision === 'REVISION_REQUIRED';
  }

  private async hasUncertainDispatch(attempts: readonly DurableJobAttempt[]): Promise<boolean> {
    for (const attempt of attempts) {
      const plan = await this.store.getExecutionPlanForAttempt(attempt.id);
      const dispatch = plan ? await this.store.getExecutionDispatchForPlan(plan.id) : null;
      if (dispatch?.status === 'submitting' || dispatch?.status === 'uncertain') return true;
    }
    return false;
  }

  private async requireUnresolvedEscalation(id: string) {
    const escalationId = required(id, 'Escalation ID');
    const escalation = await this.store.getEscalation(escalationId);
    if (!escalation) throw new Error(`Escalation not found: ${escalationId}`);
    if (escalation.resolvedAt) throw new Error(`Escalation ${escalationId} is already resolved`);
    return escalation;
  }

  private async requireOperatorRun(jobId: string): Promise<DurableOperatorRun> {
    const run = await this.store.getOperatorRunForJob(jobId);
    if (!run) throw new Error(`Operator Run not found for Job: ${jobId}`);
    return run;
  }

  private async workerMaximumForJob(jobId: string): Promise<number> {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const trust = await this.trustProfiles.effectiveForJob(job.id);
    return workerMaximumForPolicy(trust.policy, executionModeForJob(job));
  }

  private async reconcileMachineResolvableRuns(): Promise<void> {
    for (const run of await this.store.listOperatorRuns()) {
      if (run.status !== 'needs_human') continue;
      const trust = await this.trustProfiles.effectiveForJob(run.jobId);
      const job = await this.store.getJob(run.jobId);
      if (!job || !canAutonomouslyPerformRiskTier(
        trust.policy,
        riskTierForExecutionMode(executionModeForJob(job)),
      )) continue;
      const escalations = await this.store.listEscalations(run.jobId, true);
      for (const escalation of escalations) {
        if (classifyEscalationResolution(escalation) !== 'machine-resolvable') continue;
        if (isRecoverableObservationEscalation(escalation)) {
          await this.reconcileTimedOutExecution(escalation.id);
          continue;
        }
        if (isRecoverableRuntimeCapacityEscalation(escalation) && this.runtimeFreshness) {
          await this.reconcileRuntimeCapacityEscalation(run, escalation);
        }
      }
    }
  }

  private async reconcileRuntimeCapacityEscalation(
    run: DurableOperatorRun,
    escalation: DurableEscalation,
  ): Promise<void> {
    const job = await this.store.getJob(run.jobId);
    if (!job || run.status !== 'needs_human') return;
    if (!job.preferredRuntimeAgentId) return;
    if (escalation.reason === 'runtime_failure') {
      const attempt = escalation.attemptId
        ? await this.store.getAttempt(escalation.attemptId) : null;
      const plan = attempt ? await this.store.getExecutionPlanForAttempt(attempt.id) : null;
      const dispatch = plan ? await this.store.getExecutionDispatchForPlan(plan.id) : null;
      if (attempt?.status !== 'cancelled' || dispatch) return;
    }
    const attempts = await this.store.listAttemptsForJob(job.id);
    if (attempts.some(attempt => isActiveAttemptStatus(attempt.status))
      || await this.hasUncertainDispatch(attempts)) return;
    const readiness = await this.runtimeFreshness!.ensureExecutionAgentForJob(
      job.id,
      job.preferredRuntimeAgentId,
    );
    const timestamp = this.now().toISOString();
    if (readiness.state !== 'ready') {
      await this.store.resolveEscalationAndCreateEscalation(
        escalation.id,
        timestamp,
        'Daily Driver attempted bounded Worker runtime recovery and stopped safely.',
        {
          id: this.escalationIdFactory(),
          jobId: job.id,
          reason: 'runtime_failure',
          summary: `Worker runtime recovery failed: ${readiness.message}`,
          createdAt: timestamp,
        },
      );
      return;
    }
    const currentRun = await this.store.getOperatorRunForJob(job.id);
    if (!currentRun || currentRun.status !== 'needs_human') return;
    const pending: DurableOperatorRun = {
      ...currentRun,
      status: 'pending',
      failureMessage: undefined,
      revision: currentRun.revision + 1,
      updatedAt: timestamp,
      startedAt: undefined,
      finishedAt: undefined,
    };
    await this.store.resolveEscalationAndResumeOperatorRun(
      escalation.id,
      timestamp,
      `Daily Driver recovered and verified runtime ${job.preferredRuntimeAgentId}; no Dispatch was resent.`,
      pending,
      currentRun.revision,
    );
  }
}

function validateBrowserEvidenceRequirement(requirement: import('../../agent-operations-contracts/src/index.js').BrowserEvidenceRequirement): void {
  if (requirement.kind !== 'browser-render' || !/^\/(?!\/)/.test(requirement.route)
    || requirement.route.includes('://') || requirement.route.includes('\0')
    || !Number.isInteger(requirement.viewport.width) || requirement.viewport.width < 320
    || requirement.viewport.width > 2_560 || !Number.isInteger(requirement.viewport.height)
    || requirement.viewport.height < 240 || requirement.viewport.height > 2_560) {
    throw new Error('Browser render evidence requirement is invalid');
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

function isRecoverableObservationEscalation(
  escalation: { reason: string; summary: string },
): boolean {
  return escalation.reason === 'observation_timeout'
    || (escalation.reason === 'runtime_failure'
      && escalation.summary.startsWith('Runtime observation failed:'));
}

function isRecoverableRuntimeCapacityEscalation(
  escalation: { reason: string; summary: string },
): boolean {
  return (escalation.reason === 'policy_blocked'
      && /runtime-disabled|runtime-stopped/i.test(escalation.summary))
    || (escalation.reason === 'runtime_failure'
      && /^Worker Attempt \d+ ended cancelled without a resumable result\.$/.test(escalation.summary));
}

function classifyEscalation(
  escalation: DurableEscalation,
  actions: readonly OperatorEscalationAction[],
): OperatorEscalationKind {
  if (escalation.reason === 'human_judgment_required'
    && escalation.summary.startsWith('Ready for Approval.')) return 'human-approval';
  if (actions.includes('authorize-worker-budget-extension')) return 'budget-extension-required';
  if (actions.includes('provide-guidance')) return 'guidance-required';
  if (actions.includes('reconcile-execution')) return 'actionable-continuation';
  return 'terminal';
}

function taskTitle(task: string): string {
  const firstLine = task.split(/\r?\n/, 1)[0].trim();
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 97)}…`;
}

function matchesFilter(summary: OperatorJobSummary, filter: OperatorJobList): boolean {
  if (filter === 'retired') return Boolean(summary.retirement);
  if (summary.retirement) return false;
  if (filter === 'all') return true;
  if (filter === 'needs-human') return summary.needsHuman;
  if (filter === 'done') return summary.job.status === 'completed';
  return summary.operatorRun?.status === 'pending' || summary.operatorRun?.status === 'running'
    || summary.currentRole !== null;
}

function toRunSession(run: DurableOperatorRun): OperatorRunSession {
  const status: OperatorRunSession['status'] = run.status === 'completed'
    ? 'done'
    : run.status === 'needs_human' ? 'needs-human' : run.status;
  return {
    jobId: run.jobId,
    status,
    startedAt: run.startedAt ?? run.createdAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.failureMessage ? { message: run.failureMessage } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
