import type {
  AgentOperationsStateStore,
  AgentRuntimeAdapter,
  AttemptReviewDecision,
  DurableAttemptReview,
  DurableEscalation,
  DurableExecutionDispatch,
  DurableExecutionObservation,
  DurableExecutionPlan,
  DurableJob,
  DurableJobAttempt,
  EscalationReason,
  NeedsHumanItem,
  RepositoryInventoryAdapter,
  RuntimeExecutionAdapter,
  RuntimeExecutionObservationAdapter,
  DurableRepositoryWorkspace,
  RuntimeExecutionPolicy,
  RuntimeExecutionCapabilities,
  WorkspaceTestResult,
} from '../../agent-operations-contracts/src/index.js';
import {
  EXECUTION_RESULT_MAX_CHARS,
  REPOSITORY_READ_EXECUTION_CAPABILITIES,
  RESTRICTED_TEXT_EXECUTION_POLICY,
  REPOSITORY_WRITE_EXECUTION_CAPABILITIES,
  REPOSITORY_WRITE_REVIEW_EXECUTION_CAPABILITIES,
  createAttemptOutcomeDecisionId,
  createAttemptReviewId,
  createEscalationId,
  isBoundedExecutionResult,
  isExactCompletionObservation,
  executionModeForJob,
} from '../../agent-operations-contracts/src/index.js';
import { ExecutionObservationService, type AttemptExecutionDetail } from './execution-observation-service.js';
import { ExecutionPlanningService } from './execution-planning-service.js';
import { ExecutionPreflightService } from './execution-preflight-service.js';
import { JobLifecycleService } from './job-lifecycle-service.js';
import { ManualDispatchService, type ManualDispatchOutcome } from './manual-dispatch-service.js';
import { readWorkerExecutionBudget } from './worker-execution-budget.js';
import type { RepositoryWorkspaceService } from './repository-workspace-service.js';

export const MVP_MAX_WORKER_ATTEMPTS = 2;
export const MVP_MAX_REVIEWER_PASSES_PER_ATTEMPT = 1;
export const MVP_OBSERVATION_TIMEOUT_MS = 5 * 60_000;

export interface OrchestrationServiceOptions {
  readonly now?: () => Date;
  readonly workerRuntimeAgentId?: string;
  readonly reviewerRuntimeAgentId?: string;
  readonly observationIntervalMs?: number;
  readonly observationTimeoutMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly attemptReviewIdFactory?: () => string;
  readonly escalationIdFactory?: () => string;
  readonly outcomeDecisionIdFactory?: () => string;
  readonly workspaceService?: RepositoryWorkspaceService;
}

export interface OrchestrationPreview {
  readonly job: DurableJob;
  readonly repositoryId: string | null;
  readonly workerRuntimeAgentId: string | null;
  readonly reviewerRuntimeAgentId: string | null;
  readonly policy: RuntimeExecutionPolicy;
  readonly capabilities?: RuntimeExecutionCapabilities;
  readonly executionMode?: 'repository-read-only' | 'repository-write-isolated';
  readonly repositoryRead: true;
  readonly maxWorkerAttempts: 2;
  readonly maxReviewerPassesPerAttempt: 1;
  readonly autoCompleteAllowed: boolean;
  readonly escalationEnabled: true;
  readonly executionAuthorized: false;
  readonly eligible: boolean;
  readonly findings: readonly string[];
}

export interface OrchestrationReadModel {
  readonly job: DurableJob;
  readonly workerAttempts: readonly DurableJobAttempt[];
  readonly reviewerAttempts: readonly DurableJobAttempt[];
  readonly reviews: readonly DurableAttemptReview[];
  readonly escalations: readonly DurableEscalation[];
  readonly needsHuman: boolean;
  readonly finalDecision: 'PASS' | 'ESCALATED';
}

export type TimedOutExecutionReconciliation =
  | {
      readonly status: 'completed';
      readonly jobId: string;
      readonly attemptId: string;
      readonly dispatchId: string;
      readonly resultText: string;
      readonly inserted: number;
      readonly duplicates: number;
      readonly ignoredUnrelated: number;
      readonly alreadyReconciled: boolean;
    }
  | {
      readonly status: 'failed';
      readonly jobId: string;
      readonly attemptId: string;
      readonly dispatchId: string;
      readonly reason: string;
      readonly inserted: number;
      readonly duplicates: number;
      readonly ignoredUnrelated: number;
      readonly alreadyReconciled: boolean;
    }
  | {
      readonly status: 'still-running' | 'unresolved';
      readonly jobId: string;
      readonly attemptId: string;
      readonly dispatchId: string;
      readonly message: string;
      readonly inserted: number;
      readonly duplicates: number;
      readonly ignoredUnrelated: number;
    };

interface ExactExecutionResult {
  readonly detail: AttemptExecutionDetail;
  readonly evidence: DurableExecutionObservation;
  readonly resultText: string;
}

type ObservationResolution =
  | { readonly status: 'completed'; readonly execution: ExactExecutionResult }
  | { readonly status: 'escalate'; readonly reason: EscalationReason; readonly summary: string };

interface ParsedReviewerResult {
  readonly decision: AttemptReviewDecision;
  readonly summary: string;
  readonly feedback?: string;
}

/**
 * Explicit, one-Job, synchronous MVP orchestrator. AO owns every durable state
 * transition; the provider supplies only bounded Worker and Reviewer results.
 */
export class OrchestrationService {
  private readonly now: () => Date;
  private readonly lifecycle: JobLifecycleService;
  private readonly planning: ExecutionPlanningService;
  private readonly dispatch: ManualDispatchService;
  private readonly observations: ExecutionObservationService;
  private readonly workerRuntimeAgentId?: string;
  private readonly reviewerRuntimeAgentId?: string;
  private readonly observationIntervalMs: number;
  private readonly observationTimeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly attemptReviewIdFactory: () => string;
  private readonly escalationIdFactory: () => string;
  private readonly outcomeDecisionIdFactory: () => string;
  private readonly workspaceService?: RepositoryWorkspaceService;

  constructor(
    private readonly store: AgentOperationsStateStore,
    runtimes: AgentRuntimeAdapter,
    repositories: RepositoryInventoryAdapter,
    execution: RuntimeExecutionAdapter,
    observer: RuntimeExecutionObservationAdapter,
    options: OrchestrationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.lifecycle = new JobLifecycleService(store, { now: this.now });
    this.planning = new ExecutionPlanningService(store, { now: this.now });
    const preflight = new ExecutionPreflightService(store, runtimes, repositories, this.now, {
      requireExactTurnCorrelation: true,
    });
    this.dispatch = new ManualDispatchService(store, preflight, execution, { now: this.now });
    this.observations = new ExecutionObservationService(store, observer, this.now);
    this.workerRuntimeAgentId = cleanOptional(options.workerRuntimeAgentId);
    this.reviewerRuntimeAgentId = cleanOptional(options.reviewerRuntimeAgentId);
    this.observationIntervalMs = boundedDuration(options.observationIntervalMs ?? 1_000, 'Observation interval');
    this.observationTimeoutMs = boundedDuration(
      options.observationTimeoutMs ?? MVP_OBSERVATION_TIMEOUT_MS,
      'Observation timeout',
    );
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.attemptReviewIdFactory = options.attemptReviewIdFactory ?? (() => createAttemptReviewId());
    this.escalationIdFactory = options.escalationIdFactory ?? (() => createEscalationId());
    this.outcomeDecisionIdFactory = options.outcomeDecisionIdFactory
      ?? (() => createAttemptOutcomeDecisionId());
    this.workspaceService = options.workspaceService;
  }

