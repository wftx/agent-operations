import { resolve } from 'node:path';
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
  EXECUTION_RESULT_MAX_CHARS,
  isExactCompletionObservation,
} from '../../agent-operations-contracts/src/index.js';

const MAX_SOURCE_LENGTH = 100;
const MAX_REFERENCE_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_OUTPUT_SUMMARY_LENGTH = 4_000;
const MAX_WORKING_DIRECTORY_LENGTH = 4_096;

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
      validateObservationInputBoundary(normalized, chain.plan);
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

export function normalizeRuntimeObservation(value: unknown): RuntimeExecutionObservation {
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
  const executionContext = value.executionContext;
  if (executionContext !== undefined
    && (!isRecord(executionContext)
      || typeof executionContext.workingDirectory !== 'string'
      || !executionContext.workingDirectory.startsWith('/')
      || resolve(executionContext.workingDirectory) !== executionContext.workingDirectory
      || executionContext.workingDirectory.length > MAX_WORKING_DIRECTORY_LENGTH
      || (executionContext.repositoryReadRoot !== undefined
        && (typeof executionContext.repositoryReadRoot !== 'string'
          || !executionContext.repositoryReadRoot.startsWith('/')
          || resolve(executionContext.repositoryReadRoot) !== executionContext.repositoryReadRoot
          || executionContext.repositoryReadRoot.length > MAX_WORKING_DIRECTORY_LENGTH))
      || (executionContext.repositoryWriteRoot !== undefined
        && (typeof executionContext.repositoryWriteRoot !== 'string'
          || !executionContext.repositoryWriteRoot.startsWith('/')
          || resolve(executionContext.repositoryWriteRoot) !== executionContext.repositoryWriteRoot
          || executionContext.repositoryWriteRoot.length > MAX_WORKING_DIRECTORY_LENGTH))
      || (executionContext.inputIds !== undefined
        && !isValidInputIdList(executionContext.inputIds)))) {
    throw new Error('Runtime observer returned an invalid execution working directory');
  }
  const effectivePolicy = value.effectivePolicy;
  if (effectivePolicy !== undefined
    && (!isRecord(effectivePolicy)
      || effectivePolicy.version !== 1
      || !['none', 'read-only', 'workspace-write'].includes(String(effectivePolicy.filesystem))
      || !['deny', 'allow'].includes(String(effectivePolicy.network))
      || !['empty', 'minimal', 'inherit'].includes(String(effectivePolicy.environment)))) {
    throw new Error('Runtime observer returned an invalid effective execution policy');
  }
  const effectiveCapabilities = value.effectiveCapabilities;
  if (effectiveCapabilities !== undefined
    && (!isRecord(effectiveCapabilities)
      || effectiveCapabilities.version !== 1
      || typeof effectiveCapabilities.repositoryRead !== 'boolean'
      || ['repositoryPatch', 'testRun', 'gitInspect', 'inputRead'].some(field =>
        effectiveCapabilities[field] !== undefined
        && typeof effectiveCapabilities[field] !== 'boolean'))) {
    throw new Error('Runtime observer returned invalid effective execution capabilities');
  }
  if (effectiveCapabilities?.repositoryRead === true
    && (!executionContext
      || executionContext.repositoryReadRoot !== executionContext.workingDirectory)) {
    throw new Error('Repository-read evidence requires an exact reader root matching the execution checkout');
  }
  if (effectiveCapabilities?.repositoryRead === false && executionContext?.repositoryReadRoot !== undefined) {
    throw new Error('Repository-read root cannot be present when repository-read capability is disabled');
  }
  if (effectiveCapabilities?.repositoryPatch === true
    && executionContext?.repositoryWriteRoot !== executionContext?.workingDirectory) {
    throw new Error('Repository patch evidence requires an exact writer root matching the execution workspace');
  }
  if (effectiveCapabilities?.repositoryPatch !== true
    && executionContext?.repositoryWriteRoot !== undefined) {
    throw new Error('Repository write root cannot be present when repository patch is disabled');
  }
  if (effectiveCapabilities?.inputRead === true
    && (!executionContext || !Array.isArray(executionContext.inputIds)
      || executionContext.inputIds.length === 0)) {
    throw new Error('Input-read evidence requires an exact non-empty Input allowlist');
  }
  if (effectiveCapabilities?.inputRead !== true && executionContext?.inputIds !== undefined) {
    throw new Error('Input allowlist cannot be present when Input-read capability is disabled');
  }
  if (correlation !== 'exact' && (executionContext !== undefined
    || effectivePolicy !== undefined || effectiveCapabilities !== undefined)) {
    throw new Error('Only exact runtime observations may carry execution context evidence');
  }
  const resultText = boundedOptional(value.resultText, EXECUTION_RESULT_MAX_CHARS);
  if (resultText && (correlation !== 'exact' || kind !== 'turn-completed')) {
    throw new Error('Execution result text requires exact turn-completion evidence');
  }
  const toolOperations = normalizeToolOperations(
    value.toolOperations,
    executionContext,
    effectivePolicy,
    effectiveCapabilities,
  );
  if (toolOperations && correlation !== 'exact') {
    throw new Error('Only exact runtime observations may carry tool operation evidence');
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
    ...(resultText ? { resultText } : {}),
    ...(executionContext
      ? {
          executionContext: {
            workingDirectory: String(executionContext.workingDirectory),
            ...(executionContext.repositoryReadRoot
              ? { repositoryReadRoot: String(executionContext.repositoryReadRoot) }
              : {}),
            ...(executionContext.repositoryWriteRoot
              ? { repositoryWriteRoot: String(executionContext.repositoryWriteRoot) }
              : {}),
            ...(Array.isArray(executionContext.inputIds)
              ? { inputIds: executionContext.inputIds.map(String) }
              : {}),
          },
        }
      : {}),
    ...(effectivePolicy
      ? {
          effectivePolicy: {
            version: 1,
            filesystem: effectivePolicy.filesystem as 'none' | 'read-only' | 'workspace-write',
            network: effectivePolicy.network as 'deny' | 'allow',
            environment: effectivePolicy.environment as 'empty' | 'minimal' | 'inherit',
          },
        }
      : {}),
    ...(effectiveCapabilities
      ? {
          effectiveCapabilities: {
            version: 1,
            repositoryRead: Boolean(effectiveCapabilities.repositoryRead),
            ...(effectiveCapabilities.repositoryPatch !== undefined
              ? { repositoryPatch: Boolean(effectiveCapabilities.repositoryPatch) }
              : {}),
            ...(effectiveCapabilities.testRun !== undefined
              ? { testRun: Boolean(effectiveCapabilities.testRun) }
              : {}),
            ...(effectiveCapabilities.gitInspect !== undefined
              ? { gitInspect: Boolean(effectiveCapabilities.gitInspect) }
              : {}),
            ...(effectiveCapabilities.inputRead !== undefined
              ? { inputRead: Boolean(effectiveCapabilities.inputRead) }
              : {}),
          },
        }
      : {}),
    ...(toolOperations ? { toolOperations } : {}),
  };
}

