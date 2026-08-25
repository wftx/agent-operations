import { createConnection } from 'node:net';
import type {
  RuntimeDispatchRequest,
  RuntimeDispatchResult,
  RuntimeExecutionAdapter,
} from '../../agent-operations-contracts/src/index.js';
import {
  createCodexExecutionReference,
  resolveCortextOSSocketPath,
} from '../../cortextos-adapter/src/index.js';

type RequestSender = (
  agentName: string,
  instruction: string,
  request: RuntimeDispatchRequest,
) => Promise<unknown>;

export interface CortextOSExecutionAdapterOptions {
  readonly instanceId?: string;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
  /** Require one newly created structured Codex turn rather than generic injection. */
  readonly requireExactTurnCorrelation?: boolean;
  /** Test/embedding seam around the established inject-agent IPC command. */
  readonly requestSender?: RequestSender;
}

export class CortextOSExecutionTransportError extends Error {
  constructor(
    message: string,
    readonly submissionPossible: boolean,
  ) {
    super(message);
    this.name = 'CortextOSExecutionTransportError';
  }
}

/** Mutation-capable adapter for the existing acknowledged inject-agent daemon IPC command. */
export class CortextOSExecutionAdapter implements RuntimeExecutionAdapter {
  private readonly sender: RequestSender;
  private readonly requireExactTurnCorrelation: boolean;

  constructor(options: CortextOSExecutionAdapterOptions = {}) {
    const instanceId = options.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default';
    if (!/^[A-Za-z0-9_-]+$/.test(instanceId)) throw new Error(`Invalid CortextOS instance ID: ${instanceId}`);
    const socketPath = options.socketPath ?? resolveCortextOSSocketPath(instanceId);
    const timeoutMs = options.timeoutMs ?? 5_000;
    const requireExactTurnCorrelation = options.requireExactTurnCorrelation ?? true;
    this.requireExactTurnCorrelation = requireExactTurnCorrelation;
    this.sender = options.requestSender
      ?? ((agentName, instruction, request) => sendInjectRequest(
        socketPath,
        timeoutMs,
        agentName,
        instruction,
        request.dispatchId,
        request.idempotencyKey,
        requireExactTurnCorrelation,
      ));
  }

  async dispatch(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResult> {
    const agentName = runtimeAgentName(request.runtimeAgentId);
    try {
      const response = await this.sender(agentName, request.input.instruction, request);
      if (!isRecord(response) || typeof response.success !== 'boolean') {
        return { status: 'uncertain', message: 'CortextOS daemon returned a malformed acknowledgement.' };
      }
      if (response.success) {
        const data = isRecord(response.data) ? response.data : null;
        const execution = data && isRecord(data.execution) ? data.execution : null;
        if (execution) {
          if (execution.provider !== 'codex'
            || typeof execution.sessionId !== 'string'
            || typeof execution.turnId !== 'string') {
            return { status: 'uncertain', message: 'CortextOS returned a malformed structured execution reference.' };
          }
          try {
            const message = typeof data?.message === 'string'
              ? data.message
              : `CortextOS started a correlated Codex turn for ${agentName}.`;
            return {
              status: 'accepted',
              externalReference: createCodexExecutionReference(
                execution.sessionId,
                execution.turnId,
              ),
              message,
            };
          } catch {
            return { status: 'uncertain', message: 'CortextOS returned invalid Codex turn identifiers.' };
          }
        }
        if (this.requireExactTurnCorrelation) {
          return {
            status: 'uncertain',
            message: 'CortextOS accepted injection without a structured turn reference.',
          };
        }
        return {
          status: 'accepted',
          message: typeof response.data === 'string'
            ? response.data
            : `CortextOS accepted injection for ${agentName}.`,
        };
      }
      if (response.code === 'SUBMISSION_UNCERTAIN') {
        return {
          status: 'uncertain',
          message: typeof response.error === 'string'
            ? response.error
            : `CortextOS could not prove whether a turn started for ${agentName}.`,
        };
      }
      return {
        status: 'rejected',
        message: typeof response.error === 'string'
          ? response.error
          : `CortextOS rejected injection for ${agentName}.`,
      };
    } catch (error) {
      if (error instanceof CortextOSExecutionTransportError && !error.submissionPossible) {
        return { status: 'rejected', message: error.message };
      }
      return {
        status: 'uncertain',
        message: `CortextOS acknowledgement is uncertain: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

function runtimeAgentName(runtimeAgentId: string): string {
  const segments = runtimeAgentId.split('/');
  if (segments.length !== 2 || !segments[1]) {
    throw new Error(`Invalid Agent Operations runtime ID: ${runtimeAgentId}`);
  }
  try {
    const name = decodeURIComponent(segments[1]);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('invalid name');
    return name;
  } catch {
    throw new Error(`Invalid Agent Operations runtime ID: ${runtimeAgentId}`);
  }
}

function sendInjectRequest(
  socketPath: string,
  timeoutMs: number,
  agentName: string,
  instruction: string,
  dispatchId: string,
  correlationId: string,
  requireExactTurnCorrelation: boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    let settled = false;
    let submissionPossible = false;
    const finish = (value: unknown, error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.on('connect', () => {
      submissionPossible = true;
      socket.write(JSON.stringify({
        type: 'inject-agent',
        agent: agentName,
        data: {
          text: instruction,
          ...(requireExactTurnCorrelation
            ? { requireNewTurn: true, correlationId }
            : {}),
        },
        source: `agent-operations manual dispatch ${dispatchId}`,
      }));
    });
    socket.on('data', chunk => {
      response += chunk.toString();
    });
    socket.on('end', () => {
      try {
        finish(JSON.parse(response));
      } catch {
        finish(response);
      }
    });
    socket.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      const knownUnavailable = !submissionPossible && (code === 'ENOENT' || code === 'ECONNREFUSED');
      finish(undefined, new CortextOSExecutionTransportError(
        knownUnavailable ? 'CortextOS daemon is not running.' : `CortextOS IPC failed: ${error.message}`,
        submissionPossible,
      ));
    });
    socket.setTimeout(timeoutMs, () => {
      finish(undefined, new CortextOSExecutionTransportError(
        'CortextOS inject-agent request timed out.',
        submissionPossible,
      ));
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