  async preview(jobId: string): Promise<OrchestrationPreview> {
    const job = await this.requireJob(jobId);
    const workerRuntimeAgentId = this.workerRuntimeAgentId ?? job.preferredRuntimeAgentId ?? null;
    const reviewerRuntimeAgentId = this.reviewerRuntimeAgentId ?? job.preferredRuntimeAgentId ?? null;
    const findings = await this.eligibilityFindings(job, workerRuntimeAgentId, reviewerRuntimeAgentId);
    const writeMode = executionModeForJob(job) === 'repository-write-isolated';
    const hasInputs = (await this.store.listJobInputIds(job.id)).length > 0;
    return {
      job,
      repositoryId: job.repositoryId ?? null,
      workerRuntimeAgentId,
      reviewerRuntimeAgentId,
      policy: writeMode
        ? { version: 1, filesystem: 'workspace-write', network: 'deny', environment: 'empty' }
        : { ...RESTRICTED_TEXT_EXECUTION_POLICY },
      capabilities: writeMode
        ? { ...REPOSITORY_WRITE_EXECUTION_CAPABILITIES, ...(hasInputs ? { inputRead: true } : {}) }
        : { ...REPOSITORY_READ_EXECUTION_CAPABILITIES, ...(hasInputs ? { inputRead: true } : {}) },
      executionMode: executionModeForJob(job),
      repositoryRead: true,
      maxWorkerAttempts: MVP_MAX_WORKER_ATTEMPTS,
      maxReviewerPassesPerAttempt: MVP_MAX_REVIEWER_PASSES_PER_ATTEMPT,
      autoCompleteAllowed: !writeMode && job.automaticReadOnlyCompletion === true,
      escalationEnabled: true,
      executionAuthorized: false,
      eligible: findings.length === 0,
      findings,
    };
  }

  async runJob(jobId: string): Promise<OrchestrationReadModel> {
    const initialJob = await this.requireJob(jobId);
    if (initialJob.status === 'completed') return this.readModel(initialJob.id, 'PASS');
    if ((await this.store.listEscalations(initialJob.id, true)).length > 0) {
      return this.readModel(initialJob.id, 'ESCALATED');
    }
    const workerRuntimeAgentId = this.workerRuntimeAgentId ?? initialJob.preferredRuntimeAgentId ?? null;
    const reviewerRuntimeAgentId = this.reviewerRuntimeAgentId ?? initialJob.preferredRuntimeAgentId ?? null;
    const findings = await this.continuationEligibilityFindings(
      initialJob,
      workerRuntimeAgentId,
      reviewerRuntimeAgentId,
    );
    if (findings.length || !workerRuntimeAgentId || !reviewerRuntimeAgentId) {
      await this.escalate(
        initialJob.id,
        'policy_blocked',
        `Job is not eligible for autonomous read-only orchestration: ${findings.join('; ')}`,
      );
      return this.readModel(initialJob.id, 'ESCALATED');
    }

    if (executionModeForJob(initialJob) === 'repository-write-isolated') {
      try {
        await this.ensureWriteWorkspace(initialJob);
      } catch (error) {
        await this.escalate(
          initialJob.id,
          'policy_blocked',
          `Isolated Repository Workspace preparation failed before Dispatch: ${message(error)}`,
        );
        return this.readModel(initialJob.id, 'ESCALATED');
      }
    }

    for (;;) {
      const job = await this.requireJob(initialJob.id);
      if (job.status === 'completed') return this.readModel(job.id, 'PASS');
      if ((await this.store.listEscalations(job.id, true)).length > 0) {
        return this.readModel(job.id, 'ESCALATED');
      }
      const attempts = await this.store.listAttemptsForJob(job.id);
      const active = attempts.filter(attempt => attempt.status === 'created' || attempt.status === 'running');
      if (active.length > 1) {
        await this.escalate(job.id, 'runtime_failure', 'Multiple active Attempts require human reconciliation.');
        return this.readModel(job.id, 'ESCALATED');
      }
      if (active[0]) {
        const run = await this.resumeActiveAttempt(job, active[0]);
        if (run.status === 'escalate') {
          await this.escalate(job.id, run.reason, run.summary, active[0].id);
          return this.readModel(job.id, 'ESCALATED');
        }
        continue;
      }

      const workers = attempts.filter(attempt => attempt.executionRole === 'worker');
      const workerBudget = await readWorkerExecutionBudget(
        this.store,
        attempts,
        MVP_MAX_WORKER_ATTEMPTS,
      );
      const reviewers = attempts.filter(attempt => attempt.executionRole === 'reviewer');
      const latestWorker = workers.at(-1);
      if (!latestWorker) {
        await this.lifecycle.createAttempt(job.id, {
          runtimeAgentId: workerRuntimeAgentId,
          executionRole: 'worker',
        });
        continue;
      }
      if (latestWorker.status !== 'completed') {
        const guidance = await this.policyBlockedGuidanceFor(job.id, latestWorker.id);
        if (latestWorker.status === 'cancelled' && guidance
          && !workerBudget.exhausted) {
          await this.lifecycle.createAttempt(job.id, {
            runtimeAgentId: workerRuntimeAgentId,
            executionRole: 'worker',
          });
          continue;
        }
        await this.escalate(
          job.id,
          'runtime_failure',
          `Worker Attempt ${latestWorker.roleSequence} ended ${latestWorker.status} without a resumable result.`,
          latestWorker.id,
        );
        return this.readModel(job.id, 'ESCALATED');
      }

      const reviews = await this.store.listAttemptReviewsForJob(job.id);
      const review = reviews.find(candidate => candidate.workerAttemptId === latestWorker.id);
      if (review) {
        const reviewer = reviewers.find(candidate => candidate.id === review.reviewerAttemptId);
        if (!reviewer || reviewer.status !== 'completed') {
          await this.escalate(job.id, 'runtime_failure', 'Persisted Review has no completed Reviewer Attempt.', latestWorker.id, review.id);
          return this.readModel(job.id, 'ESCALATED');
        }
        const guidance = await this.guidanceFor(job.id, latestWorker.id, review.id);
        if (review.decision === 'PASS') {
          if (guidance) {
            if (workerBudget.exhausted) {
              await this.escalate(
                job.id,
                'review_failed_after_budget',
                `Worker execution budget of ${MVP_MAX_WORKER_ATTEMPTS} is exhausted.`,
                latestWorker.id,
                review.id,
              );
              return this.readModel(job.id, 'ESCALATED');
            }
            if (executionModeForJob(job) === 'repository-write-isolated') {
              const workspace = await this.store.getRepositoryWorkspaceForJob(job.id);
              if (!workspace || !this.workspaceService) {
                await this.escalate(
                  job.id,
                  'runtime_failure',
                  'Isolated workspace is unavailable for human guided revision.',
                  latestWorker.id,
                  review.id,
                );
                return this.readModel(job.id, 'ESCALATED');
              }
              await this.workspaceService.reopenForRevision(workspace.id);
            }
            await this.lifecycle.createAttempt(job.id, {
              runtimeAgentId: workerRuntimeAgentId,
              executionRole: 'worker',
            });
            continue;
          }
          if (executionModeForJob(job) === 'repository-write-isolated') {
            const workspace = await this.store.getRepositoryWorkspaceForJob(job.id);
            if (!workspace
              || !['reviewing', 'ready_for_approval'].includes(workspace.state)
              || !workspace.evidence
              || !this.workspaceService) {
              await this.escalate(
                job.id,
                'runtime_failure',
                'Reviewer passed, but bounded isolated workspace evidence is unavailable.',
                latestWorker.id,
                review.id,
              );
            } else {
              const ready = workspace.state === 'ready_for_approval'
                ? workspace
                : await this.workspaceService.markReadyForApproval(workspace.id);
              await this.escalate(
                job.id,
                'human_judgment_required',
                `Ready for Approval. Reviewer PASS recorded for isolated branch ${ready.branchName}. Review the bounded diff and test evidence before any commit, merge, or push.`,
                latestWorker.id,
                review.id,
              );
            }
            return this.readModel(job.id, 'ESCALATED');
          }
          const workerExecution = await this.exactExecutionForAttempt(latestWorker.id);
          const reviewerExecution = await this.exactExecutionForAttempt(reviewer.id);
          if (!workerExecution || !reviewerExecution
            || !this.safeAutoCompletionEligible(job, workerExecution, reviewerExecution)) {
            await this.escalate(
              job.id,
              'policy_blocked',
              'Reviewer passed the result, but the narrow read-only auto-completion invariants were not satisfied.',
              latestWorker.id,
              review.id,
            );
            return this.readModel(job.id, 'ESCALATED');
          }
          await this.lifecycle.completeJob(job.id);
          return this.readModel(job.id, 'PASS');
        }

        if (review.decision === 'ESCALATE' && !guidance) {
          await this.escalate(
            job.id,
            'human_judgment_required',
            review.feedback ?? review.summary,
            latestWorker.id,
            review.id,
          );
          return this.readModel(job.id, 'ESCALATED');
        }
        if (review.decision === 'REVISION_REQUIRED'
          && await this.isHumanGuidedWorkerAttempt(job.id, latestWorker)) {
          await this.escalate(
            job.id,
            'human_judgment_required',
            `Reviewer requested revision after the one Worker execution authorized by Human Guidance: ${review.feedback ?? review.summary}`,
            latestWorker.id,
            review.id,
          );
          return this.readModel(job.id, 'ESCALATED');
        }
        if (workerBudget.exhausted) {
          await this.escalate(
            job.id,
            'review_failed_after_budget',
            `Worker execution budget of ${MVP_MAX_WORKER_ATTEMPTS} is exhausted.`,
            latestWorker.id,
            review.id,
          );
          return this.readModel(job.id, 'ESCALATED');
        }
        if (executionModeForJob(job) === 'repository-write-isolated') {
          const workspace = await this.store.getRepositoryWorkspaceForJob(job.id);
          if (!workspace || !this.workspaceService) {
            await this.escalate(job.id, 'runtime_failure', 'Isolated workspace is unavailable for revision.', latestWorker.id, review.id);
            return this.readModel(job.id, 'ESCALATED');
          }
          await this.workspaceService.reopenForRevision(workspace.id);
        }
        await this.lifecycle.createAttempt(job.id, {
          runtimeAgentId: workerRuntimeAgentId,
          executionRole: 'worker',
        });
        continue;
      }

      const reviewedReviewerIds = new Set(reviews.map(candidate => candidate.reviewerAttemptId));
      const reviewer = reviewers.find(candidate => candidate.sequence > latestWorker.sequence
        && !reviewedReviewerIds.has(candidate.id));
      if (!reviewer) {
        if (executionModeForJob(job) === 'repository-write-isolated') {
          try {
            await this.captureWriteEvidence(job, latestWorker.id);
          } catch (error) {
            await this.escalate(
              job.id,
              'runtime_failure',
              `Could not capture isolated workspace evidence for review: ${message(error)}`,
              latestWorker.id,
            );
            return this.readModel(job.id, 'ESCALATED');
          }
        }
        await this.lifecycle.createAttempt(job.id, {
          runtimeAgentId: reviewerRuntimeAgentId,
          executionRole: 'reviewer',
        });
        continue;
      }
      if (reviewer.status !== 'completed') {
        const guidance = await this.guidanceFor(job.id, reviewer.id);
        if (guidance && !workerBudget.exhausted) {
          await this.lifecycle.createAttempt(job.id, {
            runtimeAgentId: workerRuntimeAgentId,
            executionRole: 'worker',
          });
          continue;
        }
        await this.escalate(
          job.id,
          'reviewer_uncertain',
          `Reviewer Attempt ${reviewer.roleSequence} ended ${reviewer.status} without a valid Review.`,
          reviewer.id,
        );
        return this.readModel(job.id, 'ESCALATED');
      }
      const reviewerExecution = await this.exactExecutionForAttempt(reviewer.id);
      if (!reviewerExecution) {
        await this.escalate(job.id, 'exact_correlation_missing', 'Completed Reviewer Attempt has no bounded exact result.', reviewer.id);
        return this.readModel(job.id, 'ESCALATED');
      }
      let parsed: ParsedReviewerResult;
      try {
        parsed = parseReviewerResult(reviewerExecution.resultText);
      } catch (error) {
        await this.escalate(
          job.id,
          'reviewer_uncertain',
          `Reviewer output was not a valid decision contract: ${message(error)}`,
          reviewer.id,
        );
        return this.readModel(job.id, 'ESCALATED');
      }
      await this.store.createAttemptReview({
        id: this.attemptReviewIdFactory(),
        jobId: job.id,
        workerAttemptId: latestWorker.id,
        reviewerAttemptId: reviewer.id,
        reviewerRuntimeAgentId: reviewer.runtimeAgentId!,
        decision: parsed.decision,
        summary: parsed.summary,
        ...(parsed.feedback ? { feedback: parsed.feedback } : {}),
        createdAt: this.now().toISOString(),
      });
    }
  }