function normalizeToolOperations(
  value: unknown,
  executionContext: Record<string, unknown> | undefined,
  effectivePolicy: Record<string, unknown> | undefined,
  effectiveCapabilities: Record<string, unknown> | undefined,
): RuntimeExecutionObservation['toolOperations'] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('Runtime observer returned invalid tool operation evidence');
  }
  return value.map(item => {
    if (!isRecord(item)
      || !['repository', 'test', 'git', 'inputs'].includes(String(item.namespace))
      || typeof item.operation !== 'string' || !item.operation.trim()
      || typeof item.success !== 'boolean'
      || typeof item.occurredAt !== 'string'
      || Number.isNaN(new Date(item.occurredAt).getTime())) {
      throw new Error('Runtime observer returned invalid tool operation evidence');
    }
    if (item.namespace === 'inputs') {
      return normalizeInputToolOperation(
        item,
        executionContext,
        effectivePolicy,
        effectiveCapabilities,
      );
    }
    const stdout = boundedToolOutput(item.stdout);
    const stderr = boundedToolOutput(item.stderr);
    const ephemeralArtifacts = normalizeEphemeralArtifacts(item.ephemeralArtifacts);
    return {
      namespace: item.namespace as 'repository' | 'test' | 'git',
      operation: boundedRequired(item.operation, 'Tool operation', 100),
      success: item.success,
      occurredAt: item.occurredAt,
      ...(boundedOptional(item.path, 1_024) ? { path: boundedOptional(item.path, 1_024) } : {}),
      ...(boundedOptional(item.commandId, 100) ? { commandId: boundedOptional(item.commandId, 100) } : {}),
      ...(boundedOptional(item.command, 500) ? { command: boundedOptional(item.command, 500) } : {}),
      ...(typeof item.exitCode === 'number' && Number.isInteger(item.exitCode)
        ? { exitCode: item.exitCode }
        : {}),
      ...(typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0
        ? { durationMs: item.durationMs }
        : {}),
      ...(stdout.text ? { stdout: stdout.text } : {}),
      ...(stderr.text ? { stderr: stderr.text } : {}),
      ...((stdout.truncated || stderr.truncated || item.outputTruncated === true)
        ? { outputTruncated: true }
        : {}),
      ...(boundedOptional(item.errorCode, 100)
        ? { errorCode: boundedOptional(item.errorCode, 100) }
        : {}),
      ...(ephemeralArtifacts ? { ephemeralArtifacts } : {}),
    };
  });
}

