import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface CortextOSSocketPathOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

/** Resolve provider-adapter IPC without allowing Vitest to fall through to user state. */
export function resolveCortextOSSocketPath(
  instanceId: string,
  options: CortextOSSocketPathOptions = {},
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(instanceId)) {
    throw new Error(`Invalid CortextOS instance ID: ${instanceId}`);
  }
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  if (environment.VITEST === 'true') {
    const configuredRoot = environment.CTX_ROOT?.trim();
    if (!configuredRoot) {
      throw new Error('CortextOS adapter tests require an explicit isolated CTX_ROOT for daemon IPC');
    }
    const ctxRoot = resolve(configuredRoot);
    const userStateRoot = resolve(homeDirectory, '.cortextos');
    const fromUserState = relative(userStateRoot, ctxRoot);
    if (fromUserState === '' || (!fromUserState.startsWith(`..${sep}`)
      && fromUserState !== '..' && !isAbsolute(fromUserState))) {
      throw new Error('CortextOS adapter tests may not resolve daemon IPC inside user home state');
    }
    if (platform === 'win32') {
      const suffix = createHash('sha256').update(ctxRoot).digest('hex').slice(0, 16);
      return `\\\\.\\pipe\\cortextos-test-${suffix}`;
    }
    return join(ctxRoot, 'daemon.sock');
  }
  return platform === 'win32'
    ? `\\\\.\\pipe\\cortextos-${instanceId}`
    : join(homeDirectory, '.cortextos', instanceId, 'daemon.sock');
}