  async listNeedsHuman(): Promise<readonly NeedsHumanItem[]> {
    const escalations = await this.store.listEscalations(undefined, true);
    const items: NeedsHumanItem[] = [];
    for (const escalation of escalations) {
      const job = await this.store.getJob(escalation.jobId);
      if (!job) continue;
      const attempts = await this.store.listAttemptsForJob(job.id);
      const reviews = await this.store.listAttemptReviewsForJob(job.id);
      const latestAttempt = attempts.at(-1) ?? null;
      const latestWorkerAttempt = [...attempts]
        .reverse()
        .find(attempt => attempt.executionRole === 'worker') ?? null;
      const latestReview = reviews.at(-1) ?? null;
      const resultText = latestWorkerAttempt
        ? await this.resultForAttempt(latestWorkerAttempt.id)
        : undefined;
      items.push({
        escalation,
        job,
        latestAttempt,
        latestReview,
        ...(resultText ? { resultText } : {}),
      });
    }
    return items;
  }

  /** Re-observes one accepted execution after a recoverable observation failure. */
  async reconcileTimedOutExecution(
    escalationId: string,
  ): Promise<TimedOutExecutionReconciliation> {
    const escalation = await this.store.getEscalation(required(escalationId, 'Escalation ID'));
    if (!escalation) throw new Error(`Escalation not found: ${escalationId}`);
    if (!isRecoverableObservationEscalation(escalation) || !escalation.attemptId) {
      throw new Error(`Escalation ${escalation.id} is not a recoverable execution observation failure`);
    }
    const attempt = await this.store.getAttempt(escalation.attemptId);
    if (!attempt || attempt.jobId !== escalation.jobId || attempt.executionRole !== 'worker') {
      throw new Error(`Escalation ${escalation.id} does not identify its timed-out Worker Attempt`);
    }
    const plan = await this.store.getExecutionPlanForAttempt(attempt.id);
    const dispatch = plan ? await this.store.getExecutionDispatchForPlan(plan.id) : null;
    if (!plan || !dispatch || dispatch.status !== 'accepted' || !dispatch.externalReference) {
      throw new Error(`Escalation ${escalation.id} has no accepted, exactly addressable Dispatch`);
    }
    const existing = await this.store.getAttemptOutcomeDecision(attempt.id);
    if (existing) {
      const observations = await this.store.listExecutionObservationsForDispatch(dispatch.id);
      const evidence = existing.evidenceObservationId
        ? observations.find(candidate => candidate.id === existing.evidenceObservationId)
        : undefined;
      if (!evidence || !await this.trustedLateEvidence(plan, dispatch, evidence)) {
        throw new Error(`Attempt ${attempt.id} has an Outcome Decision without trusted late evidence`);
      }
      if (existing.outcome === 'completed' && isExactCompletionObservation(evidence)
        && evidence.resultText && isBoundedExecutionResult(evidence.resultText)) {
        await this.resolveAttempt(attempt, evidence, 'completed', existing.summary!);
        return {
          status: 'completed', jobId: attempt.jobId, attemptId: attempt.id,
          dispatchId: dispatch.id, resultText: evidence.resultText,
          inserted: 0, duplicates: 0, ignoredUnrelated: 0, alreadyReconciled: true,
        };
      }
      if (existing.outcome === 'failed'
        && (evidence.kind === 'runtime-crashed'
          || (isExactCompletionObservation(evidence)
            && (!evidence.resultText || !isBoundedExecutionResult(evidence.resultText))))) {
        await this.resolveAttempt(attempt, evidence, 'failed', undefined, existing.reason!);
        return {
          status: 'failed', jobId: attempt.jobId, attemptId: attempt.id,
          dispatchId: dispatch.id, reason: existing.reason!,
          inserted: 0, duplicates: 0, ignoredUnrelated: 0, alreadyReconciled: true,
        };
      }
      throw new Error(`Attempt ${attempt.id} has a conflicting late reconciliation outcome`);
    }
    if (escalation.resolvedAt) {
      throw new Error(`Escalation ${escalation.id} is resolved without a reconciled Attempt outcome`);
    }
    if (attempt.status !== 'running') {
      throw new Error(`Timed-out Attempt ${attempt.id} is ${attempt.status}, not running`);
    }

    let observed;
    try {
      observed = await this.observations.observeAttemptExecution(attempt.id);
    } catch (error) {
      return {
        status: 'unresolved', jobId: attempt.jobId, attemptId: attempt.id,
        dispatchId: dispatch.id, message: `The existing execution could not be observed: ${message(error)}`,
        inserted: 0, duplicates: 0, ignoredUnrelated: 0,
      };
    }
    const exactCompletion = observed.detail.observations.find(candidate =>
      isExactCompletionObservation(candidate)
      && candidate.externalReference === dispatch.externalReference);
    if (exactCompletion) {
      if (!await this.trustedLateEvidence(plan, dispatch, exactCompletion)) {
        return {
          status: 'unresolved', jobId: attempt.jobId, attemptId: attempt.id,
          dispatchId: dispatch.id,
          message: 'Late completion evidence did not satisfy the exact repository, policy, and capability boundary.',
          inserted: observed.inserted, duplicates: observed.duplicates,
          ignoredUnrelated: observed.ignoredUnrelated,
        };
      }
      if (!exactCompletion.resultText || !isBoundedExecutionResult(exactCompletion.resultText)) {
        const reason = 'The exact accepted execution terminated without a valid bounded result.';
        await this.resolveAttempt(attempt, exactCompletion, 'failed', undefined, reason);
        return {
          status: 'failed', jobId: attempt.jobId, attemptId: attempt.id,
          dispatchId: dispatch.id, reason,
          inserted: observed.inserted, duplicates: observed.duplicates,
          ignoredUnrelated: observed.ignoredUnrelated, alreadyReconciled: false,
        };
      }
      await this.resolveAttempt(
        attempt,
        exactCompletion,
        'completed',
        'Worker execution completed with a bounded exact result after the observation timeout.',
      );
      return {
        status: 'completed', jobId: attempt.jobId, attemptId: attempt.id,
        dispatchId: dispatch.id, resultText: exactCompletion.resultText,
        inserted: observed.inserted, duplicates: observed.duplicates,
        ignoredUnrelated: observed.ignoredUnrelated, alreadyReconciled: false,
      };
    }
    const exactFailure = observed.detail.observations.find(candidate =>
      candidate.kind === 'runtime-crashed'
      && candidate.correlation === 'exact'
      && candidate.correlatedDispatchId === dispatch.id
      && candidate.externalReference === dispatch.externalReference);
    if (exactFailure) {
      if (!await this.trustedLateEvidence(plan, dispatch, exactFailure)) {
        return {
          status: 'unresolved', jobId: attempt.jobId, attemptId: attempt.id,
          dispatchId: dispatch.id,
          message: 'Late failure evidence did not satisfy the exact repository, policy, and capability boundary.',
          inserted: observed.inserted, duplicates: observed.duplicates,
          ignoredUnrelated: observed.ignoredUnrelated,
        };
      }
      const reason = exactFailure.message ?? 'The exact accepted runtime execution failed after observation timed out.';
      await this.resolveAttempt(attempt, exactFailure, 'failed', undefined, reason);
      return {
        status: 'failed', jobId: attempt.jobId, attemptId: attempt.id,
        dispatchId: dispatch.id, reason,
        inserted: observed.inserted, duplicates: observed.duplicates,
        ignoredUnrelated: observed.ignoredUnrelated, alreadyReconciled: false,
      };
    }
    const stillRunning = observed.detail.observations.some(candidate =>
      candidate.kind === 'runtime-running'
      && (candidate.correlation !== 'exact'
        || candidate.correlatedDispatchId === dispatch.id));
    return {
      status: stillRunning ? 'still-running' : 'unresolved',
      jobId: attempt.jobId,
      attemptId: attempt.id,
      dispatchId: dispatch.id,
      message: stillRunning
        ? 'The existing accepted execution is still running; nothing was resent.'
        : 'No trustworthy terminal evidence exists for the exact accepted execution; nothing was resent.',
      inserted: observed.inserted,
      duplicates: observed.duplicates,
      ignoredUnrelated: observed.ignoredUnrelated,
    };
  }

