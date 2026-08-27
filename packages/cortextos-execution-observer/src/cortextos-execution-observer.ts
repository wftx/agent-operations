import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  AgentRuntimeAdapter,
  RuntimeExecutionObservation,
  RuntimeExecutionObservationAdapter,
  RuntimeExecutionObservationRequest,
} from '../../agent-operations-contracts/src/index.js';
import {
  CortextOSRuntimeAdapter,
  parseCodexExecutionReference,
} from '../../cortextos-adapter/src/index.js';
import { EXECUTION_RESULT_MAX_CHARS } from '../../agent-operations-contracts/src/index.js';

interface CorrelatedTurnRecord {
  readonly version: 1;
  readonly provider: 'codex';
  readonly threadId: string;
  readonly turnId: string;
  readonly status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  readonly observedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly resultText?: string;
  readonly workingDirectory?: string;
  readonly repositoryReadRoot?: string;
  readonly effectivePolicy?: {
    readonly version: 1;
    readonly filesystem: 'none' | 'read-only' | 'workspace-write';
    readonly network: 'deny' | 'allow';
    readonly environment: 'empty' | 'minimal' | 'inherit';
  };
  readonly effectiveCapabilities?: {
    readonly version: 1;
    readonly repositoryRead: boolean;
  };
  readonly repositoryReadOperations?: readonly {
    readonly operation: 'list' | 'read' | 'search';
    readonly path: string;
    readonly query?: string;
    readonly success: boolean;
    readonly occurredAt: string;
    readonly errorCode?: string;
  }[];
}

export interface CortextOSExecutionObserverOptions {
  readonly runtimeAdapter?: AgentRuntimeAdapter;
  readonly instanceId?: string;
  readonly ctxRoot?: string;
  readonly now?: () => Date;
}

/**
 * Read-only CortextOS observer. Generic running/idle signals remain weak; a
 * native Codex turn record may additionally produce exact turn evidence.
 */
export class CortextOSExecutionObserver implements RuntimeExecutionObservationAdapter {
  private readonly runtimes: AgentRuntimeAdapter;
  private readonly ctxRoot: string;
  private readonly now: () => Date;

  constructor(options: CortextOSExecutionObserverOptions = {}) {
    const instanceId = options.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default';
    this.runtimes = options.runtimeAdapter ?? new CortextOSRuntimeAdapter({ instanceId });
    this.ctxRoot = options.ctxRoot
      ?? process.env.CTX_ROOT
      ?? join(homedir(), '.cortextos', instanceId);
    this.now = options.now ?? (() => new Date());
  }

  async observe(
    request: RuntimeExecutionObservationRequest,
  ): Promise<readonly RuntimeExecutionObservation[]> {
    const observations: RuntimeExecutionObservation[] = [];
    try {
      const runtime = await this.runtimes.getAgent(request.runtimeAgentId);
      if (!runtime) {
        return [this.unavailable(request, 'CortextOS did not return the configured runtime.')];
      }
      const reason = runtime.health.reason;
      const crashed = runtime.health.state === 'degraded'
        && Boolean(reason && /crash|halt/i.test(reason));
      const kind = crashed
        ? 'runtime-crashed'
        : runtime.health.state === 'running'
          ? 'runtime-running'
          : runtime.health.state === 'stopped'
            ? 'runtime-unavailable'
            : 'unknown';
      observations.push({
        source: 'cortextos-daemon-status',
        sourceEventId: `status:${request.runtimeAgentId}:${runtime.health.state}:${reason ?? ''}`,
        kind,
        correlation: 'agent-level',
        observedAt: runtime.observedAt,
        message: reason ?? `CortextOS runtime is ${runtime.health.state}; this is not Dispatch completion evidence.`,
      });

      const idle = this.readIdleObservation(request, runtime.provider);
      if (idle) observations.push(idle);
      const exact = this.readExactTurnObservation(request, runtime.provider);
      if (exact) observations.push(exact);
      return observations;
    } catch (error) {
      return [this.unavailable(
        request,
        `CortextOS observation failed: ${error instanceof Error ? error.message : String(error)}`,
      )];
    }
  }

  private readIdleObservation(
    request: RuntimeExecutionObservationRequest,
    provider: string,
  ): RuntimeExecutionObservation | null {
    if (provider !== 'claude' && provider !== 'codex') return null;
    const name = runtimeAgentName(request.runtimeAgentId);
    const path = join(this.ctxRoot, 'state', name, 'last_idle.flag');
    if (!existsSync(path)) return null;
    try {
      const epochSeconds = Number(readFileSync(path, 'utf8').trim());
      if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
      const observedAt = new Date(epochSeconds * 1000).toISOString();
      if (new Date(observedAt).getTime() < new Date(request.acceptedAt).getTime()) return null;
      return {
        source: 'cortextos-idle-flag',
        sourceEventId: `idle:${name}:${epochSeconds}`,
        kind: 'runtime-idle',
        correlation: 'agent-level',
        observedAt,
        message: 'The persistent agent became idle after acceptance; CortextOS cannot attribute that idle event to this Dispatch.',
      };
    } catch {
      return null;
    }
  }

