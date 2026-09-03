import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  NoopOperatorNotifier,
  OperatorApplicationService,
  ProjectApplicationService,
  InputApplicationService,
  PreviewApplicationService,
  TrustProfileApplicationService,
  RuntimeFreshnessService,
  DailyDriverMetricsService,
  OrchestratorConversationApplicationService,
  OrchestratorToolApplicationService,
  type OperatorApplication,
  type OrchestratorConversationService,
  type ProjectApplication,
  type InputApplication,
  type PreviewApplication,
  type TrustProfileApplication,
  type RuntimeFreshnessApplication,
  type DailyDriverMetricsApplication,
} from '../../agent-operations-application/src/index.js';
import { OrchestrationService, RepositoryWorkspaceService } from '../../agent-operations-core/src/index.js';
import {
  CortextOSRuntimeAdapter,
  CortextOSRuntimeLifecycleAdapter,
} from '../../cortextos-adapter/src/index.js';
import {
  CortextOSOrchestratorConversationAdapter,
  EXPECTED_AO_ORCHESTRATOR_TOOL_CATALOG_REVISION,
} from '../../cortextos-conversation-adapter/src/index.js';
import { CortextOSExecutionAdapter } from '../../cortextos-execution-adapter/src/index.js';
import { CortextOSExecutionObserver } from '../../cortextos-execution-observer/src/index.js';
import { GitPreviewWorkspaceAdapter, GitRepositoryAdapter, GitRepositoryWorkspaceAdapter } from '../../git-adapter/src/index.js';
import { NodePreviewProcessAdapter, PlaywrightBoundedBrowserAdapter } from '../../preview-browser-adapter/src/index.js';
import {
  FileInputObjectStorage,
  LocalProjectResourceInspector,
  SecureAuthorizedUrlInputFetcher,
} from '../../project-input-adapter/src/index.js';
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
  readonly projects: ProjectApplication;
  readonly inputs: InputApplication;
  readonly preview: PreviewApplication;
  readonly trustProfiles: TrustProfileApplication;
  readonly runtimeFreshness: RuntimeFreshnessApplication;
  readonly metrics: DailyDriverMetricsApplication;
  readonly telegramConfigured: boolean;
  close(): Promise<void>;
}

