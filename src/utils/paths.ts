import { homedir } from 'os';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { createHash } from 'crypto';
import type { BusPaths } from '../types/index.js';
import { validateInstanceId } from './validate.js';

/**
 * Resolve all bus paths for an agent.
 * Mirrors the path resolution in bash _ctx-env.sh.
 *
 * The directory layout is:
 *   ~/.cortextos/{instance}/
 *     config/                - enabled-agents.json
 *     state/{agent}/         - flat, per-agent subdirs
 *     state/{agent}/heartbeat.json - canonical heartbeat location
 *     state/oauth/           - OAuth accounts.json (token store)
 *     state/usage/           - Usage monitoring snapshots
 *     inbox/{agent}/         - flat (not org-nested)
 *     inflight/{agent}/      - flat
 *     processed/{agent}/     - flat
 *     outbox/{agent}/        - flat
 *     logs/{agent}/          - flat
 *     orgs/{org}/tasks/      - org-scoped
 *     orgs/{org}/approvals/  - org-scoped
 *     orgs/{org}/analytics/  - org-scoped
 */
export function resolvePaths(
  agentName: string,
  instanceId: string = 'default',
  org?: string,
): BusPaths {
  validateInstanceId(instanceId);
  const ctxRoot = join(homedir(), '.cortextos', instanceId);

  // Org-scoped paths for tasks, approvals, analytics
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;

  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    deliverablesDir: join(orgBase, 'deliverables'),
  };
}

/**
 * Get the IPC socket path for daemon communication.
 * Unix domain socket on macOS/Linux, named pipe on Windows.
 */
export interface IpcPathOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export function getIpcPath(instanceId: string = 'default', options: IpcPathOptions = {}): string {
  validateInstanceId(instanceId);
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();

  // Vitest and its child processes must use the explicitly isolated CTX_ROOT.
  // Never fall through to a user's ~/.cortextos tree while tests are running.
  if (environment.VITEST === 'true') {
    const configuredRoot = environment.CTX_ROOT?.trim();
    if (!configuredRoot) {
      throw new Error('CortextOS tests require an explicit isolated CTX_ROOT for daemon IPC');
    }
    const ctxRoot = resolve(configuredRoot);
    const userStateRoot = resolve(homeDirectory, '.cortextos');
    const fromUserState = relative(userStateRoot, ctxRoot);
    if (fromUserState === '' || (!fromUserState.startsWith(`..${sep}`)
      && fromUserState !== '..' && !isAbsolute(fromUserState))) {
      throw new Error('CortextOS tests may not resolve daemon IPC inside the user home-state directory');
    }
    if (process.platform === 'win32') {
      const suffix = createHash('sha256').update(ctxRoot).digest('hex').slice(0, 16);
      return `\\\\.\\pipe\\cortextos-test-${suffix}`;
    }
    return join(ctxRoot, 'daemon.sock');
  }
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return join(homeDirectory, '.cortextos', instanceId, 'daemon.sock');
}