  private async trustedLateEvidence(
    plan: DurableExecutionPlan,
    dispatch: DurableExecutionDispatch,
    evidence: DurableExecutionObservation,
  ): Promise<boolean> {
    if (!plan.repositoryId || !plan.checkoutBindingId || !plan.requestedPolicy
      || !plan.requestedCapabilities || !dispatch.effectivePolicy
      || !dispatch.effectiveCapabilities || !evidence.executionContext
      || !evidence.effectivePolicy || !evidence.effectiveCapabilities) return false;
    const binding = (await this.store.listCheckoutBindings(plan.repositoryId))
      .find(candidate => candidate.id === plan.checkoutBindingId);
    const workspace = plan.repositoryWorkspaceId
      ? await this.store.getRepositoryWorkspace(plan.repositoryWorkspaceId)
      : null;
    const executionRoot = workspace?.canonicalPath ?? binding?.canonicalPath;
    const workspaceIdentityValid = workspace
      ? workspace.jobId === plan.jobId
        && workspace.repositoryId === plan.repositoryId
        && workspace.sourceCheckoutBindingId === plan.checkoutBindingId
        && ['active', 'reviewing', 'ready_for_approval'].includes(workspace.state)
      : plan.repositoryWorkspaceId === undefined;
    return Boolean(binding)
      && workspaceIdentityValid
      && Boolean(executionRoot)
      && evidence.correlation === 'exact'
      && evidence.correlatedDispatchId === dispatch.id
      && evidence.externalReference === dispatch.externalReference
      && evidence.executionContext.workingDirectory === executionRoot
      && evidence.executionContext.repositoryReadRoot === executionRoot
      && (plan.requestedCapabilities.repositoryPatch === true
        ? evidence.executionContext.repositoryWriteRoot === executionRoot
        : evidence.executionContext.repositoryWriteRoot === undefined)
      && plan.requestedPolicy.filesystem === (workspace ? 'workspace-write' : 'read-only')
      && plan.requestedPolicy.network === 'deny'
      && plan.requestedPolicy.environment === 'empty'
      && samePolicy(plan.requestedPolicy, dispatch.effectivePolicy)
      && samePolicy(plan.requestedPolicy, evidence.effectivePolicy)
      && plan.requestedCapabilities.repositoryRead === true
      && sameCapabilities(plan.requestedCapabilities, dispatch.effectiveCapabilities)
      && sameCapabilities(plan.requestedCapabilities, evidence.effectiveCapabilities);
  }

