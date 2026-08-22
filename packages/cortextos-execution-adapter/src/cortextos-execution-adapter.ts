import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import type {
  RuntimeDispatchRequest,
  RuntimeDispatchResult,
  RuntimeExecutionAdapter,
} from '../../agent-operations-contracts/src/index.js';

type RequestSender = (
  agentName: string,
  instruction: string,
  request: RuntimeDispatchRequest,
) => Promise<unknown>;

export interface CortextOSExecutionAdapterOptions {
  readonly instanceId?: string;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
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

  constructor(options: CortextOSExecutionAdapterOptions = {}) {
    const instanceId = options.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default';
    if (!/^[A-Za-z0-9_-]+$/.test(instanceId)) throw new Error(`Invalid CortextOS instance ID: ${instanceId}`);
    const socketPath = options.socketPath ?? defaultSocketPath(instanceId);
    const timeoutMs = options.timeoutMs ?? 5_000;
    this.sender = options.requestSender
      ?? ((agentName, instruction, request) => sendInjectRequest(
        socketPath,
        timeoutMs,
        agentName,
        instruction,
        request.dispatchId,
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
        return {
          status: 'accepted',
          message: typeof response.data === 'string'
            ? response.data
            : `CortextOS accepted injection for ${agentName}.`,
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
    if (!name.trim()) throw new Error('empty name');
    return name;
  } catch {
    throw new Error(`Invalid Agent Operations runtime ID: ${runtimeAgentId}`);
  }
}

function defaultSocketPath(instanceId: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\cortextos-${instanceId}`
    : join(homedir(), '.cortextos', instanceId, 'daemon.sock');
}

function sendInjectRequest(
  socketPath: string,
  timeoutMs: number,
  agentName: string,
  instruction: string,
  dispatchId: string,
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
        data: { text: instruction },
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
