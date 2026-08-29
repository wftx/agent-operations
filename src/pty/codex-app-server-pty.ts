import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import type {
  AgentConfig,
  CtxEnv,
  RuntimeExecutionCapabilitiesEnvelope,
  RuntimeExecutionContextEnvelope,
  RuntimeExecutionPolicyEnvelope,
} from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';
import type { TelegramAPI } from '../telegram/api.js';
import { ensureDir, atomicWriteSync } from '../utils/atomic.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import { WsUnixJsonRpcClient, type JsonRpcResponse } from '../utils/ws-unix-client.js';
import {
  RepositoryReadError,
  RootScopedRepositoryReader,
  type RepositoryReadAuditEvent,
} from './repository-read-capability.js';
import {
  RootScopedRepositoryWorkspaceTools,
  WorkspaceToolError,
  type WorkspaceToolAuditEvent,
} from './repository-workspace-capability.js';

interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

interface ThreadState {
  threadId: string;
  cwd: string;
  updatedAt: string;
}

interface SocketPointer {
  socketPath: string;
  fallback: boolean;
  reason?: string;
  updatedAt: string;
}

interface ThreadResponse {
  thread: {
    id: string;
    status?: unknown;
  };
}

interface CodexTurn {
  id: string;
  status?: string;
  error?: { message?: string } | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

interface TurnResponse {
  turn: CodexTurn;
}

interface CorrelatedTurnRecord {
  version: 1;
  provider: 'codex';
  threadId: string;
  turnId: string;
  correlationId?: string;
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  observedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  /** Bounded visible assistant output only; never hidden reasoning or transcript. */
  resultText?: string;
  workingDirectory?: string;
  effectivePolicy?: RuntimeExecutionPolicyEnvelope;
  effectiveCapabilities?: RuntimeExecutionCapabilitiesEnvelope;
  repositoryReadRoot?: string;
  repositoryReadOperations?: readonly RepositoryReadAuditEvent[];
  repositoryWriteRoot?: string;
  toolOperations?: readonly WorkspaceToolAuditEvent[];
}

export interface CorrelationSafeTurnReference {
  readonly provider: 'codex';
  readonly sessionId: string;
  readonly turnId: string;
  readonly executionContext?: RuntimeExecutionContextEnvelope;
  readonly effectiveCapabilities?: RuntimeExecutionCapabilitiesEnvelope;
}

export interface CodexExecutionPolicyMapping {
  readonly threadSandbox: 'read-only' | 'workspace-write';
  readonly sandboxPolicy:
    | { readonly type: 'readOnly'; readonly networkAccess: boolean }
    | {
        readonly type: 'workspaceWrite';
        readonly writableRoots: readonly string[];
        readonly networkAccess: boolean;
        readonly excludeTmpdirEnvVar: true;
        readonly excludeSlashTmp: true;
      };
  readonly environments: readonly [] | undefined;
  readonly shellEnvironmentInherit: 'none' | 'core' | 'all';
  readonly runtimeWorkspaceRoots: readonly string[];
}

const CORRELATED_RESULT_MAX_CHARS = 16_384;

interface SkillsListResponse {
  data?: Array<{
    cwd: string;
    skills: Array<{
      name: string;
      path: string;
      scope?: string;
      enabled?: boolean;
    }>;
  }>;
}

interface GoalResponse {
  goal: {
    objective?: string | null;
    status?: string | null;
  } | null;
}

interface ConfigReadResponse {
  config: Record<string, unknown>;
}

interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

const REPOSITORY_DYNAMIC_TOOLS = [{
  type: 'namespace',
  name: 'repository',
  description: 'Bounded read-only access to the repository authorized by the Execution Plan.',
  tools: [
    {
      type: 'function',
      name: 'list',
      description: 'List a bounded set of entries under a repository-relative directory.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Repository-relative directory; defaults to root.' } },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'read',
      description: 'Read bounded UTF-8 text lines from one repository-relative file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          maxLines: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'search',
      description: 'Search bounded UTF-8 repository text for a literal query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string', description: 'Repository-relative file or directory; defaults to root.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
}] as const;

const REPOSITORY_PATCH_DYNAMIC_TOOLS = [{
  type: 'namespace',
  name: 'repository',
  description: 'Bounded repository access rooted to the isolated Agent Operations worktree.',
  tools: [{
    type: 'function',
    name: 'patch',
    description: 'Replace one exact, unique text fragment in one existing repository file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
  }],
}] as const;

const TEST_DYNAMIC_TOOLS = [{
  type: 'namespace',
  name: 'test',
  description: 'Run one predefined Agent Operations validation command without shell access.',
  tools: [{
    type: 'function',
    name: 'run',
    description: 'Run an allowlisted validation by command ID.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: {
          type: 'string',
          enum: ['typecheck', 'agent-operations-tests', 'build', 'dashboard-tests'],
        },
      },
      required: ['commandId'],
      additionalProperties: false,
    },
  }],
}] as const;

const GIT_INSPECTION_DYNAMIC_TOOLS = [{
  type: 'namespace',
  name: 'git',
  description: 'Read-only Git evidence for the isolated Agent Operations worktree.',
  tools: [{
    type: 'function',
    name: 'inspect',
    description: 'Inspect status, diff, diff stat, or HEAD without mutating Git state.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['status', 'diff', 'diff-stat', 'head'] },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  }],
}] as const;

function buildDynamicTools(capabilities?: RuntimeExecutionCapabilitiesEnvelope): unknown[] {
  const tools: unknown[] = [];
  if (capabilities?.repositoryRead) {
    const repository = REPOSITORY_DYNAMIC_TOOLS[0];
    tools.push({
      ...repository,
      tools: [
        ...repository.tools,
        ...(capabilities.repositoryPatch ? REPOSITORY_PATCH_DYNAMIC_TOOLS[0].tools : []),
      ],
    });
  }
  if (capabilities?.testRun) tools.push(...TEST_DYNAMIC_TOOLS);
  if (capabilities?.gitInspect) tools.push(...GIT_INSPECTION_DYNAMIC_TOOLS);
  return tools;
}

const THREAD_PERMISSION_OVERRIDES = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
} as const;

const TURN_PERMISSION_OVERRIDES = {
  approvalPolicy: 'never',
  sandboxPolicy: { type: 'dangerFullAccess' },
} as const;

const SOCKET_BASENAME = 'codex.sock';
const SOCKET_PATH_WARN_BYTES = 100;
const BOOTSTRAP_PATTERN = '[codex-app-server] ready';

const CODEX_ACTIVE_WRITER_PATTERN = 'already has an active writer';

export class CodexThreadOwnershipConflictError extends Error {
  readonly code = 'CODEX_THREAD_OWNERSHIP_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'CodexThreadOwnershipConflictError';
  }
}

function normalizeThreadOwnershipError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(CODEX_ACTIVE_WRITER_PATTERN)
    ? new CodexThreadOwnershipConflictError(message)
    : error instanceof Error ? error : new Error(message);
}

const SLASH_REWRITE_RE = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;
const LOCAL_SLASH_COMMANDS = new Set(['goal']);

/**
 * Codex app-server PTY adapter for cortextOS.
 *
 * Uses a persistent `codex app-server` process and speaks JSON-RPC over the
 * app-server's WebSocket-framed Unix socket transport. The approved default
 * socket is `$CTX_ROOT/state/<agent>/codex.sock`; if that resolved path is
 * longer than the conservative 100-byte Unix socket threshold, the adapter
 * falls back to `/tmp/cas-<short-uuid>.sock` and writes a state-dir pointer.
 */