  private async resumeActiveAttempt(
    job: DurableJob,
    attempt: DurableJobAttempt,
  ): Promise<ObservationResolution> {
    const attempts = await this.store.listAttemptsForJob(job.id);
    const workers = attempts.filter(candidate => candidate.executionRole === 'worker');
    const latestWorker = workers.at(-1);
    const reviews = await this.store.listAttemptReviewsForJob(job.id);
    const latestReview = reviews.at(-1);
    const guidance = (await this.store.listHumanGuidance(job.id)).at(-1)?.instruction;
    const priorWorker = attempt.executionRole === 'worker'
      ? workers.find(candidate => candidate.roleSequence === attempt.roleSequence - 1)
      : latestWorker;
    const previousResult = priorWorker
      ? await this.resultForAttempt(priorWorker.id)
      : undefined;
    const writeMode = executionModeForJob(job) === 'repository-write-isolated';
    const workspace = writeMode
      ? await this.store.getRepositoryWorkspaceForJob(job.id)
      : null;
    const attachedInputIds = await this.store.listJobInputIds(job.id);
    const baseInstruction = attempt.executionRole === 'worker'
      ? buildWorkerInstruction(
        job,
        attempt.roleSequence,
        previousResult,
        latestReview?.feedback ?? (latestReview?.decision === 'ESCALATE' ? latestReview.summary : undefined),
        guidance,
        writeMode,
        workspace,
      )
      : buildReviewerInstruction(
        job,
        latestWorker?.roleSequence ?? attempt.roleSequence,
        previousResult ?? '',
        writeMode,
        workspace,
      );
    const instruction = attachedInputIds.length
      ? `${baseInstruction}\n\nAttached immutable AO Inputs: ${attachedInputIds.join(', ')}. Inspect only these through inputs.list and inputs.read. For a write Job, copy an Input into the repository only through inputs.copy_to_repository and only when the task requires that explicit output.`
      : baseInstruction;
    let plan = await this.store.getExecutionPlanForAttempt(attempt.id);
    if (!plan) {
      const hasInputs = attachedInputIds.length > 0;
      plan = await this.planning.prepareExecutionPlan({
        projectId: job.projectId,
        attemptId: attempt.id,
        instruction,
        requestedPolicy: writeMode && attempt.executionRole === 'worker'
          ? { version: 1, filesystem: 'workspace-write', network: 'deny', environment: 'empty' }
          : RESTRICTED_TEXT_EXECUTION_POLICY,
        requestedCapabilities: writeMode
          ? attempt.executionRole === 'worker'
            ? { ...REPOSITORY_WRITE_EXECUTION_CAPABILITIES, ...(hasInputs ? { inputRead: true } : {}) }
            : { ...REPOSITORY_WRITE_REVIEW_EXECUTION_CAPABILITIES, ...(hasInputs ? { inputRead: true } : {}) }
          : { ...REPOSITORY_READ_EXECUTION_CAPABILITIES, ...(hasInputs ? { inputRead: true } : {}) },
        ...(workspace ? { repositoryWorkspaceId: workspace.id } : {}),
      });
    }
    const dispatch = await this.dispatch.dispatchExecutionPlan(plan.id);
    const dispatchFailure = await this.resolveDispatchFailure(attempt, dispatch);
    if (dispatchFailure) return dispatchFailure;
    if (!dispatch.dispatch?.externalReference) {
      return {
        status: 'escalate',
        reason: 'exact_correlation_missing',
        summary: 'Accepted Dispatch did not provide the exact external execution reference required for observation.',
      };
    }
    if (dispatch.requiresReconciliation && dispatch.dispatch) {
      try {
        await this.dispatch.reconcileAcceptedDispatch(dispatch.dispatch.id);
      } catch (error) {
        return {
          status: 'escalate',
          reason: 'dispatch_uncertain',
          summary: `Accepted Dispatch could not be reconciled locally: ${message(error)}`,
        };
      }
    }
    const existing = await this.exactExecutionForAttempt(attempt.id);
    if (existing) {
      if (attempt.executionRole === 'reviewer') {
        try {
          parseReviewerResult(existing.resultText);
        } catch (error) {
          await this.resolveAttempt(
            attempt,
            existing.evidence,
            'failed',
            undefined,
            `Reviewer returned malformed structured output: ${message(error)}`,
          );
          return {
            status: 'escalate',
            reason: 'reviewer_uncertain',
            summary: `Reviewer output was not a valid decision contract: ${message(error)}`,
          };
        }
      }
      await this.resolveAttempt(
        attempt,
        existing.evidence,
        'completed',
        attempt.executionRole === 'worker'
          ? 'Worker execution completed with a bounded exact result. Semantic acceptance remains with review.'
          : 'Reviewer execution completed with a bounded exact result.',
      );
      return { status: 'completed', execution: existing };
    }
    const observed = await this.observeBounded(attempt.id);
    if (observed.status === 'completed') {
      if (attempt.executionRole === 'reviewer') {
        try {
          parseReviewerResult(observed.execution.resultText);
        } catch (error) {
          await this.resolveAttempt(
            attempt,
            observed.execution.evidence,
            'failed',
            undefined,
            `Reviewer returned malformed structured output: ${message(error)}`,
          );
          return {
            status: 'escalate',
            reason: 'reviewer_uncertain',
            summary: `Reviewer output was not a valid decision contract: ${message(error)}`,
          };
        }
      }
      await this.resolveAttempt(
        attempt,
        observed.execution.evidence,
        'completed',
        attempt.executionRole === 'worker'
          ? 'Worker execution completed with a bounded exact result. Semantic acceptance remains with review.'
          : 'Reviewer execution completed with a bounded exact result.',
      );
    }
    return observed;
  }

  private async resolveDispatchFailure(
    attempt: DurableJobAttempt,
    outcome: ManualDispatchOutcome,
  ): Promise<ObservationResolution | null> {
    if (outcome.status === 'accepted') return null;
    if (outcome.status === 'blocked') {
      await this.lifecycle.cancelAttempt(attempt.id);
      return {
        status: 'escalate',
        reason: 'policy_blocked',
        summary: `Execution preflight blocked before Dispatch: ${formatPreflight(outcome)}`,
      };
    }
    if (outcome.status === 'rejected') {
      await this.lifecycle.cancelAttempt(attempt.id);
      return {
        status: 'escalate',
        reason: 'dispatch_rejected',
        summary: outcome.message ?? 'Runtime rejected the one permitted Dispatch.',
      };
    }
    return {
      status: 'escalate',
      reason: 'dispatch_uncertain',
      summary: outcome.message ?? 'Dispatch outcome is uncertain; AO will not resend the immutable Plan.',
    };
  }

