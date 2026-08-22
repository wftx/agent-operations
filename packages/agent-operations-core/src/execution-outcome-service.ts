import type {
  AgentOperationsStateStore,
  DurableAttemptOutcomeDecision,
  DurableExecutionObservation,
} from '../../agent-operations-contracts/src/index.js';
import {
  createAttemptOutcomeDecisionId,
  isExactCompletionObservation,
} from '../../agent-operations-contracts/src/index.js';
import { ExecutionObservationService, type AttemptExecutionDetail } from './execution-observation-service.js';
import { JobLifecycleService } from './job-lifecycle-service.js';

export interface ConfirmAttemptSucceededInput {
  readonly summary: string;
  readonly evidenceObservationId?: string;
  readonly overrideWithoutExactCompletionEvidence?: boolean;
}

export interface ConfirmAttemptFailedInput {
  readonly reason: string;
  readonly evidenceObservationId?: string;
}

export interface ExecutionOutcomeServiceOptions {
  readonly now?: () => Date;
  readonly decisionIdFactory?: () => string;
}

/** Human-authoritative Attempt resolution. It contains no automatic outcome policy. */
export class ExecutionOutcomeService {
  private readonly now: () => Date;
  private readonly decisionIdFactory: () => string;
  private readonly lifecycle: JobLifecycleService;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly observations: ExecutionObservationService,
    options: ExecutionOutcomeServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.decisionIdFactory = options.decisionIdFactory ?? (() => createAttemptOutcomeDecisionId());
    this.lifecycle = new JobLifecycleService(store, { now: this.now });
  }

  async confirmAttemptSucceeded(
    attemptId: string,
    input: ConfirmAttemptSucceededInput,
  ): Promise<AttemptExecutionDetail> {
    const summary = required(input.summary, 'Attempt completion summary');
    const detail = await this.observations.getAttemptExecutionDetail(attemptId);
    const existing = detail.outcomeDecision;
    if (existing) {
      this.requireMatchingDecision(existing, 'completed', summary, undefined);
      return this.applyExistingDecision(detail, existing);
    }
    this.requireRunning(detail);
    const selected = selectEvidence(detail.observations, input.evidenceObservationId);
    const exact = selected
      ? isExactCompletionObservation(selected) ? selected : undefined
      : detail.observations.find(isExactCompletionObservation);
    const override = input.overrideWithoutExactCompletionEvidence === true;
    if (!exact && !override) {
      throw new Error('Success confirmation requires exact turn-completion evidence or an explicit human override');
    }
    const decision: DurableAttemptOutcomeDecision = {
      id: this.decisionIdFactory(),
      attemptId: detail.attempt.id,
      dispatchId: detail.dispatch.id,
      outcome: 'completed',
      source: 'human',
      summary,
      ...(selected?.id ? { evidenceObservationId: selected.id }
        : exact?.id ? { evidenceObservationId: exact.id } : {}),
      overrideWithoutExactCompletionEvidence: !exact && override,
      createdAt: this.now().toISOString(),
    };
    await this.createOrResolveRace(decision);
    await this.lifecycle.completeAttempt(detail.attempt.id, summary);
    return this.observations.getAttemptExecutionDetail(detail.attempt.id);
  }

  async confirmAttemptFailed(
    attemptId: string,
    input: ConfirmAttemptFailedInput,
  ): Promise<AttemptExecutionDetail> {
    const reason = required(input.reason, 'Attempt failure reason');
    const detail = await this.observations.getAttemptExecutionDetail(attemptId);
    const existing = detail.outcomeDecision;
    if (existing) {
      this.requireMatchingDecision(existing, 'failed', undefined, reason);
      return this.applyExistingDecision(detail, existing);
    }
    this.requireRunning(detail);
    const selected = selectEvidence(detail.observations, input.evidenceObservationId);
    const decision: DurableAttemptOutcomeDecision = {
      id: this.decisionIdFactory(),
      attemptId: detail.attempt.id,
      dispatchId: detail.dispatch.id,
      outcome: 'failed',
      source: 'human',
      reason,
      ...(selected ? { evidenceObservationId: selected.id } : {}),
      overrideWithoutExactCompletionEvidence: false,
      createdAt: this.now().toISOString(),
    };
    await this.createOrResolveRace(decision);
    await this.lifecycle.failAttempt(detail.attempt.id, reason);
    return this.observations.getAttemptExecutionDetail(detail.attempt.id);
  }

  private async applyExistingDecision(
    detail: AttemptExecutionDetail,
    decision: DurableAttemptOutcomeDecision,
  ): Promise<AttemptExecutionDetail> {
    if (detail.attempt.status === 'running') {
      if (decision.outcome === 'completed') {
        await this.lifecycle.completeAttempt(detail.attempt.id, decision.summary);
      } else {
        await this.lifecycle.failAttempt(detail.attempt.id, decision.reason!);
      }
    } else if (detail.attempt.status !== decision.outcome) {
      throw new Error(
        `Attempt ${detail.attempt.id} is ${detail.attempt.status}, conflicting with ${decision.outcome} decision`,
      );
    }
    return this.observations.getAttemptExecutionDetail(detail.attempt.id);
  }

  private async createOrResolveRace(decision: DurableAttemptOutcomeDecision): Promise<void> {
    try {
      await this.store.createAttemptOutcomeDecision(decision);
    } catch (error) {
      const existing = await this.store.getAttemptOutcomeDecision(decision.attemptId);
      if (!existing) throw error;
      this.requireMatchingDecision(existing, decision.outcome, decision.summary, decision.reason);
    }
  }

  private requireRunning(detail: AttemptExecutionDetail): void {
    if (detail.attempt.status !== 'running') {
      throw new Error(`Attempt ${detail.attempt.id} must be running for an outcome decision`);
    }
  }

  private requireMatchingDecision(
    decision: DurableAttemptOutcomeDecision,
    outcome: 'completed' | 'failed',
    summary: string | undefined,
    reason: string | undefined,
  ): void {
    if (decision.outcome !== outcome
      || (summary !== undefined && decision.summary !== summary)
      || (reason !== undefined && decision.reason !== reason)) {
      throw new Error(`Attempt ${decision.attemptId} already has a different Outcome Decision`);
    }
  }
}

function selectEvidence(
  observations: readonly DurableExecutionObservation[],
  observationId: string | undefined,
): DurableExecutionObservation | undefined {
  if (!observationId) return undefined;
  const selected = observations.find(observation => observation.id === observationId.trim());
  if (!selected) throw new Error(`Outcome evidence Observation not found: ${observationId}`);
  return selected;
}

function required(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required`);
  return clean;
}
