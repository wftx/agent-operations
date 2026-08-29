import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DurableJob, DurableRepositoryWorkspace } from '../../agent-operations-contracts/src/index.js';
import { createRepositoryCheckoutBindingId } from '../../agent-operations-contracts/src/index.js';
import { SqliteAgentOperationsStateStore } from '../src/index.js';

const TIME = '2026-08-28T12:00:00.000Z';
const PROJECT = 'project:workspace';
const REPOSITORY = 'remote:github.com/wftx/agent-operations';
const BINDING = createRepositoryCheckoutBindingId('installation:workspace', '/tmp/source');
const directories: string[] = [];

afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

function open(path: string) {
  return SqliteAgentOperationsStateStore.open({
    databasePath: path,
    installationIdFactory: () => 'installation:workspace',
    now: () => new Date(TIME),
  });
}

describe('SQLite Repository Workspace persistence', () => {
  it('persists isolated identity and evidence without rewriting historical Jobs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-workspace-state-'));
    directories.push(directory);
    const path = join(directory, 'state.db');
    const store = open(path);
    await store.applyProjectConfiguration({
      project: { id: PROJECT, name: 'Workspace', createdAt: TIME, updatedAt: TIME },
      repositories: [{
        id: REPOSITORY, identityKind: 'remote', name: 'agent-operations',
        canonicalRemote: 'github.com/wftx/agent-operations', createdAt: TIME, updatedAt: TIME,
      }],
      checkoutBindings: [{
        id: BINDING, repositoryId: REPOSITORY, installationId: 'installation:workspace',
        canonicalPath: '/tmp/source', availability: 'available', firstSeenAt: TIME, lastSeenAt: TIME,
      }],
      runtimeAgentIds: ['agent-operations/rehearsal'],
    });
    const job: DurableJob = {
      id: 'job:workspace', projectId: PROJECT, title: 'Write safely',
      executionMode: 'repository-write-isolated', status: 'draft', repositoryId: REPOSITORY,
      preferredRuntimeAgentId: 'agent-operations/rehearsal', revision: 0,
      createdAt: TIME, updatedAt: TIME,
    };
    await store.createJob(job);
    const workspace: DurableRepositoryWorkspace = {
      id: 'workspace:workspace', jobId: job.id, projectId: PROJECT, repositoryId: REPOSITORY,
      sourceCheckoutBindingId: BINDING, baseRevision: 'a'.repeat(40), baseBranch: 'main',
      branchName: 'ao/job-workspace', canonicalPath: '/tmp/ao-state/workspaces/workspace',
      state: 'preparing', revision: 0, createdAt: TIME, updatedAt: TIME,
    };
    await store.createRepositoryWorkspace(workspace);
    const active = { ...workspace, state: 'active' as const, revision: 1 };
    await store.saveRepositoryWorkspaceTransition(active, 0);
    const reviewing: DurableRepositoryWorkspace = {
      ...active,
      state: 'reviewing',
      evidence: {
        changedFiles: ['README.md'], diffStat: '1 file changed', diffText: '+safe',
        diffTruncated: false, testResults: [], capturedAt: TIME,
      },
      revision: 2,
    };
    await store.saveRepositoryWorkspaceTransition(reviewing, 1);
    const ready: DurableRepositoryWorkspace = {
      ...reviewing,
      state: 'ready_for_approval',
      revision: 3,
    };
    await store.saveRepositoryWorkspaceTransition(ready, 2);
    await store.close();

    const reopened = open(path);
    await expect(reopened.getRepositoryWorkspaceForJob(job.id)).resolves.toEqual(ready);
    await expect(reopened.getJob(job.id)).resolves.toMatchObject({
      id: job.id, executionMode: 'repository-write-isolated',
    });
    await reopened.close();
  });
});