  private async observeBounded(attemptId: string): Promise<ObservationResolution> {
    const startedAt = Date.now();
    for (;;) {
      let detail: AttemptExecutionDetail;
      try {
        detail = (await this.observations.observeAttemptExecution(attemptId)).detail;
      } catch (error) {
        return {
          status: 'escalate',
          reason: 'runtime_failure',
          summary: `Runtime observation failed: ${message(error)}`,
        };
      }
      const exact = detail.observations.find(isExactCompletionObservation);
      if (exact) {
        if (!exact.resultText) {
          return {
            status: 'escalate',
            reason: 'exact_correlation_missing',
            summary: 'Exact turn completion was recorded without bounded final result text.',
          };
        }
        return { status: 'completed', execution: { detail, evidence: exact, resultText: exact.resultText } };
      }
      if (detail.observations.some(observation => observation.kind === 'turn-completed')) {
        return {
          status: 'escalate',
          reason: 'exact_correlation_missing',
          summary: 'Turn completion was observed without exact Dispatch correlation.',
        };
      }
      const crash = detail.observations.find(observation => observation.kind === 'runtime-crashed');
      if (crash) {
        return {
          status: 'escalate',
          reason: 'runtime_failure',
          summary: crash.message ?? 'Runtime failed before exact turn completion.',
        };
      }
      if (Date.now() - startedAt >= this.observationTimeoutMs) {
        return {
          status: 'escalate',
          reason: 'observation_timeout',
          summary: `No exact completion arrived within ${this.observationTimeoutMs}ms; no Dispatch was resent.`,
        };
      }
      await this.sleep(this.observationIntervalMs);
    }
  }

  private async ensureWriteWorkspace(job: DurableJob): Promise<DurableRepositoryWorkspace> {
    if (!this.workspaceService) {
      throw new Error('Isolated Repository Workspace service is not configured');
    }
    const workspace = await this.workspaceService.prepareForJob(job.id);
    if (!['active', 'reviewing', 'ready_for_approval'].includes(workspace.state)) {
      throw new Error(workspace.failureReason ?? `Workspace is ${workspace.state}`);
    }
    return workspace;
  }

  private async captureWriteEvidence(
    job: DurableJob,
    workerAttemptId: string,
  ): Promise<DurableRepositoryWorkspace> {
    if (!this.workspaceService) throw new Error('Repository Workspace service is unavailable');
    const workspace = await this.store.getRepositoryWorkspaceForJob(job.id);
    if (!workspace) throw new Error('Repository Workspace is missing');
    if (workspace.state === 'reviewing' || workspace.state === 'ready_for_approval') return workspace;
    const execution = await this.exactExecutionForAttempt(workerAttemptId);
    if (!execution) throw new Error('Worker exact execution evidence is missing');
    const testResults: WorkspaceTestResult[] = (execution.evidence.toolOperations ?? [])
      .filter(operation => operation.namespace === 'test'
        && operation.commandId && operation.command
        && operation.exitCode !== undefined && operation.durationMs !== undefined)
      .map(operation => ({
        commandId: operation.commandId!,
        command: operation.command!,
        status: operation.success ? 'passed' : 'failed',
        exitCode: operation.exitCode!,
        durationMs: operation.durationMs!,
        stdout: operation.stdout ?? '',
        stderr: operation.stderr ?? '',
        ...(operation.ephemeralArtifacts
          ? { ephemeralArtifacts: operation.ephemeralArtifacts.map(artifact => ({ ...artifact })) }
          : {}),
        occurredAt: operation.occurredAt,
      }));
    return this.workspaceService.captureEvidence(workspace.id, testResults);
  }

  private safeAutoCompletionEligible(
    job: DurableJob,
    worker: ExactExecutionResult,
    reviewer: ExactExecutionResult,
  ): boolean {
    const safe = (execution: ExactExecutionResult): boolean => {
      const { dispatch } = execution.detail;
      const { evidence } = execution;
      return dispatch.status === 'accepted'
        && dispatch.effectivePolicy?.filesystem === 'read-only'
        && dispatch.effectivePolicy.network === 'deny'
        && dispatch.effectivePolicy.environment === 'empty'
        && dispatch.effectiveCapabilities?.repositoryRead === true
        && evidence.effectivePolicy?.filesystem === 'read-only'
        && evidence.effectivePolicy.network === 'deny'
        && evidence.effectivePolicy.environment === 'empty'
        && evidence.effectiveCapabilities?.repositoryRead === true
        && Boolean(evidence.executionContext?.repositoryReadRoot)
        && Boolean(execution.resultText);
    };
    return job.automaticReadOnlyCompletion === true
      && Boolean(job.repositoryId && job.acceptanceCriteria)
      && safe(worker)
      && safe(reviewer);
  }

  private async resolveAttempt(
    attempt: DurableJobAttempt,
    evidence: DurableExecutionObservation,
    outcome: 'completed' | 'failed',
    summary?: string,
    reason?: string,
  ): Promise<void> {
    const dispatch = await this.requireAcceptedDispatch(attempt.id);
    const existing = await this.store.getAttemptOutcomeDecision(attempt.id);
    if (existing) {
      if (existing.outcome !== outcome || existing.dispatchId !== dispatch.id
        || existing.evidenceObservationId !== evidence.id) {
        throw new Error(`Attempt ${attempt.id} already has a conflicting Outcome Decision`);
      }
    } else {
      await this.store.createAttemptOutcomeDecision({
        id: this.outcomeDecisionIdFactory(),
        attemptId: attempt.id,
        dispatchId: dispatch.id,
        outcome,
        source: 'runtime-evidence',
        ...(outcome === 'completed' ? { summary: required(summary, 'Outcome summary') }
          : { reason: required(reason, 'Outcome reason') }),
        evidenceObservationId: evidence.id,
        overrideWithoutExactCompletionEvidence: false,
        createdAt: this.now().toISOString(),
      });
    }
    const current = await this.store.getAttempt(attempt.id);
    if (!current) throw new Error(`Attempt not found: ${attempt.id}`);
    if (current.status === 'running') {
      if (outcome === 'completed') await this.lifecycle.completeAttempt(attempt.id, summary);
      else await this.lifecycle.failAttempt(attempt.id, reason!);
      return;
    }
    if (current.status !== outcome) {
      throw new Error(`Attempt ${attempt.id} is ${current.status}, conflicting with ${outcome} outcome`);
    }
  }

  private async exactExecutionForAttempt(attemptId: string): Promise<ExactExecutionResult | null> {
    const plan = await this.store.getExecutionPlanForAttempt(attemptId);
    if (!plan) return null;
    const dispatch = await this.store.getExecutionDispatchForPlan(plan.id);
    if (!dispatch || dispatch.status !== 'accepted') return null;
    const observations = await this.store.listExecutionObservationsForDispatch(dispatch.id);
    const evidence = observations.find(isExactCompletionObservation);
    if (!evidence?.resultText) return null;
    const attempt = await this.store.getAttempt(attemptId);
    const job = attempt ? await this.store.getJob(attempt.jobId) : null;
    if (!attempt || !job) return null;
    const outcomeDecision = await this.store.getAttemptOutcomeDecision(attempt.id);
    return {
      detail: {
        job,
        attempt,
        plan,
        dispatch,
        observations,
        outcomeDecision,
        state: outcomeDecision ? 'resolved' : 'completion-evidence',
        exactCompletionEvidence: true,
        outcome: outcomeDecision?.outcome ?? 'awaiting-confirmation',
      },
      evidence,
      resultText: evidence.resultText,
    };
  }