/** The only production module that assembles AO concrete infrastructure. */
export function createAgentOperationsComposition(
  options: AgentOperationsCompositionOptions = {},
): AgentOperationsComposition {
  const store = SqliteAgentOperationsStateStore.open();
  const frameworkRoot = resolveFrameworkRoot();
  const runtime = new CortextOSRuntimeAdapter({ frameworkRoot });
  const runtimeLifecycle = new CortextOSRuntimeLifecycleAdapter({ runtime, frameworkRoot });
  const repositories = new GitRepositoryAdapter();
  const stateLocation = resolveAgentOperationsStateLocation();
  const projects = new ProjectApplicationService(store, repositories, new LocalProjectResourceInspector(), {
    runtimeAgentIds: ['agent-operations/rehearsal'],
  });
  const trustProfiles = new TrustProfileApplicationService(store);
  const runtimeFreshness = new RuntimeFreshnessService(
    store,
    runtime,
    runtimeLifecycle,
    trustProfiles,
    {
      expectedToolCatalogRevision: EXPECTED_AO_ORCHESTRATOR_TOOL_CATALOG_REVISION,
      ...expectedRuntimeRevision(frameworkRoot),
    },
  );
  const metrics = new DailyDriverMetricsService(store);
  const inputs = new InputApplicationService(
    store,
    new FileInputObjectStorage(`${stateLocation.stateDirectory}/inputs`),
    new SecureAuthorizedUrlInputFetcher(),
  );
  const writeWorkspaceAdapter = new GitRepositoryWorkspaceAdapter({ workspaceRoot: `${stateLocation.stateDirectory}/workspaces` });
  const repositoryWorkspace = new RepositoryWorkspaceService(
    store,
    repositories,
    writeWorkspaceAdapter,
    { stateDirectory: stateLocation.stateDirectory },
  );
  const browser = new PlaywrightBoundedBrowserAdapter({
    authenticationRoot: `${stateLocation.stateDirectory}/preview-auth`,
  });
  const preview = new PreviewApplicationService(
    store,
    repositories,
    new GitPreviewWorkspaceAdapter({ workspaceRoot: `${stateLocation.stateDirectory}/preview-workspaces` }),
    writeWorkspaceAdapter,
    new NodePreviewProcessAdapter(),
    browser,
    inputs,
    {
      previewWorkspaceRoot: `${stateLocation.stateDirectory}/preview-workspaces`,
      authentication: browser,
    },
  );
  const orchestration = new OrchestrationService(
    store,
    runtime,
    repositories,
    new CortextOSExecutionAdapter(),
    new CortextOSExecutionObserver(),
    {
      workspaceService: repositoryWorkspace,
      browserEvidence: preview,
      resolveTrustPolicy: async jobId => (await trustProfiles.effectiveForJob(jobId)).policy,
    },
  );
  const notification = loadNotifier();
  const operator = new OperatorApplicationService(store, orchestration, {
    runtime,
    runtimeLifecycle,
    notifier: notification.notifier,
    trustProfiles,
    runtimeFreshness,
    ...(options.deferRunnerWake !== undefined ? { deferRunnerWake: options.deferRunnerWake } : {}),
  });
  const conversation = new OrchestratorConversationApplicationService(
    new CortextOSOrchestratorConversationAdapter(),
    store,
  );
  const tools = new OrchestratorToolApplicationService(operator, inputs, preview);
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
    projects,
    inputs,
    preview,
    trustProfiles,
    runtimeFreshness,
    metrics,
    telegramConfigured: notification.configured,
    async close() {
      if (runnerTimer) clearInterval(runnerTimer);
      await store.close();
    },
  };
}

function expectedRuntimeRevision(frameworkRoot: string): { readonly expectedRevision?: string } {
  const configured = process.env['AO_EXPECTED_RUNTIME_REVISION']?.trim();
  if (configured) return { expectedRevision: configured };
  const entry = resolve(frameworkRoot, 'dist', 'cli.js');
  if (!existsSync(entry)) return {};
  return { expectedRevision: `sha256:${createHash('sha256').update(readFileSync(entry)).digest('hex')}` };
}

/** Stable in source and bundled dist execution. Never falls back silently to caller CWD. */
function resolveFrameworkRoot(): string {
  const configured = process.env.CTX_FRAMEWORK_ROOT ?? process.env.CTX_PROJECT_ROOT;
  const candidates = [configured, resolve(__dirname, '../../..'), resolve(__dirname, '..')]
    .filter((value): value is string => Boolean(value));
  const root = candidates.find(candidate => existsSync(resolve(candidate, 'package.json')));
  if (!root) throw new Error('Agent Operations framework root is unavailable. Set CTX_FRAMEWORK_ROOT explicitly.');
  return resolve(root);
}

function loadNotifier() {
  try {
    loadAgentOperationsTelegramEnvironmentFile();
    const config = loadTelegramOperatorNotificationConfig();
    return {
      notifier: config ? new TelegramOperatorNotifier(config, undefined, {
        ctxRoot: process.env.CTX_ROOT ?? join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID ?? 'default'),
        agentName: process.env.AO_ORCHESTRATOR_AGENT_NAME ?? 'ao-orchestrator',
      }) : new NoopOperatorNotifier(),
      configured: config !== null,
    };
  } catch (error) {
    console.warn(`Agent Operations Telegram notifications disabled: ${error instanceof Error ? error.message : String(error)}`);
    return { notifier: new NoopOperatorNotifier(), configured: false };
  }
}
