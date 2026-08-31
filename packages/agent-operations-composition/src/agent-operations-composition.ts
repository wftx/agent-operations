import {
  NoopOperatorNotifier,
  OperatorApplicationService,
  OrchestratorConversationApplicationService,
  OrchestratorToolApplicationService,
  type OperatorApplication,
  type OrchestratorConversationService,
} from '../../agent-operations-application/src/index.js';
import { OrchestrationService, RepositoryWorkspaceService } from '../../agent-operations-core/src/index.js';
import {
  CortextOSRuntimeAdapter,
  CortextOSRuntimeLifecycleAdapter,
} from '../../cortextos-adapter/src/index.js';
import { CortextOSOrchestratorConversationAdapter } from '../../cortextos-conversation-adapter/src/index.js';
import { CortextOSExecutionAdapter } from '../../cortextos-execution-adapter/src/index.js';
import { CortextOSExecutionObserver } from '../../cortextos-execution-observer/src/index.js';
import { GitRepositoryAdapter, GitRepositoryWorkspaceAdapter } from '../../git-adapter/src/index.js';
import {
  SqliteAgentOperationsStateStore,
  resolveAgentOperationsStateLocation,
} from '../../sqlite-state-adapter/src/index.js';
import {
  TelegramOperatorNotifier,
  loadAgentOperationsTelegramEnvironmentFile,
  loadTelegramOperatorNotificationConfig,
} from '../../telegram-notification-adapter/src/index.js';

export interface AgentOperationsCompositionOptions {
  readonly startRunner?: boolean;
  readonly runnerPollIntervalMs?: number;
  readonly deferRunnerWake?: boolean;
}

export interface AgentOperationsComposition {
  readonly operator: OperatorApplication;
  readonly conversation: OrchestratorConversationService;
  readonly tools: OrchestratorToolApplicationService;
  readonly telegramConfigured: boolean;
  close(): Promise<void>;
}

/** The only production module that assembles AO concrete infrastructure. */
export function createAgentOperationsComposition(
  options: AgentOperationsCompositionOptions = {},
): AgentOperationsComposition {
  const store = SqliteAgentOperationsStateStore.open();
  const runtime = new CortextOSRuntimeAdapter();
  const runtimeLifecycle = new CortextOSRuntimeLifecycleAdapter({ runtime });
  const repositories = new GitRepositoryAdapter();
  const stateLocation = resolveAgentOperationsStateLocation();
  const repositoryWorkspace = new RepositoryWorkspaceService(
    store,
    repositories,
    new GitRepositoryWorkspaceAdapter({ workspaceRoot: `${stateLocation.stateDirectory}/workspaces` }),
    { stateDirectory: stateLocation.stateDirectory },
  );
  const orchestration = new OrchestrationService(
    store,
    runtime,
    repositories,
    new CortextOSExecutionAdapter(),
    new CortextOSExecutionObserver(),
    { workspaceService: repositoryWorkspace },
  );
  const notification = loadNotifier();
  const operator = new OperatorApplicationService(store, orchestration, {
    runtime,
    runtimeLifecycle,
    notifier: notification.notifier,
    ...(options.deferRunnerWake !== undefined ? { deferRunnerWake: options.deferRunnerWake } : {}),
  });
  const conversation = new OrchestratorConversationApplicationService(
    new CortextOSOrchestratorConversationAdapter(),
  );
  const tools = new OrchestratorToolApplicationService(operator);
  let runnerTimer: ReturnType<typeof setInterval> | null = null;
  if (options.startRunner) {
    operator.startRunner();
    runnerTimer = setInterval(
      () => operator.startRunner(),
      options.runnerPollIntervalMs ?? 1_000,
    );
    runnerTimer.unref();
  }
  return {
    operator,
    conversation,
    tools,
    telegramConfigured: notification.configured,
    async close() {
      if (runnerTimer) clearInterval(runnerTimer);
      await store.close();
    },
  };
}

function loadNotifier() {
  try {
    loadAgentOperationsTelegramEnvironmentFile();
    const config = loadTelegramOperatorNotificationConfig();
    return {
      notifier: config ? new TelegramOperatorNotifier(config) : new NoopOperatorNotifier(),
      configured: config !== null,
    };
  } catch (error) {
    console.warn(`Agent Operations Telegram notifications disabled: ${error instanceof Error ? error.message : String(error)}`);
    return { notifier: new NoopOperatorNotifier(), configured: false };
  }
}