function normalizeInputToolOperation(
  item: Record<string, unknown>,
  executionContext: Record<string, unknown> | undefined,
  effectivePolicy: Record<string, unknown> | undefined,
  effectiveCapabilities: Record<string, unknown> | undefined,
): NonNullable<RuntimeExecutionObservation['toolOperations']>[number] {
  if (effectiveCapabilities?.inputRead !== true
    || !executionContext || !isValidInputIdList(executionContext.inputIds)) {
    throw new Error('Input tool evidence requires an exact Input-read allowlist');
  }
  for (const forbidden of ['data', 'storageReference', 'raw', 'bytes', 'stdout', 'stderr']) {
    if (item[forbidden] !== undefined) {
      throw new Error('Input tool evidence cannot expose Input contents or storage paths');
    }
  }
  const operation = boundedRequired(item.operation, 'Tool operation', 100);
  if (!['list', 'read', 'copy_to_repository'].includes(operation)) {
    throw new Error(`Runtime observer returned an unsupported Input operation: ${operation}`);
  }
  const attachedInputIds = executionContext.inputIds as string[];
  const occurredAt = String(item.occurredAt);
  const success = Boolean(item.success);
  const errorCode = boundedOptional(item.errorCode, 100);

  if (operation === 'list') {
    const inputIds = item.inputIds === undefined
      ? undefined
      : normalizeInputIds(item.inputIds);
    if (inputIds && !sameStringSet(inputIds, attachedInputIds)) {
      throw new Error('Input list evidence does not match the exact attached Input allowlist');
    }
    const itemCount = item.itemCount === undefined
      ? undefined
      : boundedInteger(item.itemCount, 'Input list item count', 0, 20);
    if (itemCount !== undefined && itemCount !== (inputIds?.length ?? attachedInputIds.length)) {
      throw new Error('Input list evidence item count does not match its Input identities');
    }
    return {
      namespace: 'inputs', operation, success, occurredAt,
      ...(inputIds ? { inputIds } : {}),
      ...(itemCount !== undefined ? { itemCount } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }

  const inputId = item.inputId === undefined && attachedInputIds.length === 1
    ? attachedInputIds[0]
    : normalizeInputId(item.inputId);
  if (!inputId || !attachedInputIds.includes(inputId)) {
    throw new Error('Input tool evidence identifies an unattached Input');
  }

  if (operation === 'read') {
    const offset = optionalBoundedInteger(item.offset, 'Input read offset', 0, Number.MAX_SAFE_INTEGER);
    const requestedLength = optionalBoundedInteger(item.requestedLength, 'Input read requested length', 1, 65_536);
    const returnedLength = optionalBoundedInteger(item.returnedLength, 'Input read returned length', 0, 65_536);
    if (returnedLength !== undefined && requestedLength !== undefined && returnedLength > requestedLength) {
      throw new Error('Input read evidence returned more bytes than requested');
    }
    const endOfInput = item.endOfInput === undefined
      ? undefined
      : requiredBoolean(item.endOfInput, 'Input read end marker');
    const byteSize = optionalBoundedInteger(item.byteSize, 'Input byte size', 0, Number.MAX_SAFE_INTEGER);
    const sha256 = optionalSha256(item.sha256);
    return {
      namespace: 'inputs', operation, success, occurredAt, inputId,
      ...(offset !== undefined ? { offset } : {}),
      ...(requestedLength !== undefined ? { requestedLength } : {}),
      ...(returnedLength !== undefined ? { returnedLength } : {}),
      ...(endOfInput !== undefined ? { endOfInput } : {}),
      ...(byteSize !== undefined ? { byteSize } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }

  if (effectiveCapabilities?.repositoryPatch !== true
    || effectivePolicy?.filesystem !== 'workspace-write'
    || executionContext.repositoryWriteRoot !== executionContext.workingDirectory) {
    throw new Error('Input copy evidence requires the exact isolated repository write boundary');
  }
  const path = boundedRequired(item.path, 'Input copy destination path', 1_024);
  if (!isSafeRepositoryRelativePath(path)) {
    throw new Error('Input copy evidence contains an invalid repository-relative destination');
  }
  const byteSize = optionalBoundedInteger(item.byteSize, 'Input byte size', 0, Number.MAX_SAFE_INTEGER);
  const sha256 = optionalSha256(item.sha256);
  return {
    namespace: 'inputs', operation, success, occurredAt, inputId, path,
    ...(byteSize !== undefined ? { byteSize } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function validateObservationInputBoundary(
  observation: RuntimeExecutionObservation,
  plan: DurableExecutionPlan,
): void {
  if (observation.correlation !== 'exact') return;
  const planned = [...(plan.inputIds ?? [])];
  const observed = [...(observation.executionContext?.inputIds ?? [])];
  if ((planned.length > 0 || observed.length > 0) && !sameStringSet(planned, observed)) {
    throw new Error('Runtime observation Input allowlist does not match the immutable Execution Plan');
  }
}

function isValidInputIdList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return false;
  const normalized = value.map(normalizeInputId);
  return normalized.every((item): item is string => Boolean(item))
    && new Set(normalized).size === normalized.length;
}

function normalizeInputIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('Input list evidence contains an invalid Input identity collection');
  }
  const normalized = value.map(normalizeInputId);
  if (normalized.some(item => !item) || new Set(normalized).size !== normalized.length) {
    throw new Error('Input list evidence contains invalid or duplicate Input identities');
  }
  return normalized as string[];
}

function normalizeInputId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  return /^input:[A-Za-z0-9-]{1,200}$/.test(clean) ? clean : undefined;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function optionalBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined ? undefined : boundedInteger(value, field, minimum, maximum);
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be boolean`);
  return value;
}

function optionalSha256(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('Input evidence SHA-256 is invalid');
  }
  return value.toLowerCase();
}

function isSafeRepositoryRelativePath(value: string): boolean {
  return !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && resolve('/', value) === `/${value}`;
}

function normalizeEphemeralArtifacts(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) {
    throw new Error('Runtime observer returned invalid ephemeral artifact evidence');
  }
  return value.map(item => {
    if (!isRecord(item)
      || typeof item.path !== 'string'
      || !item.path.trim()
      || item.path.length > 200
      || item.path.includes('\0')
      || item.path.includes('/')
      || !['file', 'directory', 'symlink', 'other'].includes(String(item.kind))
      || typeof item.byteSize !== 'number'
      || !Number.isSafeInteger(item.byteSize)
      || item.byteSize < 0
      || typeof item.fileCount !== 'number'
      || !Number.isSafeInteger(item.fileCount)
      || item.fileCount < 0
      || item.cleanupStatus !== 'removed') {
      throw new Error('Runtime observer returned invalid ephemeral artifact evidence');
    }
    return {
      path: item.path,
      kind: item.kind as 'file' | 'directory' | 'symlink' | 'other',
      byteSize: item.byteSize,
      fileCount: item.fileCount,
      cleanupStatus: 'removed' as const,
    };
  });
}

function boundedToolOutput(value: unknown): { text?: string; truncated: boolean } {
  if (value === undefined || value === null) return { truncated: false };
  if (typeof value !== 'string') throw new Error('Optional Observation text must be a string');
  const clean = value.trim();
  if (!clean) return { truncated: false };
  return clean.length > MAX_OUTPUT_SUMMARY_LENGTH
    ? { text: clean.slice(0, MAX_OUTPUT_SUMMARY_LENGTH), truncated: true }
    : { text: clean, truncated: false };
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