  private async guidanceFor(
    jobId: string,
    attemptId: string,
    reviewId?: string,
  ): Promise<string | undefined> {
    const escalations = await this.store.listEscalations(jobId);
    const guidance = await this.store.listHumanGuidance(jobId);
    return [...guidance].reverse().find(item => {
      const escalation = escalations.find(candidate => candidate.id === item.escalationId);
      return escalation?.attemptId === attemptId
        && (!reviewId || escalation.reviewId === reviewId);
    })?.instruction;
  }

  private async isHumanGuidedWorkerAttempt(
    jobId: string,
    attempt: DurableJobAttempt,
  ): Promise<boolean> {
    if (attempt.executionRole !== 'worker') return false;
    const [attempts, escalations, guidance] = await Promise.all([
      this.store.listAttemptsForJob(jobId),
      this.store.listEscalations(jobId),
      this.store.listHumanGuidance(jobId),
    ]);
    for (const item of guidance) {
      const escalation = escalations.find(candidate => candidate.id === item.escalationId);
      const sourceAttempt = escalation?.attemptId
        ? attempts.find(candidate => candidate.id === escalation.attemptId)
        : undefined;
      if (!sourceAttempt) continue;
      const nextWorker = attempts.find(candidate => candidate.executionRole === 'worker'
        && candidate.sequence > sourceAttempt.sequence);
      if (nextWorker?.id === attempt.id) return true;
    }
    return false;
  }

  private async policyBlockedGuidanceFor(
    jobId: string,
    attemptId: string,
  ): Promise<string | undefined> {
    const escalations = await this.store.listEscalations(jobId);
    const guidance = await this.store.listHumanGuidance(jobId);
    return [...guidance].reverse().find(item => {
      const escalation = escalations.find(candidate => candidate.id === item.escalationId);
      return escalation?.reason === 'policy_blocked' && escalation.attemptId === attemptId;
    })?.instruction;
  }

  private async escalate(
    jobId: string,
    reason: EscalationReason,
    summary: string,
    attemptId?: string,
    reviewId?: string,
  ): Promise<DurableEscalation> {
    const escalation: DurableEscalation = {
      id: this.escalationIdFactory(),
      jobId,
      ...(attemptId ? { attemptId } : {}),
      ...(reviewId ? { reviewId } : {}),
      reason,
      summary: required(summary, 'Escalation summary'),
      createdAt: this.now().toISOString(),
    };
    await this.store.createEscalation(escalation);
    return escalation;
  }

  private async eligibilityFindings(
    job: DurableJob,
    workerRuntimeAgentId: string | null,
    reviewerRuntimeAgentId: string | null,
  ): Promise<string[]> {
    const findings: string[] = [];
    if (job.status !== 'ready') findings.push(`Job status is ${job.status}, not ready`);
    if (!job.repositoryId) findings.push('Job is not repository-bound');
    if (!job.acceptanceCriteria?.trim()) findings.push('Acceptance criteria are missing');
    const writeMode = executionModeForJob(job) === 'repository-write-isolated';
    if (!writeMode && job.automaticReadOnlyCompletion !== true) {
      findings.push('Automatic read-only completion is not enabled');
    }
    if (writeMode && !this.workspaceService) findings.push('Isolated Repository Workspace service is unavailable');
    const runtimeIds = await this.store.listProjectRuntimeAgentIds(job.projectId);
    if (!workerRuntimeAgentId || !runtimeIds.includes(workerRuntimeAgentId)) {
      findings.push('Worker runtime is not configured for the Project');
    }
    if (!reviewerRuntimeAgentId || !runtimeIds.includes(reviewerRuntimeAgentId)) {
      findings.push('Reviewer runtime is not configured for the Project');
    }
    const attempts = await this.store.listAttemptsForJob(job.id);
    if (attempts.some(attempt => attempt.status === 'created' || attempt.status === 'running')) {
      findings.push('Job already has active execution state requiring reconciliation');
    }
    const workerBudget = await readWorkerExecutionBudget(
      this.store,
      attempts,
      MVP_MAX_WORKER_ATTEMPTS,
    );
    if (workerBudget.exhausted) {
      findings.push('Worker execution budget is already exhausted');
    }
    if ((await this.store.listEscalations(job.id, true)).length > 0) {
      findings.push('Job already has an unresolved Escalation');
    }
    return findings;
  }

  private async continuationEligibilityFindings(
    job: DurableJob,
    workerRuntimeAgentId: string | null,
    reviewerRuntimeAgentId: string | null,
  ): Promise<string[]> {
    const findings: string[] = [];
    if (job.status !== 'ready') findings.push(`Job status is ${job.status}, not ready`);
    if (!job.repositoryId) findings.push('Job is not repository-bound');
    if (!job.acceptanceCriteria?.trim()) findings.push('Acceptance criteria are missing');
    const writeMode = executionModeForJob(job) === 'repository-write-isolated';
    if (!writeMode && job.automaticReadOnlyCompletion !== true) {
      findings.push('Automatic read-only completion is not enabled');
    }
    if (writeMode && !this.workspaceService) findings.push('Isolated Repository Workspace service is unavailable');
    const runtimeIds = await this.store.listProjectRuntimeAgentIds(job.projectId);
    if (!workerRuntimeAgentId || !runtimeIds.includes(workerRuntimeAgentId)) {
      findings.push('Worker runtime is not configured for the Project');
    }
    if (!reviewerRuntimeAgentId || !runtimeIds.includes(reviewerRuntimeAgentId)) {
      findings.push('Reviewer runtime is not configured for the Project');
    }
    return findings;
  }

  private async readModel(
    jobId: string,
    finalDecision: OrchestrationReadModel['finalDecision'],
  ): Promise<OrchestrationReadModel> {
    const job = await this.requireJob(jobId);
    const attempts = await this.store.listAttemptsForJob(job.id);
    const reviews = await this.store.listAttemptReviewsForJob(job.id);
    const escalations = await this.store.listEscalations(job.id);
    return {
      job,
      workerAttempts: attempts.filter(attempt => attempt.executionRole === 'worker'),
      reviewerAttempts: attempts.filter(attempt => attempt.executionRole === 'reviewer'),
      reviews,
      escalations,
      needsHuman: escalations.some(escalation => !escalation.resolvedAt),
      finalDecision,
    };
  }

  private async resultForAttempt(attemptId: string): Promise<string | undefined> {
    const plan = await this.store.getExecutionPlanForAttempt(attemptId);
    if (!plan) return undefined;
    const dispatch = await this.store.getExecutionDispatchForPlan(plan.id);
    if (!dispatch) return undefined;
    const observations = await this.store.listExecutionObservationsForDispatch(dispatch.id);
    return observations.find(isExactCompletionObservation)?.resultText;
  }

  private async requireJob(jobId: string): Promise<DurableJob> {
    const id = required(jobId, 'Job ID');
    const job = await this.store.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }

  private async requireAcceptedDispatch(attemptId: string): Promise<DurableExecutionDispatch> {
    const plan = await this.store.getExecutionPlanForAttempt(attemptId);
    const dispatch = plan ? await this.store.getExecutionDispatchForPlan(plan.id) : null;
    if (!dispatch || dispatch.status !== 'accepted') {
      throw new Error(`Accepted Dispatch not found for Attempt: ${attemptId}`);
    }
    return dispatch;
  }
}

