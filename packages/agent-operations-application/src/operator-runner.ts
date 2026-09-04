import type {
  AgentOperationsStateStore,
  DurableEscalation,
  DurableOperatorNotificationDelivery,
  DurableOperatorRun,
  OperatorNotificationKind,
} from '../../agent-operations-contracts/src/index.js';
import {
  createEscalationId,
  createOperatorNotificationDeliveryId,
  createOperatorNotificationEventKey,
  actionableEscalationText,
  EXTERNAL_ACTION_MAX_DURATION_MS,
} from '../../agent-operations-contracts/src/index.js';
import type { OrchestrationReadModel } from '../../agent-operations-core/src/index.js';
import type { OperatorNotifier } from './notification.js';
import type { RuntimeFreshnessApplication } from './types.js';
import { NoopOperatorNotifier } from './notification.js';
import { readRunnerStatus } from './operator-runner-control.js';

export interface OperatorRunnerOrchestrationPort {
  runJob(jobId: string): Promise<OrchestrationReadModel>;
}

export interface OperatorRunnerOptions {
  readonly now?: () => Date;
  readonly notifier?: OperatorNotifier;
  readonly notificationDeliveryIdFactory?: () => string;
  readonly escalationIdFactory?: () => string;
  readonly runtimeFreshness?: RuntimeFreshnessApplication;
  readonly requireRunnerControl?: boolean;
}

