import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import type {
  AgentRuntimeAdapter,
  AgentRuntimeDetail,
  AgentRuntimeHealth,
  AgentRuntimeSummary,
  RuntimeCapability,
  RuntimeInventoryHealth,
  RuntimeProvider,
  RuntimeState,
} from '../../agent-operations-contracts/src/index.js';
import { createAgentRuntimeId } from '../../agent-operations-contracts/src/index.js';

interface CortextOSStatusRecord {
  name: string;
  status?: string;
  pid?: number;
  lastHeartbeat?: string;
  awaitingConfirmation?: boolean;
  dormant?: boolean;
  dormancyReason?: string;
}

interface DaemonSnapshot {
  connected: boolean;
  usable: boolean;
  statuses: CortextOSStatusRecord[];
  issues: string[];
}

interface ConfiguredAgent {
  name: string;
  organization: string;
  displayName?: string;
  provider: RuntimeProvider;
  enabled: boolean | null;
  issues: string[];
}

interface DiscoverySnapshot {
  agents: ConfiguredAgent[];
  issues: string[];
  frameworkReadable: boolean;
  registry: Record<string, { org?: string; enabled?: boolean }>;
}

interface InventorySnapshot {
  agents: AgentRuntimeDetail[];
  health: RuntimeInventoryHealth;
}

export interface CortextOSRuntimeAdapterOptions {
  readonly instanceId?: string;
  readonly frameworkRoot?: string;
  readonly ctxRoot?: string;
  readonly ipcTimeoutMs?: number;
  readonly now?: () => Date;
  /** Test/embedding seam. The returned value must have the daemon IPC response shape. */
  readonly statusReader?: () => Promise<unknown>;
}

export function normalizeCortextOSProvider(value: unknown): RuntimeProvider {
  if (value === undefined || value === null || value === '' || value === 'claude-code') return 'claude';
  if (value === 'codex-app-server') return 'codex';
  if (value === 'opencode') return 'opencode';
  if (value === 'hermes') return 'hermes';
  return 'unknown';
}

function capabilitiesFor(provider: RuntimeProvider): readonly RuntimeCapability[] {
  return provider === 'unknown' ? [] : ['session-resume'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return Number.isNaN(new Date(value).getTime()) ? undefined : value;
}

function parseStatusRecord(value: unknown): CortextOSStatusRecord | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) return null;
  return {
    name: value.name,
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(Number.isInteger(value.pid) && Number(value.pid) > 0 ? { pid: Number(value.pid) } : {}),
    ...(normalizeTimestamp(value.lastHeartbeat) ? { lastHeartbeat: String(value.lastHeartbeat) } : {}),
    ...(typeof value.awaitingConfirmation === 'boolean'
      ? { awaitingConfirmation: value.awaitingConfirmation }
      : {}),
    ...(typeof value.dormant === 'boolean' ? { dormant: value.dormant } : {}),
    ...(typeof value.dormancyReason === 'string' ? { dormancyReason: value.dormancyReason } : {}),
  };
}

function parseDaemonSnapshot(value: unknown): DaemonSnapshot {
  if (!isRecord(value)) {
    return {
      connected: false,
      usable: false,
      statuses: [],
      issues: ['Daemon status response was not an object'],
    };
  }

  if (value.success !== true) {
    return {
      connected: false,
      usable: false,
      statuses: [],
      issues: [typeof value.error === 'string' ? value.error : 'CortextOS daemon is unavailable'],
    };
  }

  if (!Array.isArray(value.data)) {
    return {
      connected: true,
      usable: false,
      statuses: [],
      issues: ['Daemon status response did not contain an agent array'],
    };
  }

  const statuses: CortextOSStatusRecord[] = [];
  let malformed = 0;
  for (const item of value.data) {
    const parsed = parseStatusRecord(item);
    if (parsed) statuses.push(parsed);
    else malformed++;
  }

  return {
    connected: true,
    usable: true,
    statuses,
    issues: malformed ? [`Ignored ${malformed} malformed daemon status record(s)`] : [],
  };
}

