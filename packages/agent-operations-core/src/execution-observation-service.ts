import type {
  AgentOperationsStateStore,
  DurableAttemptOutcomeDecision,
  DurableExecutionDispatch,
  DurableExecutionObservation,
  DurableExecutionPlan,
  DurableJob,
  DurableJobAttempt,
  RuntimeExecutionObservation,
  RuntimeExecutionObservationAdapter,
} from '../../agent-operations-contracts/src/index.js';
import {
  createExecutionObservationId,
  isExactCompletionObservation,
} from '../../agent-operations-contracts/src/index.js';

const MAX_SOURCE_LENGTH = 100;
const MAX_REFERENCE_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_OUTPUT_SUMMARY_LENGTH = 4_000;

export type AttemptExecutionState =
  | 'still-running'
  | 'completion-evidence'
  | 'runtime-failure-evidence'
  | 'ambiguous'
  | 'resolved';

export interface AttemptExecutionDetail {
  readonly job: DurableJob;
  readonly attempt: DurableJobAttempt;
  readonly plan: DurableExecutionPlan;
  readonly dispatch: DurableExecutionDispatch;
  readonly observations: readonly DurableExecutionObservation[];
  readonly outcomeDecision: DurableAttemptOutcomeDecision | null;
  readonly state: AttemptExecutionState;
  readonly exactCompletionEvidence: boolean;
  readonly outcome: 'awaiting-confirmation' | 'completed' | 'failed';
}

export interface ExecutionObservationResult {
  readonly detail: AttemptExecutionDetail;
  readonly inserted: number;
  readonly duplicates: number;
  readonly ignoredUnrelated: number;
}

export class ExecutionObservationService {
  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly observer: RuntimeExecutionObservationAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async observeAttemptExecution(attemptId: string): Promise<ExecutionObservationResult> {
    const chain = await this.loadAcceptedChain(attemptId);
    if (chain.attempt.status !== 'running') {
      throw new Error(`Attempt ${chain.attempt.id} must be running to observe execution`);
    }
    const raw = await this.observer.observe({
      dispatchId: chain.dispatch.id,
      attemptId: chain.attempt.id,
      runtimeAgentId: chain.dispatch.runtimeAgentId,
      acceptedAt: chain.dispatch.acceptedAt!,
      ...(chain.dispatch.externalReference
        ? { externalReference: chain.dispatch.externalReference }
        : {}),
    });
    if (!Array.isArray(raw)) throw new Error('Runtime observer returned a malformed observation collection');

    let inserted = 0;
    let duplicates = 0;
    let ignoredUnrelated = 0;
    for (const candidate of raw) {
      const normalized = normalizeRuntimeObservation(candidate);
      if (normalized.correlation === 'exact'
        && normalized.correlatedDispatchId !== chain.dispatch.id) {
        ignoredUnrelated++;
        continue;
      }
      const observation: DurableExecutionObservation = {
        ...normalized,
        id: createExecutionObservationId(
          chain.dispatch.id,
          normalized.source,
          normalized.sourceEventId,
        ),
        dispatchId: chain.dispatch.id,
        attemptId: chain.attempt.id,
        recordedAt: this.now().toISOString(),
      };
      if (await this.store.appendExecutionObservation(observation)) inserted++;
      else duplicates++;
    }

    return {
      detail: await this.getAttemptExecutionDetail(chain.attempt.id),
      inserted,
      duplicates,
      ignoredUnrelated,
    };
  }

  async getAttemptExecutionDetail(attemptId: string): Promise<AttemptExecutionDetail> {
    const chain = await this.loadAcceptedChain(attemptId);
    const observations = await this.store.listExecutionObservationsForDispatch(chain.dispatch.id);
    const outcomeDecision = await this.store.getAttemptOutcomeDecision(chain.attempt.id);
    const exactCompletionEvidence = observations.some(isExactCompletionObservation);
    const outcome = outcomeDecision?.outcome ?? 'awaiting-confirmation';
    let state: AttemptExecutionState;
    if (outcomeDecision) state = 'resolved';
    else if (exactCompletionEvidence) state = 'completion-evidence';
    else if (observations.some(observation => observation.kind === 'runtime-crashed')) {
      state = 'runtime-failure-evidence';
    } else if (observations.some(observation =>
      observation.kind === 'runtime-unavailable' || observation.kind === 'unknown')) {
      state = 'ambiguous';
    } else state = 'still-running';

    return {
      ...chain,
      observations,
      outcomeDecision,
      state,
      exactCompletionEvidence,
      outcome,
    };
  }

