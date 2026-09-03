/** Provider names owned by Agent Operations, independent of CortextOS classes. */
export const RUNTIME_PROVIDERS = [
  'claude',
  'codex',
  'opencode',
  'hermes',
  'unknown',
] as const;

export type RuntimeProvider = (typeof RUNTIME_PROVIDERS)[number];

/** Smallest state vocabulary observable across every current provider. */
export const RUNTIME_STATES = [
  'running',
  'stopped',
  'starting',
  'degraded',
  'unknown',
] as const;

export type RuntimeState = (typeof RUNTIME_STATES)[number];

/** Capabilities proven by the current runtime adapters, not inferred tools. */
export type RuntimeCapability =
  | 'session-resume'
  | 'exact-turn-correlation'
  | 'execution-working-directory'
  | 'repository-read-tools'
  | 'input-read-tools'
  | 'repository-write-tools'
  | 'test-run-tools'
  | 'git-inspection-tools'
  | 'filesystem-none'
  | 'filesystem-read-only'
  | 'filesystem-workspace-write'
  | 'network-denial'
  | 'environment-empty'
  | 'environment-minimal'
  | 'environment-inherit';

export interface AgentRuntimeIdentity {
  readonly id: string;
  readonly name: string;
  readonly displayName?: string;
  readonly organization: string | null;
  readonly provider: RuntimeProvider;
}

export interface AgentRuntimeHealth {
  readonly state: RuntimeState;
  readonly lastHeartbeat?: string;
  readonly pid?: number;
  readonly reason?: string;
}

export interface AgentRuntimeSummary extends AgentRuntimeIdentity {
  /** Null means the adapter could not find authoritative enablement metadata. */
  readonly enabled: boolean | null;
  readonly configured: boolean;
  readonly capabilities: readonly RuntimeCapability[];
  readonly health: AgentRuntimeHealth;
  /** Live loaded catalog identity, when the runtime can prove it. */
  readonly toolCatalogRevision?: string;
  /** Live loaded application revision, when the runtime can prove it. */
  readonly loadedRevision?: string;
}

export interface AgentRuntimeDetail extends AgentRuntimeSummary {
  readonly observedAt: string;
  /** Current effective launch directory when the runtime can prove it. */
  readonly workingDirectory?: string;
}

export type RuntimeInventoryState = 'available' | 'degraded' | 'unavailable';

export interface RuntimeInventoryHealth {
  readonly state: RuntimeInventoryState;
  readonly observedAt: string;
  readonly agentCount: number;
  readonly reason?: string;
}

/** The only runtime dependency Agent Operations domain code should consume. */
export interface AgentRuntimeAdapter {
  listAgents(): Promise<readonly AgentRuntimeSummary[]>;
  getAgent(id: string): Promise<AgentRuntimeDetail | null>;
  getHealth(): Promise<RuntimeInventoryHealth>;
}

export interface RuntimeStartupInventory {
  readonly configuredAgents: readonly {
    readonly id: string;
    readonly provider: RuntimeProvider;
    readonly enabled: boolean | null;
  }[];
  readonly configuredCronCount: number;
  readonly configuredIntegrationCount: number;
}

export interface RuntimeStartResult {
  readonly status: 'started' | 'already-running' | 'failed';
  readonly instanceId: string;
  readonly message: string;
  readonly inventory: RuntimeStartupInventory;
  readonly daemonPid?: number;
  readonly diagnostic?: string;
}

/** Explicit mutation port. Runtime inventory and page reads never call it. */
export interface RuntimeLifecycleAdapter {
  start(): Promise<RuntimeStartResult>;
  restart?(): Promise<RuntimeStartResult>;
}

export type RuntimeFreshnessState = 'current' | 'restart-pending' | 'restarting' | 'stale-blocked';

export interface RuntimeFreshnessReport {
  readonly state: RuntimeFreshnessState;
  readonly expectedToolCatalogRevision: string;
  readonly loadedToolCatalogRevision?: string;
  readonly expectedRevision?: string;
  readonly loadedRevision?: string;
  readonly activeAcceptedWork: number;
  readonly message: string;
}

export function isRuntimeProvider(value: unknown): value is RuntimeProvider {
  return typeof value === 'string' && (RUNTIME_PROVIDERS as readonly string[]).includes(value);
}

export function isRuntimeState(value: unknown): value is RuntimeState {
  return typeof value === 'string' && (RUNTIME_STATES as readonly string[]).includes(value);
}

/**
 * IDs are based on CortextOS's durable organization/name identity, but the
 * encoding and unscoped fallback belong to Agent Operations.
 */
export function createAgentRuntimeId(organization: string | null, name: string): string {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Agent name is required');
  const scope = organization?.trim() || '_unscoped';
  return `${encodeURIComponent(scope)}/${encodeURIComponent(cleanName)}`;
}