function ipcPath(instanceId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(instanceId)) throw new Error(`Invalid CortextOS instance ID: ${instanceId}`);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\cortextos-${instanceId}`
    : join(homedir(), '.cortextos', instanceId, 'daemon.sock');
}

function requestDaemonStatus(instanceId: string, timeoutMs: number): Promise<unknown> {
  return new Promise(resolve => {
    const socket = createConnection(ipcPath(instanceId));
    let data = '';
    let settled = false;

    const finish = (result: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.on('connect', () => {
      socket.write(JSON.stringify({ type: 'status', source: 'agent-operations runtime inventory' }));
    });
    socket.on('data', chunk => {
      data += chunk.toString();
    });
    socket.on('end', () => {
      try {
        finish(JSON.parse(data));
      } catch {
        finish({ success: false, error: 'CortextOS daemon returned invalid JSON' });
      }
    });
    socket.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      finish({
        success: false,
        error: code === 'ENOENT' || code === 'ECONNREFUSED'
          ? 'CortextOS daemon is not running'
          : `CortextOS daemon IPC failed: ${error.message}`,
      });
    });
    socket.setTimeout(timeoutMs, () => {
      finish({ success: false, error: 'CortextOS daemon status request timed out' });
    });
  });
}

function parseDisplayName(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const heading = lines.findIndex(line => line.trim() === '## Name');
    if (heading < 0) return undefined;
    for (let index = heading + 1; index < lines.length; index++) {
      const value = lines[index].trim();
      if (value.startsWith('##')) break;
      if (value && !value.startsWith('<!--')) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readRegistry(ctxRoot: string, issues: string[]): Record<string, { org?: string; enabled?: boolean }> {
  const path = join(ctxRoot, 'config', 'enabled-agents.json');
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) throw new Error('registry root is not an object');
    const registry: Record<string, { org?: string; enabled?: boolean }> = {};
    for (const [name, raw] of Object.entries(parsed)) {
      if (!isRecord(raw)) continue;
      registry[name] = {
        ...(typeof raw.org === 'string' ? { org: raw.org } : {}),
        ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
      };
    }
    return registry;
  } catch (error) {
    issues.push(`Could not read enabled-agent registry: ${(error as Error).message}`);
    return {};
  }
}

function discoverConfiguredAgents(frameworkRoot: string, ctxRoot: string): DiscoverySnapshot {
  const issues: string[] = [];
  const registry = readRegistry(ctxRoot, issues);
  const orgsRoot = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsRoot)) {
    issues.push('CortextOS framework agent configuration is unavailable');
    return { agents: [], issues, frameworkReadable: false, registry };
  }

  const agents: ConfiguredAgent[] = [];
  let organizations: string[];
  try {
    organizations = readdirSync(orgsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (error) {
    issues.push(`Could not scan CortextOS organizations: ${(error as Error).message}`);
    return { agents, issues, frameworkReadable: false, registry };
  }

  for (const organization of organizations) {
    const agentsRoot = join(orgsRoot, organization, 'agents');
    if (!existsSync(agentsRoot)) continue;
    let names: string[];
    try {
      names = readdirSync(agentsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (error) {
      issues.push(`Could not scan agents for ${organization}: ${(error as Error).message}`);
      continue;
    }

    for (const name of names) {
      const agentIssues: string[] = [];
      const agentRoot = join(agentsRoot, name);
      const configPath = join(agentRoot, 'config.json');
      let provider: RuntimeProvider = 'claude';
      let configEnabled: boolean | undefined;

      if (existsSync(configPath)) {
        try {
          const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
          if (!isRecord(raw)) throw new Error('config root is not an object');
          provider = normalizeCortextOSProvider(raw.runtime);
          if (raw.runtime !== undefined && provider === 'unknown') {
            agentIssues.push(`Unknown CortextOS runtime: ${String(raw.runtime)}`);
          }
          if (typeof raw.enabled === 'boolean') configEnabled = raw.enabled;
        } catch (error) {
          provider = 'unknown';
          agentIssues.push(`Malformed config.json: ${(error as Error).message}`);
        }
      }

      const registration = registry[name];
      const enabled = configEnabled === false || registration?.enabled === false
        ? false
        : configEnabled ?? registration?.enabled ?? (provider === 'unknown' ? null : true);

      const displayName = parseDisplayName(join(agentRoot, 'IDENTITY.md'));
      agents.push({
        name,
        organization,
        ...(displayName ? { displayName } : {}),
        provider,
        enabled,
        issues: agentIssues,
      });
      issues.push(...agentIssues.map(issue => `${organization}/${name}: ${issue}`));
    }
  }

  return { agents, issues, frameworkReadable: true, registry };
}

function readHeartbeat(ctxRoot: string, name: string): { timestamp?: string; issue?: string } {
  const path = join(ctxRoot, 'state', name, 'heartbeat.json');
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(raw)) throw new Error('heartbeat root is not an object');
    const timestamp = normalizeTimestamp(raw.last_heartbeat) ?? normalizeTimestamp(raw.timestamp);
    return timestamp ? { timestamp } : { issue: 'Heartbeat has no valid timestamp' };
  } catch (error) {
    return { issue: `Malformed heartbeat.json: ${(error as Error).message}` };
  }
}

function normalizeStatus(status: CortextOSStatusRecord): { state: RuntimeState; reason?: string } {
  if (status.awaitingConfirmation) {
    return { state: 'degraded', reason: 'Runtime is awaiting interactive confirmation' };
  }
  if (status.dormant) {
    return { state: 'degraded', reason: status.dormancyReason || 'Runtime heartbeat is dormant' };
  }
  switch (status.status) {
    case 'running': return { state: 'running' };
    case 'stopped': return { state: 'stopped' };
    case 'starting': return { state: 'starting' };
    case 'crashed': return { state: 'degraded', reason: 'CortextOS reported a crashed runtime' };
    case 'halted': return { state: 'degraded', reason: 'CortextOS halted the runtime' };
    default: return { state: 'unknown', reason: 'CortextOS returned an unknown runtime state' };
  }
}

function combineReasons(reasons: Array<string | undefined>): string | undefined {
  const unique = [...new Set(reasons.filter((reason): reason is string => Boolean(reason)))];
  return unique.length ? unique.join('; ') : undefined;
}

function toSummary(agent: AgentRuntimeDetail): AgentRuntimeSummary {
  const { observedAt: _observedAt, ...summary } = agent;
  return {
    ...summary,
    capabilities: [...summary.capabilities],
    health: { ...summary.health },
  };
}

export class CortextOSRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly instanceId: string;
  private readonly frameworkRoot: string;
  private readonly ctxRoot: string;
  private readonly now: () => Date;
  private readonly statusReader: () => Promise<unknown>;

  constructor(options: CortextOSRuntimeAdapterOptions = {}) {
    this.instanceId = options.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default';
    this.frameworkRoot = options.frameworkRoot
      ?? process.env.CTX_FRAMEWORK_ROOT
      ?? process.env.CTX_PROJECT_ROOT
      ?? process.cwd();
    this.ctxRoot = options.ctxRoot
      ?? process.env.CTX_ROOT
      ?? join(homedir(), '.cortextos', this.instanceId);
    this.now = options.now ?? (() => new Date());
    this.statusReader = options.statusReader
      ?? (() => requestDaemonStatus(this.instanceId, options.ipcTimeoutMs ?? 1_000));
  }

  async listAgents(): Promise<readonly AgentRuntimeSummary[]> {
    return (await this.buildSnapshot()).agents.map(toSummary);
  }

  async getAgent(id: string): Promise<AgentRuntimeDetail | null> {
    const agent = (await this.buildSnapshot()).agents.find(candidate => candidate.id === id);
    return agent ? { ...toSummary(agent), observedAt: agent.observedAt } : null;
  }

  async getHealth(): Promise<RuntimeInventoryHealth> {
    return { ...(await this.buildSnapshot()).health };
  }

  private async buildSnapshot(): Promise<InventorySnapshot> {
    const observedAt = this.now().toISOString();
    const discovery = discoverConfiguredAgents(this.frameworkRoot, this.ctxRoot);
    let daemon: DaemonSnapshot;
    try {
      daemon = parseDaemonSnapshot(await this.statusReader());
    } catch (error) {
      daemon = {
        connected: false,
        usable: false,
        statuses: [],
        issues: [`CortextOS daemon status failed: ${(error as Error).message}`],
      };
    }

    const statusesByName = new Map(daemon.statuses.map(status => [status.name, status]));
    const nameCounts = new Map<string, number>();
    for (const agent of discovery.agents) {
      nameCounts.set(agent.name, (nameCounts.get(agent.name) ?? 0) + 1);
    }
    const representedStatuses = new Set<string>();

    const agents: AgentRuntimeDetail[] = discovery.agents.map(agent => {
      const duplicateName = (nameCounts.get(agent.name) ?? 0) > 1;
      const registrationOrg = discovery.registry[agent.name]?.org;
      const statusCanMatch = !duplicateName || registrationOrg === agent.organization;
      const liveStatus = statusCanMatch ? statusesByName.get(agent.name) : undefined;
      if (liveStatus || duplicateName) representedStatuses.add(agent.name);

      const heartbeat = readHeartbeat(this.ctxRoot, agent.name);
      const reasons = [...agent.issues, heartbeat.issue];
      let state: RuntimeState;

      if (duplicateName && !registrationOrg) {
        state = 'degraded';
        reasons.push('Agent name is duplicated across organizations; daemon status is ambiguous');
      } else if (liveStatus) {
        const normalized = normalizeStatus(liveStatus);
        state = normalized.state;
        reasons.push(normalized.reason);
        if (agent.enabled === false && state === 'running') {
          state = 'degraded';
          reasons.push('Daemon reports a running agent that configuration marks disabled');
        }
      } else if (agent.enabled === false) {
        state = 'stopped';
        reasons.push('Agent is disabled in configuration');
      } else {
        state = 'unknown';
        reasons.push(daemon.usable
          ? 'Daemon did not report this configured agent'
          : 'Live daemon status is unavailable');
      }

      if (agent.issues.length && state !== 'stopped') state = 'degraded';

      const health: AgentRuntimeHealth = {
        state,
        ...(liveStatus?.lastHeartbeat || heartbeat.timestamp
          ? { lastHeartbeat: liveStatus?.lastHeartbeat ?? heartbeat.timestamp }
          : {}),
        ...(liveStatus?.pid ? { pid: liveStatus.pid } : {}),
        ...(combineReasons(reasons) ? { reason: combineReasons(reasons) } : {}),
      };

      return {
        id: createAgentRuntimeId(agent.organization, agent.name),
        name: agent.name,
        ...(agent.displayName ? { displayName: agent.displayName } : {}),
        organization: agent.organization,
        provider: agent.provider,
        enabled: agent.enabled,
        configured: true,
        capabilities: capabilitiesFor(agent.provider),
        health,
        observedAt,
      } satisfies AgentRuntimeDetail;
    });

    for (const status of daemon.statuses) {
      if (representedStatuses.has(status.name)) continue;
      const registration = discovery.registry[status.name];
      const normalized = normalizeStatus(status);
      agents.push({
        id: createAgentRuntimeId(registration?.org ?? null, status.name),
        name: status.name,
        organization: registration?.org ?? null,
        provider: 'unknown',
        enabled: registration?.enabled ?? null,
        configured: false,
        capabilities: [],
        health: {
          state: normalized.state,
          ...(status.lastHeartbeat ? { lastHeartbeat: status.lastHeartbeat } : {}),
          ...(status.pid ? { pid: status.pid } : {}),
          reason: combineReasons([
            normalized.reason,
            'Daemon reported an agent with no matching readable configuration',
          ]),
        },
        observedAt,
      });
    }

    agents.sort((left, right) => left.id.localeCompare(right.id));
    const issues = [...discovery.issues, ...daemon.issues];
    const healthState: RuntimeInventoryHealth['state'] = daemon.usable
      ? (issues.length ? 'degraded' : 'available')
      : (agents.length ? 'degraded' : 'unavailable');

    return {
      agents,
      health: {
        state: healthState,
        observedAt,
        agentCount: agents.length,
        ...(combineReasons(issues) ? { reason: combineReasons(issues) } : {}),
      },
    };
  }
}