  private async loadAcceptedChain(attemptId: string): Promise<{
    job: DurableJob;
    attempt: DurableJobAttempt;
    plan: DurableExecutionPlan;
    dispatch: DurableExecutionDispatch;
  }> {
    const cleanAttemptId = required(attemptId, 'Attempt ID');
    const attempt = await this.store.getAttempt(cleanAttemptId);
    if (!attempt) throw new Error(`Attempt not found: ${cleanAttemptId}`);
    const job = await this.store.getJob(attempt.jobId);
    if (!job) throw new Error(`Job not found for Attempt ${attempt.id}: ${attempt.jobId}`);
    const plan = await this.store.getExecutionPlanForAttempt(attempt.id);
    if (!plan) throw new Error(`Execution Plan not found for Attempt: ${attempt.id}`);
    const dispatch = await this.store.getExecutionDispatchForPlan(plan.id);
    if (!dispatch || dispatch.status !== 'accepted' || !dispatch.acceptedAt) {
      throw new Error(`Accepted Dispatch not found for Attempt: ${attempt.id}`);
    }
    return { job, attempt, plan, dispatch };
  }
}

function normalizeRuntimeObservation(value: unknown): RuntimeExecutionObservation {
  if (!isRecord(value)) throw new Error('Runtime observer returned a malformed observation');
  const source = boundedRequired(value.source, 'Observation source', MAX_SOURCE_LENGTH);
  const sourceEventId = boundedRequired(value.sourceEventId, 'Observation source event ID', MAX_REFERENCE_LENGTH);
  const kind = value.kind;
  if (!['runtime-running', 'runtime-idle', 'turn-completed', 'output-available',
    'runtime-crashed', 'runtime-unavailable', 'unknown'].includes(String(kind))) {
    throw new Error(`Runtime observer returned an unsupported observation kind: ${String(kind)}`);
  }
  const correlation = value.correlation;
  if (!['exact', 'runtime-session', 'agent-level', 'uncorrelated'].includes(String(correlation))) {
    throw new Error(`Runtime observer returned an unsupported correlation: ${String(correlation)}`);
  }
  const observedAt = boundedRequired(value.observedAt, 'Observation timestamp', MAX_REFERENCE_LENGTH);
  if (Number.isNaN(new Date(observedAt).getTime())) throw new Error(`Invalid Observation timestamp: ${observedAt}`);
  const correlatedDispatchId = boundedOptional(value.correlatedDispatchId, MAX_REFERENCE_LENGTH);
  if (correlation === 'exact' && !correlatedDispatchId) {
    throw new Error('Exact runtime observation did not identify a Dispatch');
  }
  if (correlation !== 'exact' && correlatedDispatchId) {
    throw new Error('Only exact runtime observations may identify a Dispatch');
  }
  return {
    source,
    sourceEventId,
    kind: kind as RuntimeExecutionObservation['kind'],
    correlation: correlation as RuntimeExecutionObservation['correlation'],
    observedAt,
    ...(correlatedDispatchId ? { correlatedDispatchId } : {}),
    ...(boundedOptional(value.runtimeSessionId, MAX_REFERENCE_LENGTH)
      ? { runtimeSessionId: boundedOptional(value.runtimeSessionId, MAX_REFERENCE_LENGTH) }
      : {}),
    ...(boundedOptional(value.externalReference, MAX_REFERENCE_LENGTH)
      ? { externalReference: boundedOptional(value.externalReference, MAX_REFERENCE_LENGTH) }
      : {}),
    ...(boundedOptional(value.message, MAX_MESSAGE_LENGTH)
      ? { message: boundedOptional(value.message, MAX_MESSAGE_LENGTH) }
      : {}),
    ...(boundedOptional(value.outputSummary, MAX_OUTPUT_SUMMARY_LENGTH)
      ? { outputSummary: boundedOptional(value.outputSummary, MAX_OUTPUT_SUMMARY_LENGTH) }
      : {}),
  };
}

function required(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${field} is required`);
  return clean;
}

function boundedRequired(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const clean = value.trim();
  if (clean.length > limit) throw new Error(`${field} exceeds ${limit} characters`);
  return clean;
}

function boundedOptional(value: unknown, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('Optional Observation text must be a string');
  const clean = value.trim();
  if (!clean) return undefined;
  if (clean.length > limit) throw new Error(`Observation text exceeds ${limit} characters`);
  return clean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