/** One-process durable runner for explicitly accepted Operator Runs only. */
export class OperatorRunner {
  private readonly now: () => Date;
  private readonly notifier: OperatorNotifier;
  private readonly notificationDeliveryIdFactory: () => string;
  private readonly escalationIdFactory: () => string;
  private readonly runtimeFreshness?: RuntimeFreshnessApplication;
  private readonly requireRunnerControl: boolean;
  private drainPromise: Promise<void> | null = null;
  private wakeRequested = false;
  private deferredWake: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly orchestration: OperatorRunnerOrchestrationPort,
    options: OperatorRunnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.notifier = options.notifier ?? new NoopOperatorNotifier();
    this.notificationDeliveryIdFactory = options.notificationDeliveryIdFactory
      ?? (() => createOperatorNotificationDeliveryId());
    this.escalationIdFactory = options.escalationIdFactory ?? (() => createEscalationId());
    this.runtimeFreshness = options.runtimeFreshness;
    this.requireRunnerControl = options.requireRunnerControl ?? false;
  }

  start(): void {
    void this.wake();
  }

  wake(): Promise<void> {
    this.wakeRequested = true;
    if (!this.drainPromise) {
      this.drainPromise = this.drainUntilSettled().finally(() => { this.drainPromise = null; });
    }
    return this.drainPromise;
  }

  async waitForRun(jobId: string): Promise<DurableOperatorRun> {
    await this.wake();
    const run = await this.store.getOperatorRunForJob(jobId);
    if (!run) throw new Error(`Operator Run not found for Job: ${jobId}`);
    return run;
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.requireRunnerControl && (await readRunnerStatus(this.store, this.now())).state !== 'running') break;
      const runs = await this.store.listOperatorRuns();
      // External action claims belong to their deterministic executor, never a Worker.
      const externalIds = new Set((await this.store.listJobs()).filter(j => j.executionMode === 'external-action').map(j => j.id));
      for(const run of runs.filter(r=>externalIds.has(r.jobId) && r.status==='running')) {
        const p=await this.store.getExternalActionPlan(run.jobId);
        const timestamp=this.now().toISOString();
        if(p?.state==='executing' && p.claimedAt && p.approval && this.now().getTime()-Date.parse(p.claimedAt)>=EXTERNAL_ACTION_MAX_DURATION_MS) {
          await this.store.finishExternalAction({id:`external-receipt:expired:${p.id}`,planId:p.id,jobId:p.jobId,projectId:p.action.projectId,
            actionId:p.action.id,executorId:p.action.executorId,approval:p.approval,scopeHash:p.scopeHash,
            systemsRead:p.action.systemsRead,systemsWritten:p.action.systemsWritten,mutationScope:p.action.mutationScope,
            executedAt:p.claimedAt,recordedAt:timestamp,automaticRetries:0,status:'uncertain',verification:'unavailable',sideEffect:'possible',counts:{},errorCode:'outcome-uncertain'});
        }
      }
      const next = runs.find(run => (run.status === 'pending' || run.status === 'running') && !externalIds.has(run.jobId));
      if (!next) break;
      if (await this.process(next) === 'deferred') break;
    }
    await this.reconcileNotifications();
  }

  private async drainUntilSettled(): Promise<void> {
    do {
      this.wakeRequested = false;
      await this.drain();
    } while (this.wakeRequested);
  }

  private async process(run: DurableOperatorRun): Promise<'processed' | 'deferred'> {
    const retirement = await this.store.getJobRetirement(run.jobId);
    if (retirement) {
      await this.store.retireJob(retirement);
      return 'processed';
    }
    let running = run;
    if (this.runtimeFreshness) {
      try {
        const freshness = await this.runtimeFreshness.ensureCurrentForJob(running.jobId);
        if (freshness.state === 'restart-pending') {
          this.scheduleDeferredWake();
          return 'deferred';
        }
        if (freshness.state !== 'current') throw new Error(freshness.message);
        const job = await this.store.getJob(running.jobId);
        if (!job) throw new Error(`Job not found: ${running.jobId}`);
        if (!job.preferredRuntimeAgentId) {
          throw new Error(`Job ${job.id} has no preferred Worker runtime.`);
        }
        const capacity = await this.runtimeFreshness.ensureExecutionAgentForJob(
          job.id,
          job.preferredRuntimeAgentId,
        );
        if (capacity.state !== 'ready') throw new Error(capacity.message);
      } catch (error) {
        const retired = await this.store.getJobRetirement(running.jobId);
        if (retired) { await this.store.retireJob(retired); return 'processed'; }
        if (running.status === 'pending') {
          const timestamp = this.now().toISOString();
          const started = transitionRun(running, 'running', timestamp, { startedAt: timestamp });
          await this.store.saveOperatorRunTransition(started, running.revision);
          running = started;
        }
        await this.failRun(running, error);
        return 'processed';
      }
    }
    const retirementAfterReadiness = await this.store.getJobRetirement(run.jobId);
    if (retirementAfterReadiness) { await this.store.retireJob(retirementAfterReadiness); return 'processed'; }
    if (this.requireRunnerControl && (await readRunnerStatus(this.store, this.now())).state !== 'running') return 'deferred';
    if (running.status === 'pending') {
      const timestamp = this.now().toISOString();
      running = transitionRun(running, 'running', timestamp, {
        startedAt: timestamp,
        finishedAt: undefined,
        failureMessage: undefined,
      });
      await this.store.saveOperatorRunTransition(running, run.revision);
    }
    try {
      // Retirement can race with asynchronous runtime readiness. Recheck before work.
      const retired = await this.store.getJobRetirement(running.jobId);
      if (retired) { await this.store.retireJob(retired); return 'processed'; }
      const result = await this.orchestration.runJob(running.jobId);
      const timestamp = this.now().toISOString();
      const terminalStatus = result.needsHuman || result.finalDecision === 'ESCALATED'
        ? 'needs_human' as const
        : 'completed' as const;
      const terminal = transitionRun(running, terminalStatus, timestamp, { finishedAt: timestamp });
      await this.store.saveOperatorRunTransition(terminal, running.revision);
      await this.safeNotifyForRun(terminal);
      return 'processed';
    } catch (error) {
      await this.failRun(running, error);
      return 'processed';
    }
  }

  private scheduleDeferredWake(): void {
    if (this.deferredWake) return;
    this.deferredWake = setTimeout(() => {
      this.deferredWake = null;
      void this.wake();
    }, 5_000);
    this.deferredWake.unref?.();
  }

  private async failRun(running: DurableOperatorRun, error: unknown): Promise<void> {
    const retirement = await this.store.getJobRetirement(running.jobId);
    if (retirement) { await this.store.retireJob(retirement); return; }
    const failure = errorMessage(error);
    let hasEscalation = (await this.store.listEscalations(running.jobId, true)).length > 0;
    if (!hasEscalation) {
      try {
        await this.store.createEscalation({
          id: this.escalationIdFactory(),
          jobId: running.jobId,
          reason: 'runtime_failure',
          summary: `Operator orchestration stopped unexpectedly: ${failure}`,
          createdAt: this.now().toISOString(),
        });
        hasEscalation = true;
      } catch {
        hasEscalation = false;
      }
    }
    const timestamp = this.now().toISOString();
    const terminal = transitionRun(
      running,
      hasEscalation ? 'needs_human' : 'failed',
      timestamp,
      { finishedAt: timestamp, failureMessage: failure },
    );
    await this.store.saveOperatorRunTransition(terminal, running.revision);
    if (hasEscalation) await this.safeNotifyForRun(terminal);
  }

  private async reconcileNotifications(): Promise<void> {
    for (const run of await this.store.listOperatorRuns()) {
      if (run.status === 'completed' || run.status === 'needs_human') {
        await this.safeNotifyForRun(run);
      }
    }
  }

  private async safeNotifyForRun(run: DurableOperatorRun): Promise<void> {
    try {
      await this.notifyForRun(run);
    } catch {
      // Notification persistence/transport is secondary. Durable Job and Run
      // truth must remain unchanged even if notification bookkeeping fails.
    }
  }

  private async notifyForRun(run: DurableOperatorRun): Promise<void> {
    const job = await this.store.getJob(run.jobId);
    if (!job) return;
    const projectName = (await this.store.getProject(job.projectId))?.name ?? job.projectId;
    const aoPath = `/jobs/${encodeURIComponent(job.id)}`;
    if (run.status === 'completed') {
      const attempts = await this.store.listAttemptsForJob(job.id);
      const reviews = await this.store.listAttemptReviewsForJob(job.id);
      const workerAttempts = attempts.filter(attempt => attempt.executionRole === 'worker');
      const result = workerAttempts.length
        ? await this.resultForAttempt(workerAttempts.at(-1)!.id)
        : undefined;
      const external = await this.store.getExternalActionReceipt(job.id);
      await this.deliver('job_completed', job.id, undefined, {
        kind: 'job_completed',
        jobId: job.id,
        title: job.title,
        projectName,
        aoPath,
        result: external ? `External action ${external.status}. ${JSON.stringify(external.counts)}. Receipt ${external.id}.` : result ?? 'No bounded final result is available.',
        reviewerSummary: external ? `Deterministic verification ${external.verification}. No provider Reviewer was used.` : reviews.at(-1)?.summary ?? 'Reviewer PASS was recorded.',
        workerAttemptCount: workerAttempts.length,
      });
      return;
    }
    for (const escalation of await this.store.listEscalations(job.id, true)) {
      const reviews = await this.store.listAttemptReviewsForJob(job.id);
      const review = escalation.reviewId
        ? reviews.find(candidate => candidate.id === escalation.reviewId)
        : reviews.at(-1);
      await this.deliver('needs_human', job.id, escalation, {
        kind: 'needs_human',
        jobId: job.id,
        escalationId: escalation.id,
        title: job.title,
        projectName,
        aoPath,
        reason: actionableEscalationText(escalation),
        ...(review?.feedback ? { reviewerFeedback: review.feedback } : {}),
      });
    }
  }

  private async deliver(
    kind: OperatorNotificationKind,
    jobId: string,
    escalation: DurableEscalation | undefined,
    event: Parameters<OperatorNotifier['notify']>[0],
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    const eventKey = createOperatorNotificationEventKey(kind, jobId, escalation?.id);
    const delivery: DurableOperatorNotificationDelivery = {
      id: this.notificationDeliveryIdFactory(),
      eventKey,
      kind,
      jobId,
      ...(escalation ? { escalationId: escalation.id } : {}),
      status: 'pending',
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!await this.store.createOperatorNotificationDelivery(delivery)) return;
    let status: 'sent' | 'failed' | 'skipped';
    let message: string | undefined;
    try {
      const result = await this.notifier.notify(event);
      status = result.status;
      message = result.message;
    } catch (error) {
      status = 'failed';
      message = errorMessage(error).slice(0, 2_000);
    }
    const attemptedAt = this.now().toISOString();
    await this.store.saveOperatorNotificationDeliveryTransition({
      ...delivery,
      status,
      ...(message ? { message } : {}),
      revision: 1,
      updatedAt: attemptedAt,
      attemptedAt,
    }, 0);
  }

  private async resultForAttempt(attemptId: string): Promise<string | undefined> {
    const plan = await this.store.getExecutionPlanForAttempt(attemptId);
    const dispatch = plan ? await this.store.getExecutionDispatchForPlan(plan.id) : null;
    const observations = dispatch
      ? await this.store.listExecutionObservationsForDispatch(dispatch.id)
      : [];
    return observations.find(observation => observation.kind === 'turn-completed'
      && observation.correlation === 'exact'
      && observation.correlatedDispatchId === dispatch?.id)?.resultText;
  }
}

function transitionRun(
  run: DurableOperatorRun,
  status: DurableOperatorRun['status'],
  updatedAt: string,
  change: Partial<DurableOperatorRun> = {},
): DurableOperatorRun {
  return { ...run, ...change, status, revision: run.revision + 1, updatedAt };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
