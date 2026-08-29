import { createHash, randomUUID } from 'node:crypto';
import type {
  RuntimeExecutionCapabilities,
  RuntimeExecutionContext,
  RuntimeExecutionPolicy,
} from './execution.js';
import { EXECUTION_RESULT_MAX_CHARS } from './orchestration.js';

export const EXECUTION_OBSERVATION_KINDS = [
  'runtime-running',
  'runtime-idle',
  'turn-completed',
  'output-available',
  'runtime-crashed',
  'runtime-unavailable',
  'unknown',
] as const;

export type ExecutionObservationKind = (typeof EXECUTION_OBSERVATION_KINDS)[number];

export const EXECUTION_CORRELATIONS = [
  'exact',
  'runtime-session',
  'agent-level',
  'uncorrelated',
] as const;

export type ExecutionCorrelation = (typeof EXECUTION_CORRELATIONS)[number];

export interface RuntimeExecutionObservationRequest {
  readonly dispatchId: string;
  readonly attemptId: string;
  readonly runtimeAgentId: string;
  readonly acceptedAt: string;
  readonly externalReference?: string;
}

/** One bounded provider observation. Exact evidence must name its trusted Dispatch. */
export interface RuntimeExecutionObservation {
  readonly source: string;
  readonly sourceEventId: string;
  readonly kind: ExecutionObservationKind;
  readonly correlation: ExecutionCorrelation;
  readonly observedAt: string;
  readonly correlatedDispatchId?: string;
  readonly runtimeSessionId?: string;
  readonly externalReference?: string;
  readonly message?: string;
  readonly outputSummary?: string;
  /** Bounded final visible assistant text from the exact correlated turn. */
  readonly resultText?: string;
  /** Trusted exact-turn context; omitted for weak or legacy observations. */
  readonly executionContext?: RuntimeExecutionContext;
  /** Trusted exact-turn policy; omitted for weak or legacy observations. */
  readonly effectivePolicy?: RuntimeExecutionPolicy;
  /** Trusted exact-turn tool capability evidence; omitted for weak or legacy observations. */
  readonly effectiveCapabilities?: RuntimeExecutionCapabilities;
  /** Bounded audit evidence for dynamic tools used by this exact turn. */
  readonly toolOperations?: readonly RuntimeToolOperation[];
}

export interface RuntimeToolOperation {
  readonly namespace: 'repository' | 'test' | 'git';
  readonly operation: string;
  readonly success: boolean;
  readonly occurredAt: string;
  readonly path?: string;
  readonly commandId?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** True when AO retained only the bounded prefix of provider tool output. */
  readonly outputTruncated?: boolean;
  readonly errorCode?: string;
}

/** Read-only, explicitly invoked observation capability. */
export interface RuntimeExecutionObservationAdapter {
  observe(
    request: RuntimeExecutionObservationRequest,
  ): Promise<readonly RuntimeExecutionObservation[]>;
}

/** Append-only AO-owned observation linked to one accepted Dispatch and Attempt. */
export interface DurableExecutionObservation extends RuntimeExecutionObservation {
  readonly id: string;
  readonly dispatchId: string;
  readonly attemptId: string;
  readonly recordedAt: string;
}

export type AttemptOutcome = 'completed' | 'failed';
export type AttemptOutcomeDecisionSource = 'human' | 'runtime-evidence';

/** One authoritative outcome decision per Attempt. Phase 10 creates human decisions only. */
export interface DurableAttemptOutcomeDecision {
  readonly id: string;
  readonly attemptId: string;
  readonly dispatchId: string;
  readonly outcome: AttemptOutcome;
  readonly source: AttemptOutcomeDecisionSource;
  readonly summary?: string;
  readonly reason?: string;
  readonly evidenceObservationId?: string;
  readonly overrideWithoutExactCompletionEvidence: boolean;
  readonly createdAt: string;
}

export function createExecutionObservationId(
  dispatchId: string,
  source: string,
  sourceEventId: string,
): string {
  const parts = [dispatchId, source, sourceEventId].map(value => value.trim());
  if (parts.some(value => !value)) throw new Error('Observation identity fields are required');
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `observation:${digest}`;
}

export function createAttemptOutcomeDecisionId(uuid: string = randomUUID()): string {
  const value = uuid.trim();
  if (!value) throw new Error('Attempt outcome UUID is required');
  return `outcome:${value}`;
}

export function isExactCompletionObservation(
  observation: Pick<DurableExecutionObservation, 'kind' | 'correlation' | 'correlatedDispatchId' | 'dispatchId'>,
): boolean {
  return observation.kind === 'turn-completed'
    && observation.correlation === 'exact'
    && observation.correlatedDispatchId === observation.dispatchId;
}

export function isBoundedExecutionResult(value: string): boolean {
  return Boolean(value.trim()) && value.length <= EXECUTION_RESULT_MAX_CHARS;
}
