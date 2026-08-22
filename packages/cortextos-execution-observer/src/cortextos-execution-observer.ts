import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRuntimeAdapter,
  RuntimeExecutionObservation,
  RuntimeExecutionObservationAdapter,
  RuntimeExecutionObservationRequest,
} from '../../agent-operations-contracts/src/index.js';
import { CortextOSRuntimeAdapter } from '../../cortextos-adapter/src/index.js';

export interface CortextOSExecutionObserverOptions {
  readonly runtimeAdapter?: AgentRuntimeAdapter;
  readonly instanceId?: string;
  readonly ctxRoot?: string;
  readonly now?: () => Date;
}

/**
 * Read-only CortextOS observer. Current CortextOS exposes agent/session activity,
 * not an inject-agent correlation ID, so every emitted signal is deliberately weak.
 */
export class CortextOSExecutionObserver implements RuntimeExecutionObservationAdapter {
  private readonly runtimes: AgentRuntimeAdapter;
  private readonly ctxRoot: string;
  private readonly now: () => Date;

  constructor(options: CortextOSExecutionObserverOptions = {}) {
    const instanceId = options.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default';
    this.runtimes = options.runtimeAdapter ?? new CortextOSRuntimeAdapter({ instanceId });
    this.ctxRoot = options.ctxRoot ?? join(homedir(), '.cortextos', instanceId);
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

function runtimeAgentName(runtimeAgentId: string): string {
  const segments = runtimeAgentId.split('/');
  if (segments.length !== 2 || !segments[1]) throw new Error(`Invalid runtime ID: ${runtimeAgentId}`);
  const name = decodeURIComponent(segments[1]);
  if (!name.trim()) throw new Error(`Invalid runtime ID: ${runtimeAgentId}`);
  return name;
}
