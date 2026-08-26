import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  claimDaemonInstance,
  daemonOwnershipPath,
  DaemonInstanceOwnershipError,
  readDaemonInstanceOwner,
} from '../../../src/daemon/instance-ownership.js';

describe('daemon instance ownership', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-daemon-owner-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('allows exactly one live owner and preserves the winner metadata', () => {
    const first = claimDaemonInstance(ctxRoot, 'isolated', {
      pid: 101,
      isProcessAlive: (pid) => pid === 101,
    });

    expect(readDaemonInstanceOwner(ctxRoot)).toMatchObject({ instanceId: 'isolated', pid: 101 });
    expect(() => claimDaemonInstance(ctxRoot, 'isolated', {
      pid: 202,
      isProcessAlive: (pid) => pid === 101,
    })).toThrowError(expect.objectContaining({
      name: 'DaemonInstanceOwnershipError',
      code: 'DAEMON_INSTANCE_OWNED',
      ownerPid: 101,
    }));
    expect(readDaemonInstanceOwner(ctxRoot)?.token).toBe(first.owner.token);

    first.release();
    expect(existsSync(daemonOwnershipPath(ctxRoot))).toBe(false);
  });

  it('reclaims a dead owner without allowing the stale token to remove its successor', () => {
    const stale = claimDaemonInstance(ctxRoot, 'isolated', {
      pid: 101,
      isProcessAlive: () => false,
    });
    const replacement = claimDaemonInstance(ctxRoot, 'isolated', {
      pid: 202,
      incompleteClaimGraceMs: 0,
      isProcessAlive: () => false,
    });

    expect(readDaemonInstanceOwner(ctxRoot)).toMatchObject({ pid: 202 });
    stale.release();
    expect(readDaemonInstanceOwner(ctxRoot)?.token).toBe(replacement.owner.token);

    replacement.release();
  });

  it('does not steal an ownership directory whose owner record is still being written', () => {
    mkdirSync(daemonOwnershipPath(ctxRoot));

    expect(() => claimDaemonInstance(ctxRoot, 'isolated', {
      pid: 202,
      now: new Date(),
      incompleteClaimGraceMs: 60_000,
      isProcessAlive: () => false,
    })).toThrowError(expect.objectContaining({
      code: 'DAEMON_STARTUP_IN_PROGRESS',
    }));
  });

  it('refuses a live legacy daemon PID even when no new ownership record exists', () => {
    writeFileSync(join(ctxRoot, 'daemon.pid'), '303', 'utf-8');

    expect(() => claimDaemonInstance(ctxRoot, 'isolated', {
      pid: 202,
      isProcessAlive: (pid) => pid === 303,
    })).toThrowError(DaemonInstanceOwnershipError);
    expect(readFileSync(join(ctxRoot, 'daemon.pid'), 'utf-8')).toBe('303');
    expect(existsSync(daemonOwnershipPath(ctxRoot))).toBe(false);
  });

  it('recovers a reclaim marker whose reclaimer is dead', () => {
    claimDaemonInstance(ctxRoot, 'isolated', {
      pid: 101,
      isProcessAlive: () => false,
    });
    writeFileSync(join(daemonOwnershipPath(ctxRoot), '.reclaim'), '303\n', 'utf-8');

    const replacement = claimDaemonInstance(ctxRoot, 'isolated', {
      pid: 202,
      incompleteClaimGraceMs: 0,
      isProcessAlive: () => false,
    });
    expect(readDaemonInstanceOwner(ctxRoot)).toMatchObject({ pid: 202 });
    replacement.release();
  });
});
