import { afterEach, describe, expect, it } from 'vitest';
import { IPCClient, IPCServer } from '../../../src/daemon/ipc-server.js';

describe('daemon IPC instance identity', () => {
  let server: IPCServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  it('returns the instance identity with a live status response', async () => {
    const instanceId = process.env.CTX_INSTANCE_ID!;
    const manager = {
      getAllStatuses: () => [],
    };
    server = new IPCServer(manager as never, instanceId);
    await server.start();

    await expect(new IPCClient(instanceId).send({ type: 'status' })).resolves.toMatchObject({
      success: true,
      instanceId,
      data: [],
    });
  });
});
