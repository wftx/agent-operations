import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPCClient } from '../../../src/daemon/ipc-server.js';
import { getIpcPath } from '../../../src/utils/paths.js';
import { resolveAgentOperationsStateLocation } from '../../../packages/sqlite-state-adapter/src/index.js';

describe('automated test state and IPC isolation', () => {
  it('resolves default test IPC and AO state only inside the isolated test roots', () => {
    const socketPath = getIpcPath();
    expect(socketPath).toBe(join(process.env.CTX_ROOT!, 'daemon.sock'));
    expect(resolveAgentOperationsStateLocation().stateDirectory)
      .toBe(process.env.AGENT_OPERATIONS_STATE_DIR);
  });

  it('fails closed instead of resolving a user-home daemon socket during tests', () => {
    expect(() => getIpcPath('default', {
      environment: { VITEST: 'true' },
      homeDirectory: '/Users/example',
    })).toThrow('require an explicit isolated CTX_ROOT');
    expect(() => getIpcPath('default', {
      environment: { VITEST: 'true', CTX_ROOT: '/Users/example/.cortextos/default' },
      homeDirectory: '/Users/example',
    })).toThrow('may not resolve daemon IPC inside the user home-state directory');
  });

  it('gives parallel test roots distinct socket paths', () => {
    const options = (ctxRoot: string) => ({
      environment: { VITEST: 'true', CTX_ROOT: ctxRoot },
      homeDirectory: '/Users/example',
    });
    expect(getIpcPath('test-a', options('/tmp/cortextos-worker-a')))
      .not.toBe(getIpcPath('test-b', options('/tmp/cortextos-worker-b')));
  });

  it('allows an explicitly isolated IPC fixture and never falls back when absent', async () => {
    const socketPath = getIpcPath();
    mkdirSync(dirname(socketPath), { recursive: true });
    const server = createServer(socket => {
      socket.once('data', () => socket.end(JSON.stringify({ success: true, data: [] })));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(new IPCClient().send({ type: 'status' })).resolves.toEqual({
        success: true,
        data: [],
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    await expect(new IPCClient().send({ type: 'status' })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Daemon is not running'),
    });
  });
});
