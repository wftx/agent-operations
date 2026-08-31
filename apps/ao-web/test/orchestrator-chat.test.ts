import { describe, expect, it, vi } from 'vitest';
import type {
  OperatorApplication,
  OperatorJobDetail,
  OperatorProjectOption,
  OrchestratorConversationService,
} from '../../../packages/agent-operations-application/src/index.js';
import { OperatorWebApplication } from '../src/app.js';

const TIME = '2026-08-31T12:00:00.000Z';
const PROJECT: OperatorProjectOption = {
  project: { id: 'project:duck-face', name: 'Duck Face Event Co.', createdAt: TIME, updatedAt: TIME },
  repositories: [{
    id: 'remote:github.com/example/duck-face', identityKind: 'remote', name: 'duck-face',
    canonicalRemote: 'github.com/example/duck-face', createdAt: TIME, updatedAt: TIME,
  }],
  runtimeAgentIds: ['agent-operations/rehearsal'],
  runnable: true,
};

describe('AO Web Orchestrator chat', () => {
  it('renders conversation state without sending a turn or starting runtime', async () => {
    const operator = fakeOperator();
    const conversation = fakeConversation();
    const app = new OperatorWebApplication(operator, conversation);

    const response = await app.handle(new Request('http://127.0.0.1/orchestrator'));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('Tell AO what you want.');
    expect(body).toContain('Duck Face Event Co.');
    expect(conversation.sendTurn).not.toHaveBeenCalled();
    expect(operator.startRuntime).not.toHaveBeenCalled();
  });

  it('sends operator text through the conversation service', async () => {
    const operator = fakeOperator();
    const conversation = fakeConversation();
    const app = new OperatorWebApplication(operator, conversation);
    const form = new URLSearchParams({
      projectId: PROJECT.project.id,
      message: 'Inspect Mirror X and create a read only Job.',
    });

    const response = await app.handle(new Request('http://127.0.0.1/orchestrator/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/orchestrator');
    expect(conversation.sendTurn).toHaveBeenCalledWith({
      projectId: PROJECT.project.id,
      message: 'Inspect Mirror X and create a read only Job.',
    });
  });

  it('disables sending and does not start runtime when the Orchestrator is offline', async () => {
    const operator = fakeOperator();
    const conversation = fakeConversation({
      runtimeState: 'offline',
      runtimeReason: 'The dedicated Orchestrator is disabled.',
    });
    const app = new OperatorWebApplication(operator, conversation);

    const body = await (await app.handle(new Request('http://127.0.0.1/orchestrator'))).text();

    expect(body).toContain('The dedicated Orchestrator is disabled.');
    expect(body).toMatch(/<button disabled>Send<\/button>/);
    expect(operator.startRuntime).not.toHaveBeenCalled();
  });

  it('renders related Job links and current status from AO truth', async () => {
    const operator = fakeOperator();
    const conversation = fakeConversation({
      turns: [{
        id: 'conversation:1',
        operatorMessage: 'Inspect Mirror X.',
        response: 'I created a read only Job.',
        relatedJobIds: ['job:1'],
        clarificationRequired: false,
        status: 'completed',
        createdAt: TIME,
      }],
    });
    const app = new OperatorWebApplication(operator, conversation);

    const body = await (await app.handle(new Request('http://127.0.0.1/orchestrator'))).text();
    expect(body).toContain('/jobs/job%3A1');
    expect(body).toContain('Inspect Mirror X image wiring');
    expect(body).toContain('Needs Me');
    expect(operator.getJobDetail).toHaveBeenCalledWith('job:1');
  });
});

function fakeConversation(overrides: Record<string, unknown> = {}): OrchestratorConversationService & {
  sendTurn: ReturnType<typeof vi.fn>;
} {
  const state = {
    agentId: 'ao-orchestrator',
    sessionId: 'cortextos:default:ao-orchestrator',
    runtimeState: 'ready' as const,
    turns: [],
    ...overrides,
  };
  return {
    sendTurn: vi.fn(async input => ({
      agentId: state.agentId,
      sessionId: state.sessionId,
      turn: {
        id: 'conversation:sent', operatorMessage: input.message, response: 'Done.', relatedJobIds: [],
        clarificationRequired: false, status: 'completed' as const, createdAt: TIME,
      },
    })),
    getConversationState: vi.fn(async () => state),
  };
}

function fakeOperator(): OperatorApplication {
  const detail = {
    summary: {
      job: { id: 'job:1', projectId: PROJECT.project.id, title: 'Inspect Mirror X image wiring' },
      orchestrationState: 'Needs Me',
    },
  } as unknown as OperatorJobDetail;
  return {
    startRunner() {},
    listProjects: vi.fn(async () => [PROJECT]),
    getRuntimeStatus: vi.fn(),
    startRuntime: vi.fn(),
    previewTask: vi.fn(),
    runOperatorJob: vi.fn(),
    waitForRun: vi.fn(),
    provideGuidanceAndContinue: vi.fn(),
    reconcileTimedOutExecution: vi.fn(),
    cancelEscalatedJob: vi.fn(),
    listJobs: vi.fn(async () => []),
    getJobDetail: vi.fn(async () => detail),
  };
}
