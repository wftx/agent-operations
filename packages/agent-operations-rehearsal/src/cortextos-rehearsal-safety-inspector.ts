import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntimeDetail } from '../../agent-operations-contracts/src/index.js';
import type {
  RuntimeCandidateSafety,
  RuntimeCandidateSafetyInspector,
} from './live-rehearsal.js';

export interface CortextOSRehearsalSafetyInspectorOptions {
  readonly instanceId?: string;
  readonly ctxRoot?: string;
  readonly frameworkRoot?: string;
  readonly now?: () => Date;
}

/** Read-only occupancy check for the development-only rehearsal gate. */
export class CortextOSRehearsalSafetyInspector implements RuntimeCandidateSafetyInspector {
  private readonly ctxRoot: string;
  private readonly frameworkRoot: string;
  private readonly now: () => Date;

  constructor(options: CortextOSRehearsalSafetyInspectorOptions = {}) {
    const instanceId = options.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default';
    this.ctxRoot = options.ctxRoot
      ?? process.env.CTX_ROOT
      ?? join(homedir(), '.cortextos', instanceId);
    this.frameworkRoot = options.frameworkRoot
      ?? process.env.CTX_FRAMEWORK_ROOT
      ?? process.env.CTX_PROJECT_ROOT
      ?? process.cwd();
    this.now = options.now ?? (() => new Date());
  }

  async inspect(runtime: AgentRuntimeDetail): Promise<RuntimeCandidateSafety> {
    const activeWorkEvidence: string[] = [];
    const integrations = this.detectIntegrations(runtime);
    if (runtime.health.state !== 'running') {
      activeWorkEvidence.push(`runtime health is ${runtime.health.state}, not running`);
    }
    if (runtime.provider !== 'claude' && runtime.provider !== 'codex') {
      return {
        safe: false,
        reason: `${runtime.provider} lacks the idle evidence required by the first live rehearsal gate.`,
        activeWorkEvidence,
        integrations,
      };
    }
    if (!/^[A-Za-z0-9_-]+$/.test(runtime.name)) {
      return {
        safe: false,
        reason: 'Runtime name cannot be mapped safely to CortextOS state paths.',
        activeWorkEvidence,
        integrations,
      };
    }

    const pending = this.countFiles(join(this.ctxRoot, 'inbox', runtime.name));
    const inflight = this.countFiles(join(this.ctxRoot, 'inflight', runtime.name));
    if (pending > 0) activeWorkEvidence.push(`${pending} pending inbox message(s)`);
    if (inflight > 0) activeWorkEvidence.push(`${inflight} inflight message(s)`);
    const stateDir = join(this.ctxRoot, 'state', runtime.name);
    const idle = this.readEpoch(join(stateDir, 'last_idle.flag'));
    const injected = this.readEpoch(join(stateDir, 'last_message_injected.flag'));
    if (idle === null) activeWorkEvidence.push('no readable last_idle.flag');
    if (idle !== null && injected !== null && idle < injected) {
      activeWorkEvidence.push('last injected message is newer than the last idle signal');
    }
    if (idle !== null && this.now().getTime() - idle * 1000 > 10 * 60 * 1000) {
      activeWorkEvidence.push('last idle signal is older than ten minutes');
    }
    const safe = activeWorkEvidence.length === 0;
    return {
      safe,
      reason: safe
        ? 'Daemon reports running and local idle/queue evidence shows no active injected work.'
        : activeWorkEvidence.join('; '),
      activeWorkEvidence,
      integrations,
    };
  }

  private countFiles(directory: string): number {
    if (!existsSync(directory)) return 0;
    try {
      return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).length;
    } catch {
      return 1;
    }
  }

  private readEpoch(path: string): number | null {
    if (!existsSync(path)) return null;
    try {
      const value = Number(readFileSync(path, 'utf8').trim());
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  private detectIntegrations(runtime: AgentRuntimeDetail): readonly string[] {
    if (!runtime.organization) return [];
    const path = join(
      this.frameworkRoot,
      'orgs',
      runtime.organization,
      'agents',
      runtime.name,
      'config.json',
    );
    if (!existsSync(path)) return [];
    try {
      const source = readFileSync(path, 'utf8').toLowerCase();
      return ['telegram', 'slack', 'buzz'].filter(name => source.includes(name));
    } catch {
      return ['integration-config-unreadable'];
    }
  }
}