export function parseReviewerResult(value: string): ParsedReviewerResult {
  if (!value.trim() || value.length > EXECUTION_RESULT_MAX_CHARS) {
    throw new Error('Reviewer result is empty or exceeds the execution-result bound');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Reviewer result must be one JSON object with no Markdown wrapper');
  }
  if (!isRecord(parsed)) throw new Error('Reviewer result must be a JSON object');
  const keys = Object.keys(parsed).sort();
  if (keys.some(key => !['decision', 'feedback', 'summary'].includes(key))) {
    throw new Error('Reviewer result contains unsupported fields');
  }
  if (!['PASS', 'REVISION_REQUIRED', 'ESCALATE'].includes(String(parsed.decision))) {
    throw new Error('Reviewer decision is invalid');
  }
  const summary = boundedText(parsed.summary, 'Reviewer summary', 2_000);
  const feedback = parsed.feedback === undefined
    ? undefined
    : boundedOptionalText(parsed.feedback, 'Reviewer feedback', 4_000);
  if (parsed.decision === 'REVISION_REQUIRED' && !feedback) {
    throw new Error('REVISION_REQUIRED needs concrete feedback');
  }
  return {
    decision: parsed.decision as AttemptReviewDecision,
    summary,
    ...(feedback ? { feedback } : {}),
  };
}

function buildWorkerInstruction(
  job: DurableJob,
  workerAttemptNumber: number,
  previousResult?: string,
  reviewerFeedback?: string,
  humanGuidance?: string,
  writeMode = false,
  workspace?: DurableRepositoryWorkspace | null,
): string {
  const revision = previousResult && reviewerFeedback
    ? `\nThis is Worker Attempt ${workerAttemptNumber}. Correct the previous result using the concrete Reviewer feedback.\n<previous_worker_result>\n${previousResult}\n</previous_worker_result>\n<reviewer_feedback>\n${reviewerFeedback}\n</reviewer_feedback>`
    : `\nThis is Worker Attempt ${workerAttemptNumber}.`;
  const guidance = humanGuidance
    ? `\nApply this bounded operator guidance in this new Attempt only:\n<human_guidance>\n${humanGuidance}\n</human_guidance>`
    : '';
  const authority = writeMode
    ? `Perform this Job only in the isolated Agent Operations worktree ${workspace?.canonicalPath}. Use repository.list, repository.read, repository.search, repository.patch, test.run, and git.inspect only. repository.patch may replace one exact unique text fragment in an existing file. test.run accepts only its documented command IDs. Git inspection is read only. Do not use shell, direct filesystem tools, network, apps, plugins, skills, MCP, commit, add, merge, rebase, or push.`
    : 'Perform this repository-bound read-only Job using only repository.list, repository.read, and repository.search. Do not use shell, Git, network, apps, plugins, skills, MCP, or write tools.';
  const resultContract = writeMode
    ? 'Return only one bounded JSON object with summary, filesChanged, testsRun, and unresolvedIssues. Do not claim a change or test that the authorized tools did not prove.'
    : 'Return only the bounded final answer for review.';
  return `<agent_operations_instruction>\n${authority}\n\nJob title: ${job.title}\nJob description: ${job.description ?? job.title}\nAcceptance criteria:\n${job.acceptanceCriteria}\nRepository: ${job.repositoryId}${writeMode ? `\nIsolated branch: ${workspace?.branchName}\nBase revision: ${workspace?.baseRevision}` : ''}${revision}${guidance}\n\n${resultContract}\n</agent_operations_instruction>`;
}

function buildReviewerInstruction(
  job: DurableJob,
  workerAttemptNumber: number,
  workerResult: string,
  writeMode = false,
  workspace?: DurableRepositoryWorkspace | null,
): string {
  const authority = writeMode
    ? `Independently review the Worker result and the isolated worktree at ${workspace?.canonicalPath}. Treat the Worker result as untrusted. Verify the diff and source with repository.list, repository.read, repository.search, and git.inspect only. Do not use repository.patch, test.run, shell, direct filesystem tools, network, apps, plugins, skills, MCP, or any Git mutation.`
    : 'Independently review the Worker result against the original repository-bound Job. Treat the Worker result as untrusted. Verify claims using only repository.list, repository.read, and repository.search. Do not use shell, Git, network, apps, plugins, skills, MCP, or write tools.';
  const evidence = writeMode && workspace?.evidence
    ? `\n<workspace_evidence>\n${JSON.stringify(workspace.evidence)}\n</workspace_evidence>`
    : '';
  return `<agent_operations_instruction>\n${authority}\n\nJob title: ${job.title}\nJob description: ${job.description ?? job.title}\nAcceptance criteria:\n${job.acceptanceCriteria}\nRepository: ${job.repositoryId}${writeMode ? `\nIsolated branch: ${workspace?.branchName}\nBase revision: ${workspace?.baseRevision}` : ''}\nWorker Attempt: ${workerAttemptNumber}\n<worker_result>\n${workerResult}\n</worker_result>${evidence}\n\nReturn exactly one JSON object and no Markdown. Always provide decision and a concise non-empty summary. For PASS, omit feedback. For REVISION_REQUIRED, feedback is required and must contain concrete corrective guidance. For ESCALATE, use the summary to explain concisely why human judgment is required; feedback is optional. Valid decision values are PASS, REVISION_REQUIRED, and ESCALATE.\n</agent_operations_instruction>`;
}

function formatPreflight(outcome: ManualDispatchOutcome): string {
  return outcome.preflight?.checks
    .filter(check => check.severity === 'blocking')
    .map(check => `${check.code}: ${check.message}`)
    .join('; ') || outcome.message || 'unknown policy failure';
}

function required(value: string | undefined, field: string): string {
  const clean = value?.trim();
  if (!clean) throw new Error(`${field} is required`);
  return clean;
}

function cleanOptional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean || undefined;
}

function boundedDuration(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 10 * 60_000) {
    throw new Error(`${field} must be an integer between 0 and 600000ms`);
  }
  return value;
}

function boundedText(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const clean = value.trim();
  if (clean.length > limit) throw new Error(`${field} exceeds ${limit} characters`);
  return clean;
}

function boundedOptionalText(value: unknown, field: string, limit: number): string | undefined {
  if (typeof value !== 'string') throw new Error(`${field} must be a string when provided`);
  const clean = value.trim();
  if (!clean) return undefined;
  if (clean.length > limit) throw new Error(`${field} exceeds ${limit} characters`);
  return clean;
}

function isRecoverableObservationEscalation(escalation: DurableEscalation): boolean {
  return escalation.reason === 'observation_timeout'
    || (escalation.reason === 'runtime_failure'
      && escalation.summary.startsWith('Runtime observation failed:'));
}

function samePolicy(
  left: RuntimeExecutionPolicy,
  right: RuntimeExecutionPolicy,
): boolean {
  return left.version === right.version
    && left.filesystem === right.filesystem
    && left.network === right.network
    && left.environment === right.environment;
}

function sameCapabilities(
  left: RuntimeExecutionCapabilities,
  right: RuntimeExecutionCapabilities,
): boolean {
  return left.version === right.version
    && left.repositoryRead === right.repositoryRead
    && left.repositoryPatch === right.repositoryPatch
    && left.testRun === right.testRun
    && left.gitInspect === right.gitInspect
    && left.inputRead === right.inputRead;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
