import type {
  AgentOperationsStateStore,
} from '../../agent-operations-contracts/src/index.js';
import type {
  OrchestratorConversationRuntime,
  OrchestratorConversationService,
  OrchestratorConversationState,
  OrchestratorTurnInput,
  OrchestratorTurnResult,
} from './types.js';

/** Thin application boundary. CortextOS owns the session and conversation records. */
export class OrchestratorConversationApplicationService implements OrchestratorConversationService {
  constructor(
    private readonly runtime: OrchestratorConversationRuntime,
    private readonly store?: AgentOperationsStateStore,
  ) {}

  async sendTurn(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult> {
    const message = requiredText(input.message, 'Message', 16_384);
    const projectId = input.projectId === undefined
      ? undefined
      : requiredText(input.projectId, 'Project ID', 500);
    const inputIds = [...new Set(input.inputIds ?? [])];
    if (inputIds.length > 20) throw new Error('A conversation turn supports at most 20 Inputs');
    if (this.store) {
      for (const inputId of inputIds) {
        const durableInput = await this.store.getInput(inputId);
        if (!durableInput) throw new Error(`Input not found: ${inputId}`);
        if (projectId && durableInput.projectId && durableInput.projectId !== projectId) {
          throw new Error(`Input ${inputId} belongs to another Project`);
        }
      }
    } else if (inputIds.length) {
      throw new Error('Conversation Inputs are not configured');
    }
    const result = await this.runtime.sendTurn({
      message,
      ...(projectId ? { projectId } : {}),
      ...(inputIds.length ? { inputIds } : {}),
    });
    if (this.store && inputIds.length) await this.store.associateInputsWithConversation(result.turn.id, inputIds);
    return result;
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