export class CodexAppServerPTY {
  private _alive = false;
  private _executing = false;
  private _activeTurnId: string | null = null;
  private _protectedTurnId: string | null = null;
  private _protectedThreadId: string | null = null;
  private _repositoryReader: RootScopedRepositoryReader | null = null;
  private _repositoryReadOperations: RepositoryReadAuditEvent[] = [];
  private _workspaceTools: RootScopedRepositoryWorkspaceTools | null = null;
  private _workspaceToolOperations: WorkspaceToolAuditEvent[] = [];
  private _workspaceToolCapabilities: RuntimeExecutionCapabilitiesEnvelope | null = null;
  private _protectedTurnResultText: string | null = null;
  private _correlationStartPending = false;
  private _writeBuffer = '';
  private _turnQueue: unknown[][] = [];
  private _turnCompletion: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private _spawnFn: SpawnFn | null = null;
  private _appServerPty: IPty | null = null;
  private _rpc: WsUnixJsonRpcClient | null = null;
  private _onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private _outputBuffer: OutputBuffer;
  private _env: CtxEnv;
  private _config: AgentConfig;
  private _stateDir: string;
  private _cwd: string;
  private _socketPath: string;
  private _socketListenArg: string;
  private _socketCwd: string;
  private _threadStatePath: string;
  private _socketPointerPath: string;
  private _threadId: string | null = null;
  private _telegramApi: TelegramAPI | null = null;
  private _chatId: string | null = null;
  private _typingLastSent = 0;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    this._env = env;
    this._config = config;
    this._cwd = config.working_directory || env.agentDir || process.cwd();
    this._stateDir = join(env.ctxRoot, 'state', env.agentName);
    this._threadStatePath = join(this._stateDir, 'codex-app-server-thread.json');
    this._socketPointerPath = join(this._stateDir, 'codex-app-server-socket.json');
    const socket = this.resolveSocketPath();
    this._socketPath = socket.path;
    this._socketListenArg = socket.listenArg;
    this._socketCwd = socket.cwd;
    this._outputBuffer = new OutputBuffer(1000, logPath, BOOTSTRAP_PATTERN);
  }

  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this._alive) {
      throw new Error('CodexAppServerPTY already spawned. Kill first.');
    }

    ensureDir(this._stateDir);
    this._alive = true;

    try {
      await this.startAppServerWithRetry();
      await this.connectRpc();
      await this.initializeRpc();
      await this.startOrResumeThread(mode);
      this._outputBuffer.push(`${BOOTSTRAP_PATTERN} thread=${this._threadId}\n`);
      if (prompt.trim()) {
        this.queueTurn([{ type: 'text', text: prompt, text_elements: [] }]);
      }
    } catch (err) {
      const normalized = normalizeThreadOwnershipError(err);
      this._alive = false;
      this._outputBuffer.push(`[codex-app-server] degraded: ${normalized}\n`);
      // A provider writer conflict is an ownership verdict, not a child crash.
      // Clean up this failed app-server without notifying AgentProcess's generic
      // exit/recovery path; AgentProcess will surface the typed halt instead.
      this.kill(!(normalized instanceof CodexThreadOwnershipConflictError));
      throw normalized;
    }
  }

  write(data: string): void {
    if (!this._alive) return;

    if (data === '\r') {
      const content = this._writeBuffer
        .replace(/\x1b\[200~/g, '')
        .replace(/\x1b\[201~/g, '')
        .trim();
      this._writeBuffer = '';
      if (content) {
        this.handleInput(content).catch((err) => {
          this._outputBuffer.push(`[codex-app-server] input failed: ${err}\n`);
        });
      }
    } else {
      this._writeBuffer += data;
    }
  }

  kill(notifyExit = true): void {
    this._alive = false;
    this._activeTurnId = null;
    this._protectedTurnId = null;
    this._protectedThreadId = null;
    this._repositoryReader = null;
    this._repositoryReadOperations = [];
    this._workspaceTools = null;
    this._workspaceToolOperations = [];
    this._workspaceToolCapabilities = null;
    this._protectedTurnResultText = null;
    this._correlationStartPending = false;
    this._turnQueue = [];
    this.rejectTurnCompletion(new Error('Codex app-server stopped'));
    if (this._rpc) {
      this._rpc.close();
      this._rpc = null;
    }
    if (this._appServerPty) {
      try {
        this._appServerPty.kill();
      } catch {
        // Ignore shutdown errors.
      }
      this._appServerPty = null;
    }
    this.removeSocket();
    if (notifyExit) this._onExitHandler?.(0, undefined);
    this._onExitHandler = null;
  }

  isAlive(): boolean {
    return this._alive;
  }

  getPid(): number | null {
    return this._appServerPty?.pid ?? null;
  }

  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this._onExitHandler = handler;
  }

  getOutputBuffer(): OutputBuffer {
    return this._outputBuffer;
  }

  /** True only when a new turn can be created without steering or queueing. */
  canStartCorrelationSafeTurn(): boolean {
    return this._alive
      && Boolean(this._threadId)
      && !this._executing
      && !this._activeTurnId
      && !this._turnCompletion
      && this._turnQueue.length === 0;
  }

  /**
   * Start one new Codex turn and return its provider identity without waiting
   * for completion. This opt-in path never steers an active turn.
   */
  async startCorrelationSafeTurn(
    content: string,
    correlationId: string,
    executionPolicy?: RuntimeExecutionPolicyEnvelope,
    executionContext?: RuntimeExecutionContextEnvelope,
    executionCapabilities?: RuntimeExecutionCapabilitiesEnvelope,
  ): Promise<CorrelationSafeTurnReference> {
    if (!this.canStartCorrelationSafeTurn() || !this._threadId) {
      throw new Error('RUNTIME_BUSY');
    }
    const cleanCorrelationId = correlationId.trim();
    if (!cleanCorrelationId || cleanCorrelationId.length > 500) {
      throw new Error('INVALID_CORRELATION_ID');
    }

    if (executionContext && !executionPolicy) {
      throw new Error('POLICY_UNSUPPORTED: execution context requires a policy-isolated thread');
    }
    if (executionCapabilities && !executionPolicy) {
      throw new Error('POLICY_UNSUPPORTED: execution capabilities require a policy-isolated thread');
    }
    const executionWorkingDirectory = executionContext
      ? normalizeExecutionWorkingDirectory(executionContext.workingDirectory)
      : this._cwd;
    const policyMapping = executionPolicy
      ? mapExecutionPolicyToCodex(executionPolicy, executionWorkingDirectory)
      : null;
    const repositoryReadEnabled = executionCapabilities?.repositoryRead === true;
    const repositoryPatchEnabled = executionCapabilities?.repositoryPatch === true;
    const workspaceToolsEnabled = repositoryPatchEnabled
      || executionCapabilities?.testRun === true
      || executionCapabilities?.gitInspect === true;
    if (executionCapabilities && executionCapabilities.version !== 1) {
      throw new Error('POLICY_UNSUPPORTED: unsupported execution capabilities version');
    }
    if (repositoryReadEnabled
      && (!executionContext?.repositoryReadRoot
        || executionContext.repositoryReadRoot !== executionWorkingDirectory)) {
      throw new Error('POLICY_UNSUPPORTED: repository-read root must match the execution checkout');
    }
    if (!repositoryReadEnabled && executionContext?.repositoryReadRoot) {
      throw new Error('POLICY_UNSUPPORTED: repository-read root supplied without capability');
    }
    if (repositoryPatchEnabled
      && (!executionContext?.repositoryWriteRoot
        || executionContext.repositoryWriteRoot !== executionWorkingDirectory
        || executionPolicy?.filesystem !== 'workspace-write')) {
      throw new Error('POLICY_UNSUPPORTED: repository patch requires the exact workspace-write root');
    }
    if (!repositoryPatchEnabled && executionContext?.repositoryWriteRoot) {
      throw new Error('POLICY_UNSUPPORTED: repository-write root supplied without patch capability');
    }
    if (workspaceToolsEnabled && !executionContext?.repositoryReadRoot) {
      throw new Error('POLICY_UNSUPPORTED: workspace tools require the exact repository root');
    }
    this._executing = true;
    this._correlationStartPending = true;
    let threadId: string;
    try {
      this._repositoryReader = repositoryReadEnabled
        ? new RootScopedRepositoryReader(executionWorkingDirectory)
        : null;
      this._repositoryReadOperations = [];
      this._workspaceTools = workspaceToolsEnabled
        ? new RootScopedRepositoryWorkspaceTools(executionWorkingDirectory)
        : null;
      this._workspaceToolOperations = [];
      this._workspaceToolCapabilities = executionCapabilities
        ? { ...executionCapabilities }
        : null;
      this._protectedTurnResultText = null;
      threadId = policyMapping
        ? await this.startPolicyIsolatedThread(
            policyMapping,
            executionWorkingDirectory,
            executionCapabilities,
          )
        : this._threadId;
    } catch (error) {
      this._executing = false;
      this._correlationStartPending = false;
      this._repositoryReader = null;
      this._repositoryReadOperations = [];
      this._workspaceTools = null;
      this._workspaceToolOperations = [];
      this._workspaceToolCapabilities = null;
      this._protectedTurnResultText = null;
      if (this._alive && this._turnQueue.length > 0) void this.drainQueue();
      throw new Error(`POLICY_THREAD_SETUP_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    this._protectedThreadId = threadId;
    const completion = this.createTurnCompletion();
    const settled = completion.then(
      () => this.finishCorrelationSafeTurn(),
      () => this.finishCorrelationSafeTurn(),
    );
    let turnIdentityKnown = false;

    try {
      const response = await this.request<TurnResponse>('turn/start', {
        threadId,
        clientUserMessageId: cleanCorrelationId,
        input: [{ type: 'text', text: content, text_elements: [] }],
        ...(policyMapping
          ? {
              cwd: executionWorkingDirectory,
              runtimeWorkspaceRoots: policyMapping.runtimeWorkspaceRoots,
              approvalPolicy: 'never',
              sandboxPolicy: policyMapping.sandboxPolicy,
              ...(policyMapping.environments ? { environments: policyMapping.environments } : {}),
            }
          : TURN_PERMISSION_OVERRIDES),
      });
      const turn = response.result?.turn;
      if (!turn || !validCodexId(turn.id)) {
        throw new Error('Codex turn/start returned no valid turn identity');
      }
      turnIdentityKnown = true;
      if (this._activeTurnId && this._activeTurnId !== turn.id) {
        throw new Error('Codex reported a different active turn during correlated turn creation');
      }
      this._correlationStartPending = false;
      if (this._executing) {
        this._activeTurnId = turn.id;
        this._protectedTurnId = turn.id;
        this._protectedThreadId = threadId;
      }
      if (!this.writeCorrelatedTurnRecord(
        threadId,
        turn,
        cleanCorrelationId,
        executionWorkingDirectory,
        executionPolicy,
        executionCapabilities,
        executionContext?.repositoryReadRoot,
        executionContext?.repositoryWriteRoot,
      )) {
        throw new Error('Codex turn started but correlated state could not be persisted');
      }
      void settled;
      return {
        provider: 'codex',
        sessionId: threadId,
        turnId: turn.id,
        ...(executionContext
          ? {
              executionContext: {
                workingDirectory: executionWorkingDirectory,
                ...(executionContext.repositoryReadRoot
                  ? { repositoryReadRoot: executionContext.repositoryReadRoot }
                  : {}),
                ...(executionContext.repositoryWriteRoot
                  ? { repositoryWriteRoot: executionContext.repositoryWriteRoot }
                  : {}),
              },
            }
          : {}),
        ...(executionCapabilities
          ? { effectiveCapabilities: { ...executionCapabilities } }
          : {}),
      };
    } catch (error) {
      if (turnIdentityKnown) {
        this._correlationStartPending = false;
      }
      // Once turn/start has been attempted, a rejected/ambiguous acknowledgement
      // must not make the runtime appear available. Keep the pending/protected
      // turn busy until a native terminal event (or the existing timeout) settles
      // it, so unrelated input cannot be steered into the uncertain execution.
      void settled;
      throw error;
    }
  }

  canEnforceExecutionPolicy(policy: RuntimeExecutionPolicyEnvelope): boolean {
    try {
      mapExecutionPolicyToCodex(policy, this._cwd);
      return true;
    } catch {
      return false;
    }
  }

  private async startPolicyIsolatedThread(
    mapping: CodexExecutionPolicyMapping,
    workingDirectory: string,
    capabilities?: RuntimeExecutionCapabilitiesEnvelope,
  ): Promise<string> {
    const mcpServers = await this.readRestrictedMcpServerOverrides(workingDirectory);
    const response = await this.request<ThreadResponse>('thread/start', {
      cwd: workingDirectory,
      runtimeWorkspaceRoots: mapping.runtimeWorkspaceRoots,
      approvalPolicy: 'never',
      sandbox: mapping.threadSandbox,
      ...(mapping.environments ? { environments: mapping.environments } : {}),
      dynamicTools: buildDynamicTools(capabilities),
      selectedCapabilityRoots: [],
      config: {
        features: {
          apps: false,
          auth_elicitation: false,
          browser_use: false,
          browser_use_external: false,
          browser_use_full_cdp_access: false,
          code_mode: false,
          code_mode_host: false,
          computer_use: false,
          deferred_executor: false,
          enable_mcp_apps: false,
          executor_capability_discovery: false,
          goals: false,
          guardian_approval: false,
          hooks: false,
          image_generation: false,
          in_app_browser: false,
          in_app_chat: false,
          in_app_local_automation: false,
          memories: false,
          multi_agent: false,
          network_proxy: false,
          plugin_sharing: false,
          plugins: false,
          recommended_plugins: false,
          remote_plugin: false,
          request_permissions_tool: false,
          shell_snapshot: false,
          shell_snapshot_v2: false,
          shell_tool: false,
          skill_mcp_dependency_install: false,
          skill_search: false,
          standalone_web_search: false,
          tool_call_mcp_elicitation: false,
          tool_suggest: false,
          unified_exec: false,
          view_image: false,
          web_search_cached: false,
          web_search_request: false,
          workspace_dependencies: false,
        },
        agents: { enabled: false },
        allow_login_shell: false,
        tools: { web_search: false, view_image: false },
        shell_environment_policy: {
          inherit: mapping.shellEnvironmentInherit,
          experimental_use_profile: false,
          set: {},
        },
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
        mcp_servers: mcpServers,
      },
      sessionStartSource: 'startup',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const threadId = response.result?.thread.id;
    if (!threadId || !validCodexId(threadId)) {
      throw new Error('Codex thread/start returned no valid policy-isolated thread identity');
    }
    return threadId;
  }

  private async readRestrictedMcpServerOverrides(
    workingDirectory: string,
  ): Promise<Record<string, { enabled: false }>> {
    const response = await this.request<ConfigReadResponse>('config/read', {
      cwd: workingDirectory,
      includeLayers: false,
    });
    const configured = response.result?.config?.mcp_servers;
    if (configured === undefined || configured === null) return {};
    if (typeof configured !== 'object' || Array.isArray(configured)) {
      throw new Error('Codex config/read returned an invalid mcp_servers value');
    }
    return Object.fromEntries(
      Object.keys(configured as Record<string, unknown>)
        .sort()
        .map(name => [name, { enabled: false }]),
    );
  }

  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this._telegramApi = api;
    this._chatId = chatId;
  }

  private async handleInput(content: string): Promise<void> {
    const extracted = this.extractTelegramPayload(content);
    const input = extracted?.payload ?? content;
    const goalCommand = this.parseGoalCommand(input);
    if (goalCommand?.type === 'get') {
      await this.getGoal();
      return;
    }
    if (goalCommand?.type === 'clear') {
      await this.clearGoal();
      return;
    }
    if (goalCommand?.type === 'set') {
      await this.setGoal(goalCommand.objective);
      return;
    }
    if (input.startsWith('$')) {
      await this.handleSkillInput(input);
      return;
    }
    const slashMatch = input.match(SLASH_REWRITE_RE);
    if (slashMatch && !LOCAL_SLASH_COMMANDS.has(slashMatch[1].toLowerCase())) {
      const [, name, trailing] = slashMatch;
      const trimmed = trailing?.trim();
      const rewritten = trimmed ? `$${name} ${trimmed}` : `$${name}`;
      await this.handleSkillInput(rewritten);
      return;
    }
    const turnText = extracted?.replyDirective
      ? `${input}\n\n${extracted.replyDirective}`
      : input;
    this.queueTurn([{ type: 'text', text: turnText, text_elements: [] }]);
  }

  private extractTelegramPayload(
    content: string,
  ): { payload: string; replyDirective: string | null } | null {
    if (!content.startsWith('=== TELEGRAM')) return null;

    const headerMatch = content.match(/^=== TELEGRAM(?:\s+(PHOTO|DOCUMENT|VOICE|AUDIO|VIDEO|VIDEO_NOTE))?\s+from/);
    const mediaType = headerMatch?.[1] ?? null;

    const chatIdMatch = content.match(/^=== TELEGRAM[^\n]*\(chat_id:(-?\d+)\)/);
    const chatId = chatIdMatch?.[1] ?? null;

    const beforeReply = content
      .split('\n[Your last message:', 1)[0]
      .split('\nReply using:', 1)[0];

    const replyToContext = this.extractReplyToContext(beforeReply);
    const replyDirective = chatId
      ? `Reply via: cortextos bus send-telegram ${chatId} '<your reply>' — this is the only path that surfaces in Telegram and on the dashboard. Do not reply through the codex channel.`
      : null;
    const wrap = (payload: string | null): { payload: string; replyDirective: string | null } | null => {
      if (!payload) return null;
      const withReplyTo = replyToContext ? `${payload}\n\n${replyToContext}` : payload;
      return { payload: withReplyTo, replyDirective };
    };

    if (mediaType) {
      const mediaPayload = this.buildMediaPayload(mediaType, beforeReply);
      if (mediaPayload) return wrap(mediaPayload);
    }

    const lines = beforeReply
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.startsWith('=== TELEGRAM')) continue;
      if (line.startsWith('[Recent conversation:]')) continue;
      if (line.startsWith('[reply_to:')) continue;
      if (line.startsWith('[Replying to:')) continue;
      if (line.startsWith('/') || line.startsWith('$')) return wrap(line);
      break;
    }

    const fencedBlocks = [...beforeReply.matchAll(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```/g)];
    if (fencedBlocks.length > 0) {
      return wrap(fencedBlocks[fencedBlocks.length - 1]?.[1]?.trim() || null);
    }

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.startsWith('=== TELEGRAM')) continue;
      if (line.startsWith('[Recent conversation:]')) continue;
      if (line.startsWith('[reply_to:')) continue;
      if (line.startsWith('[Replying to:')) continue;
      return wrap(line);
    }

    return null;
  }

  private buildMediaPayload(mediaType: string, beforeReply: string): string | null {
    // Match a dynamically-sized fence (3+ backticks): wrapFenceSafe grows the
    // fence to outlast any backtick run in the body, so the close must be the
    // same length as the open (backreference \1). Group 2 is the body.
    const captionMatch = beforeReply.match(/caption:\s*\n(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/);
    const caption = captionMatch?.[2]?.trim() ?? '';

    const transcriptMatch = beforeReply.match(/transcript:\s*\n(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/);
    const transcript = transcriptMatch?.[2]?.trim() ?? '';

    const localFileMatch = beforeReply.match(/^local_file:\s*(.+)$/m);
    const localFile = localFileMatch?.[1]?.trim() ?? '';

    const fileNameMatch = beforeReply.match(/^file_name:\s*(.+)$/m);
    const fileName = fileNameMatch?.[1]?.trim() ?? '';

    const durationMatch = beforeReply.match(/^duration:\s*(.+)$/m);
    const duration = durationMatch?.[1]?.trim() ?? '';

    const lines: string[] = [`[${mediaType}]`];
    if (caption) lines.push(`caption: ${caption}`);
    if (transcript) lines.push(`transcript: ${transcript}`);
    if (fileName) lines.push(`file_name: ${fileName}`);
    if (localFile) lines.push(`local_file: ${localFile}`);
    if (duration) lines.push(`duration: ${duration}`);

    return lines.length > 1 ? lines.join('\n') : null;
  }

  private extractReplyToContext(beforeReply: string): string | null {
    const telegramReplyMatch = beforeReply.match(/\[Replying to:\s*"([\s\S]*?)"\]/);
    if (telegramReplyMatch) {
      const text = telegramReplyMatch[1].slice(0, 200);
      if (text) return `[in reply to: ${text}]`;
    }

    const replyToMatch = beforeReply.match(/\[reply_to:\s*(\d+)\]/);
    if (!replyToMatch) return null;
    const messageId = replyToMatch[1];

    try {
      const outboundLog = join(this._stateDir, 'outbound-messages.jsonl');
      if (!existsSync(outboundLog)) return `[in reply to message ${messageId}]`;
      const fileLines = readFileSync(outboundLog, 'utf-8').split('\n').filter((l) => l.trim());
      for (let i = fileLines.length - 1; i >= 0; i -= 1) {
        try {
          const entry = JSON.parse(fileLines[i]) as { message_id?: number | string; text?: string };
          if (entry.message_id !== undefined && String(entry.message_id) === messageId) {
            const text = (entry.text || '').slice(0, 200);
            return text ? `[in reply to: ${text}]` : `[in reply to message ${messageId}]`;
          }
        } catch {
          // skip malformed lines
        }
      }
      return `[in reply to message ${messageId}]`;
    } catch {
      return `[in reply to message ${messageId}]`;
    }
  }

  private parseGoalCommand(content: string): { type: 'get' | 'clear' } | { type: 'set'; objective: string } | null {
    const match = content.trim().match(/^\/goal(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
    if (!match) return null;

    const objective = match[1]?.trim();
    if (!objective) return { type: 'get' };
    if (objective.toLowerCase() === 'clear') return { type: 'clear' };
    return { type: 'set', objective };
  }

  private async startAppServerWithRetry(): Promise<void> {
    const delays = [1000, 4000, 16000];
    let lastErr: unknown;

    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      try {
        this.removeSocket();
        await this.startAppServer();
        return;
      } catch (err) {
        lastErr = err;
        this.cleanupSpawnAttempt();
        this._outputBuffer.push(`[codex-app-server] spawn attempt ${attempt + 1} failed: ${err}\n`);
        if (attempt < delays.length - 1) {
          await sleep(delays[attempt]);
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private startAppServer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let startupReady = false;
      let settled = false;
      let startupOutput = '';
      const resolveStartup = () => {
        if (settled) return;
        settled = true;
        startupReady = true;
        resolve();
      };
      const rejectStartup = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      if (!this._spawnFn) {
        const nodePty = require('node-pty');
        this._spawnFn = nodePty.spawn;
      }

      const spawnFn = this._spawnFn!;
      const pty = spawnFn('codex', [
        'app-server',
        '--enable', 'goals',
        '--listen', this._socketListenArg,
      ], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: this._socketCwd,
        env: this.buildEnv(),
      });

      this._appServerPty = pty;
      pty.onData((data) => {
        this._outputBuffer.push(data);
        startupOutput = `${startupOutput}${data}`.slice(-4000);
        if (data.includes('Error:')) {
          rejectStartup(new Error(data.trim()));
        }
      });
      pty.onExit(({ exitCode, signal }) => {
        if (this._appServerPty !== pty) return;
        this._appServerPty = null;
        if (!startupReady) {
          const detail = startupOutput
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          rejectStartup(new Error(
            `Codex app-server exited before creating socket (exit code ${exitCode}, signal ${signal || 'none'})`
            + (detail ? `: ${detail}` : ''),
          ));
          return;
        }
        this._alive = false;
        this.rejectTurnCompletion(new Error('Codex app-server exited'));
        this._onExitHandler?.(exitCode, signal);
      });

      this.waitForSocket().then(resolveStartup, rejectStartup);
    });
  }

  private async waitForSocket(timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(this._socketPath)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for app-server socket: ${this._socketPath}`);
  }

  private async connectRpc(): Promise<void> {
    this._rpc = new WsUnixJsonRpcClient(this._socketPath);
    this._rpc.onMessage((message) => this.handleRpcMessage(message));
    await this._rpc.connect();
  }

  private async initializeRpc(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'cortextos',
        title: 'cortextOS',
        version: this.getPackageVersion(),
      },
      capabilities: { experimentalApi: true },
    });
    this._rpc?.notify('initialized');
  }

  private async startOrResumeThread(mode: 'fresh' | 'continue'): Promise<void> {
    if (mode === 'continue') {
      const persisted = this.readThreadState();
      if (persisted) {
        try {
          const resumed = await this.request<ThreadResponse>('thread/resume', {
            threadId: persisted.threadId,
            cwd: this._cwd,
            ...THREAD_PERMISSION_OVERRIDES,
            config: { features: { goals: true } },
            excludeTurns: true,
            persistExtendedHistory: true,
          });
          this.setThreadId(resumed.result?.thread.id || persisted.threadId);
          return;
        } catch (err) {
          const normalized = normalizeThreadOwnershipError(err);
          if (normalized instanceof CodexThreadOwnershipConflictError) throw normalized;
          this._outputBuffer.push(`[codex-app-server] persisted resume failed: ${err}\n`);
        }
      }

      const latest = await this.findLatestThreadForCwd();
      if (latest) {
        const resumed = await this.request<ThreadResponse>('thread/resume', {
          threadId: latest,
          cwd: this._cwd,
          ...THREAD_PERMISSION_OVERRIDES,
          config: { features: { goals: true } },
          excludeTurns: true,
          persistExtendedHistory: true,
        });
        this.setThreadId(resumed.result?.thread.id || latest);
        return;
      }
    }

    const started = await this.request<ThreadResponse>('thread/start', {
      cwd: this._cwd,
      ...THREAD_PERMISSION_OVERRIDES,
      config: { features: { goals: true } },
      sessionStartSource: 'startup',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    this.setThreadId(started.result!.thread.id);
  }

  private async findLatestThreadForCwd(): Promise<string | null> {
    const response = await this.request<{ data: Array<{ id: string; cwd?: string }> }>('thread/list', {
      cwd: this._cwd,
      limit: 1,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
    });
    return response.result?.data?.[0]?.id || null;
  }

  /**
   * Mid-turn parity with the Claude PTY-injection path: while a turn is
   * executing, try `turn/steer` so the message lands in the active turn at the
   * next model step instead of waiting for turn/completed. Any steer rejection
   * (ExpectedTurnMismatch = turn just ended, ActiveTurnNotSteerable =
   * review/compact, NoActiveTurn, transport error) falls back to the queue, so
   * no message is ever lost. CODEX_STEER_DISABLED=1 reverts to pure queueing.
   */
  private queueTurn(input: unknown[]): void {
    if (this._correlationStartPending || this._protectedTurnId) {
      this.enqueueTurn(input);
      return;
    }
    if (this._executing && this._activeTurnId && process.env.CODEX_STEER_DISABLED !== '1') {
      this.steerActiveTurn(input).catch((err) => {
        this._outputBuffer.push(`[codex-app-server] steer path failed: ${err}\n`);
      });
      return;
    }
    this.enqueueTurn(input);
  }

  private async steerActiveTurn(input: unknown[]): Promise<void> {
    const expectedTurnId = this._activeTurnId;
    if (!this._threadId || !expectedTurnId) {
      this.enqueueTurn(input);
      return;
    }
    try {
      await this.request('turn/steer', {
        threadId: this._threadId,
        expectedTurnId,
        input,
      });
      this._outputBuffer.push(`[codex-app-server] steered active turn ${expectedTurnId}\n`);
    } catch (err) {
      // Do not retry steer here: the rejection may be a non-steerable turn
      // (review/compact). Queueing guarantees delivery right after it ends.
      this._outputBuffer.push(`[codex-app-server] steer rejected, queueing: ${err}\n`);
      this.enqueueTurn(input);
    }
  }

  private enqueueTurn(input: unknown[]): void {
    this._turnQueue.push(input);
    if (!this._executing) {
      this.drainQueue().catch((err) => {
        this._outputBuffer.push(`[codex-app-server] turn queue failed: ${err}\n`);
      });
    }
  }

  private async drainQueue(): Promise<void> {
    while (this._alive && this._turnQueue.length > 0) {
      const input = this._turnQueue.shift()!;
      this._executing = true;
      try {
        await this.startTurn(input);
      } finally {
        this._executing = false;
      }
    }
  }

  private async startTurn(input: unknown[]): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const completion = this.createTurnCompletion();
    await this.request('turn/start', { threadId: this._threadId, input, ...TURN_PERMISSION_OVERRIDES });
    await completion;
  }

  /**
   * Local-command reply: writes to the agent log AND mirrors back to Telegram.
   * Local commands (`/goal`, `$skill` errors) are handled inside the adapter
   * without an LLM turn, so the user only sees a response if we send it.
   */
  private replyLocal(text: string): void {
    this._outputBuffer.push(text + '\n');
    if (this._telegramApi && this._chatId) {
      this._telegramApi.sendMessage(this._chatId, text, undefined, { parseMode: null }).catch(() => {});
    }
  }

  private async setGoal(objective: string): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const response = await this.request<GoalResponse>('thread/goal/set', {
      threadId: this._threadId,
      objective,
    });
    this.replyLocal(`[goal] ${response.result?.goal?.status || 'active'}: ${objective}`);
  }

  private async getGoal(): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const response = await this.request<GoalResponse>('thread/goal/get', { threadId: this._threadId });
    const goal = response.result?.goal;
    this.replyLocal(goal?.objective
      ? `[goal] ${goal.status || 'active'}: ${goal.objective}`
      : '[goal] none set');
  }

  private async clearGoal(): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    await this.request('thread/goal/clear', { threadId: this._threadId });
    this.replyLocal('[goal] cleared');
  }

  private async handleSkillInput(content: string): Promise<void> {
    const match = content.match(/^\$([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      this.replyLocal('[skill] expected $skill_name [text]');
      return;
    }

    const [, skillName, trailingText] = match;
    const skills = await this.request<SkillsListResponse>('skills/list', {
      cwds: [this._cwd],
      forceReload: false,
    });
    const allSkills = (skills.result?.data || []).flatMap((entry) => entry.skills || []);
    const exact = allSkills.find((skill) => skill.enabled !== false && skill.name === skillName);
    if (!exact) {
      const matches = allSkills
        .filter((skill) => skill.enabled !== false && skill.name.includes(skillName))
        .slice(0, 5)
        .map((skill) => skill.name);
      this.replyLocal(matches.length > 0
        ? `[skill] unknown "${skillName}". Did you mean: ${matches.join(', ')}?`
        : `[skill] unknown "${skillName}". No enabled matches found.`);
      return;
    }

    const input: unknown[] = [{ type: 'skill', name: exact.name, path: exact.path }];
    if (trailingText?.trim()) {
      input.push({ type: 'text', text: trailingText.trim(), text_elements: [] });
    }
    this.queueTurn(input);
  }

  private handleRpcMessage(message: unknown): void {
    if (!isRecord(message)) return;

    if ('method' in message && 'id' in message) {
      const method = String(message.method);
      const id = message.id as number | string;
      if (method === 'item/tool/call') {
        void this.handleDynamicToolCall(id, message.params);
        return;
      }
      this._outputBuffer.push(`[codex-app-server] unsupported request: ${method}\n`);
      this.emitUnsupportedRequestEvent(method);
      this._rpc?.respondError(id, -32601, `Unsupported app-server request: ${method}`);
      return;
    }

    if (!('method' in message)) return;
    const method = String(message.method);
    const params = isRecord(message.params) ? message.params : {};

    switch (method) {
      case 'thread/started':
        this._outputBuffer.push('[codex-app-server] thread started\n');
        break;
      case 'thread/status/changed':
        this._outputBuffer.push(`[codex-app-server] status ${JSON.stringify(params.status)}\n`);
        if (isRecord(params.status) && params.status.type === 'idle') {
          this.writeIdleFlag();
          if ((this._correlationStartPending || this._protectedTurnId)
            && (!this._protectedThreadId || params.threadId === this._protectedThreadId)) {
            this.rejectTurnCompletion(new Error(
              'Codex became idle without a matching correlated terminal event',
            ));
          }
        } else {
          this.maybeFireTyping();
        }
        break;
      case 'turn/started':
        if (isRecord(params.turn) && typeof params.turn.id === 'string') {
          if ((this._protectedThreadId && params.threadId !== this._protectedThreadId)
            || (this._protectedTurnId && this._protectedTurnId !== params.turn.id)) {
            this._outputBuffer.push(
              `[codex-app-server] ignored unrelated turn/started ${params.turn.id} while protecting ${this._protectedTurnId}\n`,
            );
          } else {
            this._activeTurnId = params.turn.id;
            if (this._correlationStartPending) {
              this._protectedTurnId = params.turn.id;
              if (typeof params.threadId === 'string') this._protectedThreadId = params.threadId;
            }
          }
        }
        this.maybeFireTyping();
        this._outputBuffer.push('[codex-app-server] turn started\n');
        break;
      case 'turn/completed':
        if (typeof params.threadId === 'string' && isRecord(params.turn)
          && typeof params.turn.id === 'string'
          && this.hasCorrelatedTurnRecord(params.threadId, params.turn.id)) {
          this.writeCorrelatedTurnRecord(params.threadId, params.turn as unknown as CodexTurn);
        }
        {
          const completedTurnId = isRecord(params.turn) && typeof params.turn.id === 'string'
            ? params.turn.id
            : null;
          const completionMatches = this._protectedTurnId
            ? completedTurnId === this._protectedTurnId
              && (!this._protectedThreadId || params.threadId === this._protectedThreadId)
            : (!completedTurnId || !this._activeTurnId || this._activeTurnId === completedTurnId);
          if (completionMatches) {
            this._activeTurnId = null;
            this.resolveTurnCompletion();
            this.writeIdleFlag();
          }
        }
        this._outputBuffer.push('[codex-app-server] turn completed\n');
        break;
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') {
          this._outputBuffer.push(params.delta);
        }
        this.maybeFireTyping();
        break;
      case 'item/completed':
        if (isRecord(params.item) && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
          if (params.threadId === this._protectedThreadId
            && params.turnId === this._protectedTurnId) {
            const resultText = params.item.text.trim();
            this._protectedTurnResultText = resultText
              ? resultText.slice(0, CORRELATED_RESULT_MAX_CHARS)
              : null;
            if (this._protectedThreadId && this._protectedTurnId) {
              this.writeCorrelatedTurnRecord(
                this._protectedThreadId,
                { id: this._protectedTurnId, status: 'inProgress' },
              );
            }
          }
          this._outputBuffer.push('\n');
        }
        break;
      case 'turn/plan/updated':
      case 'item/plan/delta':
        this._outputBuffer.push(`[plan] ${JSON.stringify(params)}\n`);
        this.maybeFireTyping();
        break;
      case 'thread/goal/updated':
        if (isRecord(params.goal)) {
          this._outputBuffer.push(`[goal] ${params.goal.status || 'active'}: ${params.goal.objective || ''}\n`);
        }
        break;
      case 'thread/goal/cleared':
        this._outputBuffer.push('[goal] cleared\n');
        break;
      case 'error':
        if (this._protectedTurnId
          && (params.turnId !== this._protectedTurnId || params.willRetry === true)) {
          this._outputBuffer.push(
            `[codex-app-server] ignored unrelated/retrying error while protecting ${this._protectedTurnId}\n`,
          );
          break;
        }
        if (typeof params.threadId === 'string' && typeof params.turnId === 'string'
          && params.willRetry !== true
          && this.hasCorrelatedTurnRecord(params.threadId, params.turnId)) {
          this.writeCorrelatedTurnRecord(params.threadId, {
            id: params.turnId,
            status: 'failed',
            error: isRecord(params.error) && typeof params.error.message === 'string'
              ? { message: params.error.message }
              : null,
          });
        }
        this._activeTurnId = null;
        this._outputBuffer.push(`[codex-app-server] error: ${JSON.stringify(params)}\n`);
        this.rejectTurnCompletion(new Error(JSON.stringify(params)));
        break;
      case 'thread/tokenUsage/updated':
        this.writeContextStatus(params);
        this.appendCodexTokenLog(params);
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      case 'warning':
      case 'mcpServer/startupStatus/updated':
      case 'account/rateLimits/updated':
      case 'skills/changed':
      case 'item/started':
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      default:
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
    }
  }

  private handleRepositoryToolCall(id: number | string, rawParams: unknown): void {
    const params = isRecord(rawParams) ? rawParams as unknown as DynamicToolCallParams : null;
    const operation = params?.tool === 'list' || params?.tool === 'read' || params?.tool === 'search'
      ? params.tool
      : null;
    const args = params && isRecord(params.arguments) ? params.arguments : {};
    const path = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
    const query = typeof args.query === 'string' ? args.query : undefined;
    const reply = (success: boolean, value: unknown): void => {
      this._rpc?.respond(id, {
        success,
        contentItems: [{
          type: 'inputText',
          text: typeof value === 'string' ? value : JSON.stringify(value),
        }],
      });
    };

    if (!params || params.namespace !== 'repository' || !operation
      || params.threadId !== this._protectedThreadId
      || params.turnId !== this._protectedTurnId
      || !this._repositoryReader) {
      reply(false, { code: 'CAPABILITY_DENIED', message: 'Repository-read capability is unavailable for this exact turn' });
      return;
    }

    try {
      const result = operation === 'list'
        ? this._repositoryReader.list(path)
        : operation === 'read'
          ? this._repositoryReader.read(
              typeof args.path === 'string' ? args.path : '',
              typeof args.startLine === 'number' ? args.startLine : 1,
              typeof args.maxLines === 'number' ? args.maxLines : 200,
            )
          : this._repositoryReader.search(
              typeof args.query === 'string' ? args.query : '',
              path,
            );
      this.recordRepositoryReadOperation({
        operation,
        path,
        ...(query ? { query: query.slice(0, 200) } : {}),
        success: true,
        occurredAt: new Date().toISOString(),
      });
      reply(true, result);
    } catch (error) {
      const code = error instanceof RepositoryReadError ? error.code : 'READ_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      this.recordRepositoryReadOperation({
        operation,
        path,
        ...(query ? { query: query.slice(0, 200) } : {}),
        success: false,
        errorCode: code,
        occurredAt: new Date().toISOString(),
      });
      reply(false, { code, message });
    }
  }

  private async handleDynamicToolCall(id: number | string, rawParams: unknown): Promise<void> {
    const params = isRecord(rawParams) ? rawParams as unknown as DynamicToolCallParams : null;
    if (params?.namespace === 'repository'
      && (params.tool === 'list' || params.tool === 'read' || params.tool === 'search')) {
      this.handleRepositoryToolCall(id, rawParams);
      return;
    }
    const reply = (success: boolean, value: unknown): void => {
      this._rpc?.respond(id, {
        success,
        contentItems: [{
          type: 'inputText',
          text: typeof value === 'string' ? value : JSON.stringify(value),
        }],
      });
    };
    const exactTurn = params
      && params.threadId === this._protectedThreadId
      && params.turnId === this._protectedTurnId;
    const args = params && isRecord(params.arguments) ? params.arguments : {};
    const allowed = exactTurn && this._workspaceTools && (
      params.namespace === 'repository' && params.tool === 'patch'
        ? this._workspaceToolCapabilities?.repositoryPatch === true
        : params.namespace === 'test' && params.tool === 'run'
          ? this._workspaceToolCapabilities?.testRun === true
          : params.namespace === 'git' && params.tool === 'inspect'
            ? this._workspaceToolCapabilities?.gitInspect === true
            : false
    );
    if (!allowed || !params || !this._workspaceTools) {
      reply(false, { code: 'CAPABILITY_DENIED', message: 'Workspace capability is unavailable for this exact turn' });
      return;
    }
    try {
      if (params.namespace === 'repository') {
        const path = typeof args.path === 'string' ? args.path : '';
        const result = this._workspaceTools.patch(
          path,
          typeof args.oldText === 'string' ? args.oldText : '',
          typeof args.newText === 'string' ? args.newText : '',
        );
        this.recordWorkspaceToolOperation({
          namespace: 'repository', operation: 'patch', path,
          success: true, occurredAt: new Date().toISOString(),
        });
        reply(true, result);
        return;
      }
      if (params.namespace === 'test') {
        const event = await this._workspaceTools.runTest(
          typeof args.commandId === 'string' ? args.commandId : '',
        );
        this.recordWorkspaceToolOperation(event);
        reply(event.success, event);
        return;
      }
      const operation = args.operation === 'status' || args.operation === 'diff'
        || args.operation === 'diff-stat' || args.operation === 'head' ? args.operation : null;
      if (!operation) throw new WorkspaceToolError('INVALID_OPERATION', 'Git inspection operation is invalid');
      const event = await this._workspaceTools.inspectGit(operation);
      this.recordWorkspaceToolOperation(event);
      reply(event.success, event);
    } catch (error) {
      const code = error instanceof WorkspaceToolError ? error.code : 'TOOL_FAILED';
      const event: WorkspaceToolAuditEvent = {
        namespace: params.namespace as 'repository' | 'test' | 'git',
        operation: params.tool,
        success: false,
        occurredAt: new Date().toISOString(),
        errorCode: code,
        ...(typeof args.path === 'string' ? { path: args.path } : {}),
        ...(typeof args.commandId === 'string' ? { commandId: args.commandId } : {}),
      };
      this.recordWorkspaceToolOperation(event);
      reply(false, { code, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private recordWorkspaceToolOperation(event: WorkspaceToolAuditEvent): void {
    this._workspaceToolOperations = [...this._workspaceToolOperations, event].slice(-100);
    if (!this._protectedThreadId || !this._protectedTurnId) return;
    this.writeCorrelatedTurnRecord(
      this._protectedThreadId,
      { id: this._protectedTurnId, status: 'inProgress' },
    );
  }

  private recordRepositoryReadOperation(event: RepositoryReadAuditEvent): void {
    this._repositoryReadOperations = [...this._repositoryReadOperations, event].slice(-100);
    if (!this._protectedThreadId || !this._protectedTurnId) return;
    this.writeCorrelatedTurnRecord(
      this._protectedThreadId,
      { id: this._protectedTurnId, status: 'inProgress' },
    );
  }

  private request<T>(method: string, params: unknown): Promise<JsonRpcResponse<T>> {
    if (!this._rpc) throw new Error('Codex app-server RPC is not connected');
    return this._rpc.request<T>(method, params);
  }

  private createTurnCompletion(timeoutMs = 30 * 60 * 1000): Promise<void> {
    if (this._turnCompletion) {
      this.rejectTurnCompletion(new Error('Superseded by a new turn'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._turnCompletion = null;
        reject(new Error('Timed out waiting for turn/completed'));
      }, timeoutMs);
      this._turnCompletion = { resolve, reject, timer };
    });
  }

  private resolveTurnCompletion(): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private rejectTurnCompletion(err: Error): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    clearTimeout(pending.timer);
    pending.reject(err);
  }

  private finishCorrelationSafeTurn(): void {
    this._activeTurnId = null;
    this._protectedTurnId = null;
    this._protectedThreadId = null;
    this._correlationStartPending = false;
    this._repositoryReader = null;
    this._repositoryReadOperations = [];
    this._workspaceTools = null;
    this._workspaceToolOperations = [];
    this._workspaceToolCapabilities = null;
    this._protectedTurnResultText = null;
    this._executing = false;
    if (this._alive && this._turnQueue.length > 0) {
      this.drainQueue().catch((error) => {
        this._outputBuffer.push(`[codex-app-server] turn queue failed: ${error}\n`);
      });
    }
  }

  private correlatedTurnRecordPath(threadId: string, turnId: string): string | null {
    if (!validCodexId(threadId) || !validCodexId(turnId)) return null;
    return join(this._stateDir, 'codex-turns', threadId, `${turnId}.json`);
  }

  private hasCorrelatedTurnRecord(threadId: string, turnId: string): boolean {
    const path = this.correlatedTurnRecordPath(threadId, turnId);
    return Boolean(path && existsSync(path));
  }

  private writeCorrelatedTurnRecord(
    threadId: string,
    turn: CodexTurn,
    correlationId?: string,
    workingDirectory?: string,
    effectivePolicy?: RuntimeExecutionPolicyEnvelope,
    effectiveCapabilities?: RuntimeExecutionCapabilitiesEnvelope,
    repositoryReadRoot?: string,
    repositoryWriteRoot?: string,
  ): boolean {
    const path = this.correlatedTurnRecordPath(threadId, turn.id);
    if (!path) return false;
    let previous: CorrelatedTurnRecord | null = null;
    try {
      if (existsSync(path)) {
        previous = JSON.parse(readFileSync(path, 'utf-8')) as CorrelatedTurnRecord;
      }
    } catch {
      previous = null;
    }
    const status = previous && ['completed', 'failed', 'interrupted'].includes(previous.status)
      ? previous.status
      : normalizeTurnStatus(turn.status);
    const startedAt = epochSecondsToIso(turn.startedAt) ?? previous?.startedAt;
    const completedAt = epochSecondsToIso(turn.completedAt) ?? previous?.completedAt;
    const durationMs = typeof turn.durationMs === 'number' ? turn.durationMs : previous?.durationMs;
    const error = turn.error?.message ?? previous?.error;
    const recordedPolicy = effectivePolicy ?? previous?.effectivePolicy;
    const recordedCapabilities = effectiveCapabilities ?? previous?.effectiveCapabilities;
    const recordedReaderRoot = repositoryReadRoot ?? previous?.repositoryReadRoot;
    const recordedWriterRoot = repositoryWriteRoot ?? previous?.repositoryWriteRoot;
    const recordedOperations = this._repositoryReadOperations.length
      ? this._repositoryReadOperations
      : previous?.repositoryReadOperations;
    const recordedToolOperations = this._workspaceToolOperations.length
      ? this._workspaceToolOperations
      : previous?.toolOperations;
    const recordedResultText = this._protectedTurnResultText ?? previous?.resultText;
    const record: CorrelatedTurnRecord = {
      version: 1,
      provider: 'codex',
      threadId,
      turnId: turn.id,
      ...((correlationId ?? previous?.correlationId)
        ? { correlationId: correlationId ?? previous!.correlationId }
        : {}),
      status,
      observedAt: new Date().toISOString(),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(error ? { error: error.slice(0, 2_000) } : {}),
      ...(recordedResultText ? { resultText: recordedResultText } : {}),
      ...((workingDirectory ?? previous?.workingDirectory)
        ? { workingDirectory: workingDirectory ?? previous!.workingDirectory }
        : {}),
      ...(recordedPolicy
        ? { effectivePolicy: { ...recordedPolicy } }
        : {}),
      ...(recordedCapabilities
        ? { effectiveCapabilities: { ...recordedCapabilities } }
        : {}),
      ...(recordedReaderRoot ? { repositoryReadRoot: recordedReaderRoot } : {}),
      ...(recordedWriterRoot ? { repositoryWriteRoot: recordedWriterRoot } : {}),
      ...(recordedOperations?.length
        ? { repositoryReadOperations: recordedOperations.map(operation => ({ ...operation })) }
        : {}),
      ...(recordedToolOperations?.length
        ? { toolOperations: recordedToolOperations.map(operation => ({ ...operation })) }
        : {}),
    };
    try {
      ensureDir(join(this._stateDir, 'codex-turns', threadId));
      atomicWriteSync(path, JSON.stringify(record));
      return true;
    } catch (writeError) {
      this._outputBuffer.push(`[codex-app-server] failed to persist correlated turn state: ${writeError}\n`);
      return false;
    }
  }

  private emitUnsupportedRequestEvent(method: string): void {
    try {
      const paths = resolvePaths(this._env.agentName, this._env.instanceId, this._env.org);
      // Error/runtime event: deliberately does not refresh heartbeat —
      // emitting an error does not prove the reasoning loop is alive.
      logEvent(
        paths,
        this._env.agentName,
        this._env.org,
        'error',
        'codex_app_server_unsupported_request',
        'error',
        {
          runtime: 'codex-app-server',
          method,
          thread_id: this._threadId,
        },
      );
    } catch {
      // OutputBuffer warning above is the user-visible fallback.
    }
  }

  private setThreadId(threadId: string): void {
    this._threadId = threadId;
    const state: ThreadState = {
      threadId,
      cwd: this._cwd,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this._threadStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  /**
   * Translate a `thread/tokenUsage/updated` notification from codex-app-server
   * into the context_status.json shape consumed by the FastChecker context
   * monitor. Writes atomically; failures are non-fatal (observability only).
   *
   * Mapping (per codex schema ThreadTokenUsageUpdatedNotification):
   *   - used_percentage = last.totalTokens / cap * 100  (clamped to [0, 100])
   *   - context_window_size = modelContextWindow ?? config.codex_context_cap ?? 256000
   *   - exceeds_200k_tokens = last.totalTokens > 200000
   *   - current_usage.{input,output,cache_read} from last.{input,output,cachedInput}Tokens
   *   - session_id = current threadId
   *
   * `total` is lifetime cumulative across the app-server thread and can grow far
   * beyond the active model window. Context handoff must use the current window
   * occupancy (`last`) so long-lived threads do not report false 100%.
   */
  private writeContextStatus(params: Record<string, unknown>): void {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    if (!tokenUsage) return;
    const current = isRecord(tokenUsage.last) ? tokenUsage.last : null;
    const currentTokens = current && typeof current.totalTokens === 'number' ? current.totalTokens : null;

    const modelContextWindow = typeof tokenUsage.modelContextWindow === 'number'
      ? tokenUsage.modelContextWindow
      : null;
    const cap = modelContextWindow ?? this._config.codex_context_cap ?? 256000;
    const usedPct = cap > 0 && currentTokens !== null
      ? Math.min(100, (currentTokens / cap) * 100)
      : null;

    const inputTokens = current && typeof current.inputTokens === 'number' ? current.inputTokens : 0;
    const outputTokens = current && typeof current.outputTokens === 'number' ? current.outputTokens : 0;
    const cachedInputTokens = current && typeof current.cachedInputTokens === 'number' ? current.cachedInputTokens : 0;

    const payload = JSON.stringify({
      used_percentage: usedPct,
      context_window_size: cap,
      exceeds_200k_tokens: currentTokens !== null ? currentTokens > 200000 : false,
      current_usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedInputTokens,
        cache_creation_input_tokens: 0,
      },
      session_id: this._threadId,
      written_at: new Date().toISOString(),
    });

    try {
      atomicWriteSync(join(this._stateDir, 'context_status.json'), payload);
    } catch {
      // Non-fatal: FastChecker will skip stale/missing files gracefully.
    }
  }

  /**
   * Append a per-turn token usage record to <ctxRoot>/logs/<agent>/codex-tokens.jsonl
   * so the dashboard cost-parser can scan it alongside ~/.claude/projects/*.jsonl.
   * One JSONL line per `thread/tokenUsage/updated` notification; dedup by
   * (session_id, turn_id) is the parser's responsibility.
   */
  private appendCodexTokenLog(params: Record<string, unknown>): void {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    if (!tokenUsage) return;
    const total = isRecord(tokenUsage.total) ? tokenUsage.total : null;
    if (!total) return;

    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    if (!turnId || !this._threadId) return;

    const entry = {
      timestamp: new Date().toISOString(),
      model: this._config.model || 'gpt-5-codex',
      input_tokens: typeof total.inputTokens === 'number' ? total.inputTokens : 0,
      output_tokens: typeof total.outputTokens === 'number' ? total.outputTokens : 0,
      cache_read_tokens: typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : 0,
      cache_write_tokens: 0,
      session_id: this._threadId,
      turn_id: turnId,
    };

    try {
      const logDir = join(this._env.ctxRoot, 'logs', this._env.agentName);
      ensureDir(logDir);
      appendFileSync(join(logDir, 'codex-tokens.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch {
      // Non-fatal: cost reporting is observability only.
    }
  }

  private readThreadState(): ThreadState | null {
    if (!existsSync(this._threadStatePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this._threadStatePath, 'utf-8')) as ThreadState;
      return parsed.cwd === this._cwd && parsed.threadId ? parsed : null;
    } catch {
      return null;
    }
  }

  private resolveSocketPath(): { path: string; listenArg: string; cwd: string } {
    const defaultPath = join(this._stateDir, SOCKET_BASENAME);
    if (Buffer.byteLength(defaultPath) < SOCKET_PATH_WARN_BYTES) {
      return { path: defaultPath, listenArg: `unix://./${SOCKET_BASENAME}`, cwd: this._stateDir };
    }

    const fallbackBasename = `cas-${randomBytes(4).toString('hex')}.sock`;
    const fallback = join('/tmp', fallbackBasename);
    const pointer: SocketPointer = {
      socketPath: fallback,
      fallback: true,
      reason: 'state socket path exceeded 100 bytes',
      updatedAt: new Date().toISOString(),
    };
    try {
      ensureDir(this._stateDir);
      writeFileSync(this._socketPointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf-8');
    } catch {
      // Non-fatal; spawn will still use fallback path.
    }
    return { path: fallback, listenArg: `unix://./${fallbackBasename}`, cwd: '/tmp' };
  }

  private removeSocket(): void {
    try {
      if (existsSync(this._socketPath)) unlinkSync(this._socketPath);
    } catch {
      // Ignore stale socket cleanup failures.
    }
  }

  private cleanupSpawnAttempt(): void {
    const pty = this._appServerPty;
    this._appServerPty = null;
    if (pty) {
      try {
        pty.kill();
      } catch {
        // Ignore failed attempt cleanup errors.
      }
    }
    this.removeSocket();
  }

  private writeIdleFlag(): void {
    try {
      writeFileSync(join(this._stateDir, 'last_idle.flag'), Math.floor(Date.now() / 1000).toString(), 'utf-8');
    } catch {
      // Non-fatal.
    }
  }

  private maybeFireTyping(): void {
    if (!this._telegramApi || !this._chatId) return;
    const now = Date.now();
    if (now - this._typingLastSent < 4000) return;
    this._typingLastSent = now;
    this._telegramApi.sendChatAction(this._chatId, 'typing').catch(() => { /* non-fatal */ });
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    const keepVars = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR'];
    for (const key of keepVars) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    env['CTX_INSTANCE_ID'] = this._env.instanceId;
    env['CTX_ROOT'] = this._env.ctxRoot;
    env['CTX_FRAMEWORK_ROOT'] = this._env.frameworkRoot;
    env['CTX_AGENT_NAME'] = this._env.agentName;
    env['CTX_ORG'] = this._env.org;
    env['CTX_AGENT_DIR'] = this._env.agentDir;
    env['CTX_PROJECT_ROOT'] = this._env.projectRoot;

    if (this._env.org && this._env.projectRoot) {
      this.loadEnvFile(join(this._env.projectRoot, 'orgs', this._env.org, 'secrets.env'), env);
    }
    this.loadEnvFile(join(this._env.agentDir, '.env'), env);

    if (env['CHAT_ID']) env['CTX_TELEGRAM_CHAT_ID'] = env['CHAT_ID'];
    if (this._config.timezone) {
      env['CTX_TIMEZONE'] = this._config.timezone;
      env['TZ'] = this._config.timezone;
    }

    return env;
  }

  private loadEnvFile(path: string, env: Record<string, string>): void {
    if (!existsSync(path)) return;
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    } catch {
      // Ignore env file read errors.
    }
  }

  private getPackageVersion(): string {
    try {
      const pkg = require('../../package.json') as { version?: string };
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validCodexId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function normalizeExecutionWorkingDirectory(value: string): string {
  if (!isAbsolute(value) || value.includes('\0')) throw new Error('INVALID_EXECUTION_CONTEXT');
  const normalized = resolve(value);
  if (normalized !== value) throw new Error('INVALID_EXECUTION_CONTEXT');
  return normalized;
}

export function mapExecutionPolicyToCodex(
  policy: RuntimeExecutionPolicyEnvelope,
  workingDirectory: string,
): CodexExecutionPolicyMapping {
  if (policy.version !== 1) throw new Error('POLICY_UNSUPPORTED');
  if (policy.filesystem === 'none') {
    throw new Error('POLICY_UNSUPPORTED: Codex cannot deny all filesystem reads');
  }
  const networkAccess = policy.network === 'allow';
  const runtimeWorkspaceRoots = policy.filesystem === 'workspace-write'
    ? [workingDirectory]
    : [];
  return {
    threadSandbox: policy.filesystem === 'workspace-write' ? 'workspace-write' : 'read-only',
    sandboxPolicy: policy.filesystem === 'workspace-write'
      ? {
          type: 'workspaceWrite',
          writableRoots: [workingDirectory],
          networkAccess,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        }
      : { type: 'readOnly', networkAccess },
    environments: policy.environment === 'inherit' ? undefined : [],
    shellEnvironmentInherit: policy.environment === 'empty'
      ? 'none'
      : policy.environment === 'minimal' ? 'core' : 'all',
    runtimeWorkspaceRoots,
  };
}

function normalizeTurnStatus(value: unknown): CorrelatedTurnRecord['status'] {
  return value === 'completed' || value === 'failed' || value === 'interrupted'
    ? value
    : 'inProgress';
}

function epochSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value * 1000).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
