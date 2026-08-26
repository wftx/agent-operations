import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { join, resolve } from 'path';

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}:\n${output}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolveOutput(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      if (!pattern.test(output)) {
        clearTimeout(timer);
        reject(new Error(`Child exited ${code} before ${pattern}:\n${output}`));
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    if (child.exitCode !== null) return resolveExit(child.exitCode);
    const timer = setTimeout(() => reject(new Error('Timed out waiting for child exit')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

function requestStatus(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(socketPath, () => {
      socket.write(JSON.stringify({ type: 'status', source: 'isolated ownership test' }));
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => resolveResponse(JSON.parse(data) as Record<string, unknown>));
    socket.on('error', reject);
  });
}

describe('daemon single-instance lifecycle', () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.all(children.map((child) => waitForExit(child).catch(() => null)));
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
    children.length = 0;
    tempRoots.length = 0;
  });

  it('rejects a second daemon before it can replace PID or IPC ownership', async () => {
    // Keep the Unix socket under the platform path-length ceiling.
    const root = mkdtempSync('/tmp/cx-own-');
    tempRoots.push(root);
    const home = join(root, 'home');
    const framework = join(root, 'framework');
    mkdirSync(join(framework, 'orgs'), { recursive: true });
    mkdirSync(home, { recursive: true });
    const instanceId = 'ownership-isolated';
    const ctxRoot = join(home, '.cortextos', instanceId);
    mkdirSync(ctxRoot, { recursive: true });
    writeFileSync(join(ctxRoot, 'daemon.pid'), '2147483647', 'utf-8');
    writeFileSync(join(ctxRoot, 'daemon.sock'), 'stale socket placeholder', 'utf-8');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CTX_INSTANCE_ID: instanceId,
      CTX_FRAMEWORK_ROOT: framework,
      CTX_PROJECT_ROOT: framework,
      CTX_ORG: 'isolated',
    };
    delete env.VITEST;
    const daemonEntry = resolve('src/daemon/index.ts');
    const spawnDaemon = () => {
      const child = spawn(process.execPath, ['--import', 'tsx', daemonEntry], {
        cwd: resolve('.'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      return child;
    };

    const winner = spawnDaemon();
    await waitForOutput(winner, /\[daemon\] Running/);
    const winnerPid = Number(readFileSync(join(ctxRoot, 'daemon.pid'), 'utf-8'));
    expect(winnerPid).toBe(winner.pid);

    const loser = spawnDaemon();
    let loserOutput = '';
    loser.stdout.on('data', (chunk) => { loserOutput += chunk.toString(); });
    loser.stderr.on('data', (chunk) => { loserOutput += chunk.toString(); });
    expect(await waitForExit(loser)).toBe(1);
    expect(loserOutput).toContain(`already owned by live daemon PID ${winner.pid}`);
    expect(Number(readFileSync(join(ctxRoot, 'daemon.pid'), 'utf-8'))).toBe(winner.pid);

    await expect(requestStatus(join(ctxRoot, 'daemon.sock'))).resolves.toMatchObject({
      success: true,
      instanceId,
      data: [],
    });

    winner.kill('SIGTERM');
    expect(await waitForExit(winner)).toBe(0);
  });
});
