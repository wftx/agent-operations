import type {
  OrchestratorConversationRuntime,
  OrchestratorConversationService,
  OrchestratorConversationState,
  OrchestratorTurnInput,
  OrchestratorTurnResult,
} from './types.js';

/** Thin application boundary. CortextOS owns the session and conversation records. */
export class OrchestratorConversationApplicationService implements OrchestratorConversationService {
  constructor(private readonly runtime: OrchestratorConversationRuntime) {}

  async sendTurn(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult> {
    const message = requiredText(input.message, 'Message', 16_384);
    const projectId = input.projectId === undefined
      ? undefined
      : requiredText(input.projectId, 'Project ID', 500);
    return this.runtime.sendTurn({ message, ...(projectId ? { projectId } : {}) });
  }

  getConversationState(): Promise<OrchestratorConversationState> {
    return this.runtime.getConversationState();
  }
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
}
