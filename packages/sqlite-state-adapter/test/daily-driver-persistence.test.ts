import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAILY_DRIVER_TRUST_POLICY,
  createTrustProfileId,
} from '../../agent-operations-contracts/src/index.js';
import { SqliteAgentOperationsStateStore } from '../src/index.js';

const roots: string[] = [];
const time = '2026-09-02T12:00:00.000Z';

afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('Daily Driver SQLite persistence', () => {
  it('persists Trust Profiles and safe authenticated Preview metadata without secret paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-daily-driver-'));
    roots.push(root);
    const store = SqliteAgentOperationsStateStore.open({
      databasePath: join(root, 'state.db'),
      installationIdFactory: () => 'installation:daily-driver',
      now: () => new Date(time),
    });
    await store.applyProjectConfiguration({
      project: { id: 'project:daily-driver', name: 'Daily Driver', createdAt: time, updatedAt: time },
      repositories: [], checkoutBindings: [], runtimeAgentIds: [],
    });
    const profile = {
      id: createTrustProfileId('project', 'project:daily-driver'),
      scope: 'project' as const, scopeId: 'project:daily-driver', name: 'Daily Driver project policy',
      preset: 'daily-driver' as const, policy: DAILY_DRIVER_TRUST_POLICY,
      revision: 0, createdAt: time, updatedAt: time,
    };
    await store.saveTrustProfile(profile);
    expect(await store.getTrustProfile(profile.id)).toEqual(profile);

    await store.savePreviewProfile({
      id: 'preview-profile:daily-driver', projectId: 'project:daily-driver', name: 'default',
      command: { executable: 'npm', arguments: ['run', 'dev'] }, status: 'validated',
      authenticationRequired: true, revision: 0, createdAt: time, updatedAt: time,
    });
    await store.createAuthenticatedPreviewSession({
      id: 'preview-auth:daily-driver', projectId: 'project:daily-driver',
      previewProfileId: 'preview-profile:daily-driver', installationId: 'installation:daily-driver',
      origin: 'http://127.0.0.1:4311', status: 'pending-human-login',
      revision: 0, createdAt: time, updatedAt: time,
    });
    const authentication = await store.getAuthenticatedPreviewSession('preview-auth:daily-driver');
    expect(authentication).toMatchObject({
      projectId: 'project:daily-driver', previewProfileId: 'preview-profile:daily-driver',
      origin: 'http://127.0.0.1:4311', status: 'pending-human-login',
    });
    expect(JSON.stringify(authentication)).not.toMatch(/cookie|password|token|storage|\/Users\//i);
    await store.close();
  });
});
