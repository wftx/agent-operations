import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';

const OWNERSHIP_DIR_NAME = 'daemon.owner';
const OWNER_FILE_NAME = 'owner.json';
const RECLAIM_FILE_NAME = '.reclaim';
const INCOMPLETE_CLAIM_GRACE_MS = 5_000;

export interface DaemonInstanceOwner {
  version: 1;
  instanceId: string;
  pid: number;
  token: string;
  startedAt: string;
}

export interface DaemonInstanceOwnership {
  readonly owner: DaemonInstanceOwner;
  readonly ownershipDir: string;
  release(): void;
}

export class DaemonInstanceOwnershipError extends Error {
  readonly code: 'DAEMON_INSTANCE_OWNED' | 'DAEMON_STARTUP_IN_PROGRESS';
  readonly ownerPid?: number;

  constructor(
    code: 'DAEMON_INSTANCE_OWNED' | 'DAEMON_STARTUP_IN_PROGRESS',
    message: string,
    ownerPid?: number,
  ) {
    super(message);
    this.name = 'DaemonInstanceOwnershipError';
    this.code = code;
    this.ownerPid = ownerPid;
  }
}

export interface ClaimDaemonInstanceOptions {
  pid?: number;
  now?: Date;
  incompleteClaimGraceMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parsePid(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function readOwner(ownerPath: string): DaemonInstanceOwner | null {
  try {
    const value = JSON.parse(readFileSync(ownerPath, 'utf-8')) as Partial<DaemonInstanceOwner>;
    if (value.version !== 1
      || typeof value.instanceId !== 'string'
      || typeof value.pid !== 'number'
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 0
      || typeof value.token !== 'string'
      || !value.token
      || typeof value.startedAt !== 'string') {
      return null;
    }
    return value as DaemonInstanceOwner;
  } catch {
    return null;
  }
}

function claimAgeMs(ownershipDir: string, nowMs: number): number {
  try {
    return Math.max(0, nowMs - statSync(ownershipDir).mtimeMs);
  } catch {
    return 0;
  }
}

function readLegacyPid(ctxRoot: string): number | null {
  try {
    return parsePid(readFileSync(join(ctxRoot, 'daemon.pid'), 'utf-8'));
  } catch {
    return null;
  }
}

function clearDeadReclaimer(
  reclaimPath: string,
  isProcessAlive: (pid: number) => boolean,
  nowMs: number,
  graceMs: number,
): void {
  try {
    const reclaimPid = parsePid(readFileSync(reclaimPath, 'utf-8'));
    if (reclaimPid && isProcessAlive(reclaimPid)) {
      throw new DaemonInstanceOwnershipError(
        'DAEMON_STARTUP_IN_PROGRESS',
        `CortextOS instance ownership is being reclaimed by live PID ${reclaimPid}`,
        reclaimPid,
      );
    }
    if (!reclaimPid && Math.max(0, nowMs - statSync(reclaimPath).mtimeMs) < graceMs) {
      throw new DaemonInstanceOwnershipError(
        'DAEMON_STARTUP_IN_PROGRESS',
        'CortextOS instance ownership reclaim is still being initialized',
      );
    }
    rmSync(reclaimPath, { force: true });
  } catch (error) {
    if (error instanceof DaemonInstanceOwnershipError) throw error;
    // Missing marker is the normal path. A malformed marker older than the
    // grace window has no provable live owner and is safe to replace.
    try { rmSync(reclaimPath, { force: true }); } catch { /* best effort */ }
  }
}

function releaseOwnedArtifacts(
  ctxRoot: string,
  ownershipDir: string,
  owner: DaemonInstanceOwner,
): void {
  const ownerPath = join(ownershipDir, OWNER_FILE_NAME);
  const current = readOwner(ownerPath);
  if (current?.token === owner.token && current.pid === owner.pid) {
    try {
      rmSync(ownershipDir, { recursive: true, force: true });
    } catch {
      // Best effort during shutdown; a dead PID is reclaimed on next startup.
    }
  }

  const pidPath = join(ctxRoot, 'daemon.pid');
  try {
    const persistedPid = parsePid(readFileSync(pidPath, 'utf-8'));
    if (persistedPid === owner.pid) rmSync(pidPath, { force: true });
  } catch {
    // Missing or foreign PID file; never remove another owner's metadata.
  }
}

/**
 * Atomically claim one CortextOS instance before PID, IPC, agent, or provider
 * startup. The mkdir is the ownership decision; owner.json makes the live PID
 * observable and supports conservative stale-owner recovery.
 */
export function claimDaemonInstance(
  ctxRoot: string,
  instanceId: string,
  options: ClaimDaemonInstanceOptions = {},
): DaemonInstanceOwnership {
  ensureDir(ctxRoot);
  const ownershipDir = join(ctxRoot, OWNERSHIP_DIR_NAME);
  const ownerPath = join(ownershipDir, OWNER_FILE_NAME);
  const reclaimPath = join(ownershipDir, RECLAIM_FILE_NAME);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? new Date();
  const graceMs = options.incompleteClaimGraceMs ?? INCOMPLETE_CLAIM_GRACE_MS;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  const tryCreate = (): DaemonInstanceOwner | null => {
    try {
      mkdirSync(ownershipDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    }

    const owner: DaemonInstanceOwner = {
      version: 1,
      instanceId,
      pid,
      token: randomUUID(),
      startedAt: now.toISOString(),
    };
    try {
      writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      return owner;
    } catch (error) {
      rmSync(ownershipDir, { recursive: true, force: true });
      throw error;
    }
  };

  let owner = tryCreate();
  if (!owner) {
    const current = readOwner(ownerPath);
    if (current && isProcessAlive(current.pid)) {
      throw new DaemonInstanceOwnershipError(
        'DAEMON_INSTANCE_OWNED',
        `CortextOS instance "${instanceId}" is already owned by live daemon PID ${current.pid}`,
        current.pid,
      );
    }

    if (!current && claimAgeMs(ownershipDir, now.getTime()) < graceMs) {
      throw new DaemonInstanceOwnershipError(
        'DAEMON_STARTUP_IN_PROGRESS',
        `CortextOS instance "${instanceId}" has an ownership claim still being initialized`,
      );
    }

    // A reclaim marker serializes stale takeover. Only its O_EXCL winner may
    // remove the old directory, avoiding the remove/recreate race where two
    // contenders can each delete the other's newly acquired lock.
    clearDeadReclaimer(reclaimPath, isProcessAlive, now.getTime(), graceMs);
    try {
      writeFileSync(reclaimPath, `${pid}\n`, { flag: 'wx', mode: 0o600 });
    } catch {
      throw new DaemonInstanceOwnershipError(
        'DAEMON_STARTUP_IN_PROGRESS',
        `CortextOS instance "${instanceId}" ownership is being reclaimed by another startup`,
      );
    }

    const rechecked = readOwner(ownerPath);
    if (rechecked && isProcessAlive(rechecked.pid)) {
      try { rmSync(reclaimPath, { force: true }); } catch { /* best effort */ }
      throw new DaemonInstanceOwnershipError(
        'DAEMON_INSTANCE_OWNED',
        `CortextOS instance "${instanceId}" is already owned by live daemon PID ${rechecked.pid}`,
        rechecked.pid,
      );
    }

    rmSync(ownershipDir, { recursive: true, force: true });
    owner = tryCreate();
    if (!owner) {
      const winner = readOwner(ownerPath);
      throw new DaemonInstanceOwnershipError(
        'DAEMON_STARTUP_IN_PROGRESS',
        winner
          ? `CortextOS instance "${instanceId}" startup was claimed by PID ${winner.pid}`
          : `CortextOS instance "${instanceId}" startup was claimed by another process`,
        winner?.pid,
      );
    }
  }

  // Backward compatibility: a live pre-lock daemon may still advertise only
  // daemon.pid. Refuse it after taking the new lock, then release our claim.
  const legacyPid = readLegacyPid(ctxRoot);
  if (legacyPid && legacyPid !== pid && isProcessAlive(legacyPid)) {
    releaseOwnedArtifacts(ctxRoot, ownershipDir, owner);
    throw new DaemonInstanceOwnershipError(
      'DAEMON_INSTANCE_OWNED',
      `CortextOS instance "${instanceId}" has a live legacy daemon PID ${legacyPid}`,
      legacyPid,
    );
  }

  return {
    owner,
    ownershipDir,
    release: () => releaseOwnedArtifacts(ctxRoot, ownershipDir, owner!),
  };
}

export function daemonOwnershipPath(ctxRoot: string): string {
  return join(ctxRoot, OWNERSHIP_DIR_NAME);
}

export function readDaemonInstanceOwner(ctxRoot: string): DaemonInstanceOwner | null {
  return readOwner(join(daemonOwnershipPath(ctxRoot), OWNER_FILE_NAME));
}