  private readExactTurnObservation(
    request: RuntimeExecutionObservationRequest,
    provider: string,
  ): RuntimeExecutionObservation | null {
    if (!request.externalReference) return null;
    if (provider !== 'codex') {
      return this.unknownReference(request, 'The runtime provider cannot resolve a Codex turn reference.');
    }
    const reference = parseCodexExecutionReference(request.externalReference);
    if (!reference) {
      return this.unknownReference(request, 'The stored Codex turn reference is malformed.');
    }
    const name = runtimeAgentName(request.runtimeAgentId);
    const path = join(
      this.ctxRoot,
      'state',
      name,
      'codex-turns',
      reference.threadId,
      `${reference.turnId}.json`,
    );
    if (!existsSync(path)) {
      return this.unknownReference(request, 'No structured record exists for the accepted Codex turn.');
    }
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as CorrelatedTurnRecord;
      if (record.version !== 1 || record.provider !== 'codex'
        || record.threadId !== reference.threadId || record.turnId !== reference.turnId
        || !['inProgress', 'completed', 'failed', 'interrupted'].includes(record.status)
        || Number.isNaN(new Date(record.observedAt).getTime())
        || (record.resultText !== undefined
          && (typeof record.resultText !== 'string'
            || !record.resultText.trim()
            || record.resultText.length > EXECUTION_RESULT_MAX_CHARS))) {
        return this.unknownReference(request, 'The structured Codex turn record is malformed or mismatched.');
      }
      const kind = record.status === 'completed'
        ? 'turn-completed'
        : record.status === 'failed' || record.status === 'interrupted'
          ? 'runtime-crashed'
          : 'runtime-running';
      const candidateObservedAt = kind === 'runtime-running'
        ? (record.startedAt ?? record.observedAt)
        : (record.completedAt ?? record.observedAt);
      const observedAt = Number.isNaN(new Date(candidateObservedAt).getTime())
        ? record.observedAt
        : candidateObservedAt;
      const executionContext = typeof record.workingDirectory === 'string'
        && record.workingDirectory.startsWith('/')
        && resolve(record.workingDirectory) === record.workingDirectory
        && (record.repositoryReadRoot === undefined
          || (record.repositoryReadRoot === record.workingDirectory
            && resolve(record.repositoryReadRoot) === record.repositoryReadRoot))
        ? {
            workingDirectory: record.workingDirectory,
            ...(record.repositoryReadRoot
              ? { repositoryReadRoot: record.repositoryReadRoot }
              : {}),
          }
        : undefined;
      const effectivePolicy = parseExecutionPolicy(record.effectivePolicy);
      const effectiveCapabilities = parseExecutionCapabilities(record.effectiveCapabilities);
      return {
        source: 'cortextos-codex-turn-record',
        sourceEventId: `codex-turn:${record.threadId}:${record.turnId}:${record.status}`,
        kind,
        correlation: 'exact',
        correlatedDispatchId: request.dispatchId,
        runtimeSessionId: record.threadId,
        externalReference: request.externalReference,
        observedAt,
        ...(executionContext ? { executionContext } : {}),
        ...(effectivePolicy ? { effectivePolicy } : {}),
        ...(effectiveCapabilities ? { effectiveCapabilities } : {}),
        ...(record.status === 'completed' && record.resultText
          ? { resultText: record.resultText }
          : {}),
        ...(record.repositoryReadOperations?.length
          ? { outputSummary: `${record.repositoryReadOperations.length} bounded repository-read operation(s) recorded; file contents are not persisted.` }
          : {}),
        message: record.status === 'completed'
          ? 'Codex reported structured completion for the exact accepted turn; semantic outcome remains an Agent Operations control-plane decision.'
          : record.status === 'inProgress'
            ? 'The exact accepted Codex turn is still in progress.'
            : `The exact accepted Codex turn ended with status ${record.status}${record.error ? `: ${record.error}` : '.'}`,
      };
    } catch {
      return this.unknownReference(request, 'The structured Codex turn record could not be read.');
    }
  }

  private unknownReference(
    request: RuntimeExecutionObservationRequest,
    message: string,
  ): RuntimeExecutionObservation {
    return {
      source: 'cortextos-codex-turn-record',
      sourceEventId: `codex-turn-unavailable:${createHash('sha256')
        .update(`${request.externalReference ?? 'missing'}\0${message}`)
        .digest('hex')}`,
      kind: 'unknown',
      correlation: 'uncorrelated',
      observedAt: this.now().toISOString(),
      ...(request.externalReference ? { externalReference: request.externalReference } : {}),
      message,
    };
  }

  private unavailable(
    request: RuntimeExecutionObservationRequest,
    message: string,
  ): RuntimeExecutionObservation {
    return {
      source: 'cortextos-daemon-status',
      sourceEventId: `unavailable:${request.runtimeAgentId}:${message}`,
      kind: 'runtime-unavailable',
      correlation: 'uncorrelated',
      observedAt: this.now().toISOString(),
      message,
    };
  }
}

function parseExecutionPolicy(value: unknown): CorrelatedTurnRecord['effectivePolicy'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const policy = value as Record<string, unknown>;
  if (policy.version !== 1
    || !['none', 'read-only', 'workspace-write'].includes(String(policy.filesystem))
    || !['deny', 'allow'].includes(String(policy.network))
    || !['empty', 'minimal', 'inherit'].includes(String(policy.environment))) return undefined;
  return policy as unknown as NonNullable<CorrelatedTurnRecord['effectivePolicy']>;
}

function parseExecutionCapabilities(
  value: unknown,
): CorrelatedTurnRecord['effectiveCapabilities'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const capabilities = value as Record<string, unknown>;
  if (capabilities.version !== 1 || typeof capabilities.repositoryRead !== 'boolean') return undefined;
  return { version: 1, repositoryRead: capabilities.repositoryRead };
}

function runtimeAgentName(runtimeAgentId: string): string {
  const segments = runtimeAgentId.split('/');
  if (segments.length !== 2 || !segments[1]) throw new Error(`Invalid runtime ID: ${runtimeAgentId}`);
  const name = decodeURIComponent(segments[1]);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Invalid runtime ID: ${runtimeAgentId}`);
  return name;
}
