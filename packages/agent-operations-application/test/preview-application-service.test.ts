import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InMemoryAgentOperationsStateStore,
  createRepositoryCheckoutBindingId,
  type BoundedBrowserAdapter,
  type InputMetadata,
  type PreviewAuthenticationAdapter,
  type PreviewProcessAdapter,
  type PreviewWorkspaceAdapter,
  type RepositoryInventoryAdapter,
  type RepositoryWorkspaceAdapter,
} from '../../agent-operations-contracts/src/index.js';
import { PreviewApplicationService } from '../src/index.js';
import type { InputApplication } from '../src/types.js';

const timestamp = '2026-09-01T12:00:00.000Z';
const projectId = 'project:preview';
const repositoryId = 'remote:github.com/example/preview';
const checkoutPath = '/fixtures/preview';
const revision = '1'.repeat(40);

describe('PreviewApplicationService', () => {
  it('uses an exact detached read only workspace and stores bounded screenshot evidence as an attached Input', async () => {
    const store = await fixtureStore();
    const process: PreviewProcessAdapter = {
      reservePort: async () => 4311,
      start: async () => ({ pid: 91, origin: 'http://127.0.0.1:4311', logs: 'ready' }),
      inspect: async () => ({ running: true, pid: 91 }),
      stop: async () => undefined,
    };
    let workspaceStarts = 0;
    const previewWorkspace: PreviewWorkspaceAdapter = {
      prepareReadOnlyWorkspace: async input => {
        workspaceStarts += 1;
        return { exists: true, registered: true, canonicalPath: input.destinationPath,
          repositoryId, revisionCommit: revision, detachedHead: true, clean: true };
      },
      inspectReadOnlyWorkspace: async () => ({ exists: true, registered: true, detachedHead: true, clean: true }),
      removeReadOnlyWorkspace: async () => ({ exists: false, registered: false }),
    };
    const screenshot = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const browser: BoundedBrowserAdapter = {
      capture: async request => ({
        title: 'Preview', finalUrl: `${request.origin}/dashboard`, screenshot,
        screenshotWidth: request.viewport.width, screenshotHeight: request.viewport.height,
        visibleText: 'Revenue 42', consoleFailures: [], failedResources: [],
        audit: [{ operation: 'navigate', target: `${request.origin}/dashboard`, occurredAt: timestamp }],
      }),
    };
    const inputs = fakeInputs(store);
    const service = new PreviewApplicationService(
      store, fakeRepositories(), previewWorkspace, fakeWriteWorkspace(), process, browser, inputs,
      { previewWorkspaceRoot: '/ao/preview-workspaces', now: () => new Date(timestamp) },
    );

    const first = await service.startJobPreview('job:preview');
    const second = await service.startJobPreview('job:preview');
    const evidence = await service.ensureJobEvidence('job:preview');

    expect(first).toEqual(second);
    expect(workspaceStarts).toBe(1);
    expect(first.workspaceKind).toBe('read-only-detached-worktree');
    expect(first.revisionCommit).toBe(revision);
    expect(evidence.route).toBe('/dashboard');
    expect(evidence.screenshotInputId).toBe('input:screenshot');
    expect(evidence.screenshotSha256).toBe(createHash('sha256').update(screenshot).digest('hex'));
    expect(await store.listJobInputIds('job:preview')).toEqual(['input:screenshot']);
    expect((await store.getInput('input:screenshot'))).not.toHaveProperty('bytes');
    expect((await service.getJobPreview('job:preview')).evidence).toHaveLength(1);
  });

  it('uses human established authentication only for the exact Project, profile, and origin', async () => {
    const store = await fixtureStore();
    let clock = new Date(timestamp);
    const process: PreviewProcessAdapter = {
      reservePort: async () => 4312,
      start: async () => ({ pid: 92, origin: 'http://127.0.0.1:4312', logs: 'ready' }),
      inspect: async () => ({ running: true, pid: 92 }),
      stop: async () => undefined,
    };
    const previewWorkspace: PreviewWorkspaceAdapter = {
      prepareReadOnlyWorkspace: async input => ({
        exists: true, registered: true, canonicalPath: input.destinationPath,
        repositoryId, revisionCommit: revision, detachedHead: true, clean: true,
      }),
      inspectReadOnlyWorkspace: async () => ({ exists: true, registered: true, detachedHead: true, clean: true }),
      removeReadOnlyWorkspace: async () => ({ exists: false, registered: false }),
    };
    const calls: string[] = [];
    const authentication: PreviewAuthenticationAdapter = {
      begin: async input => { calls.push(`begin:${input.sessionId}:${input.origin}`); },
      verify: async input => { calls.push(`verify:${input.sessionId}:${input.origin}`); return true; },
      isUsable: async input => { calls.push(`usable:${input.sessionId}:${input.origin}`); return true; },
      revoke: async input => { calls.push(`revoke:${input.sessionId}:${input.origin}`); },
    };
    let captureSessionId: string | undefined;
    const browser: BoundedBrowserAdapter = {
      capture: async request => {
        captureSessionId = request.authenticationSessionId;
        return {
          title: 'Private dashboard', finalUrl: `${request.origin}/dashboard`,
          screenshot: Uint8Array.from([1, 2, 3]), screenshotWidth: request.viewport.width,
          screenshotHeight: request.viewport.height, visibleText: 'Authenticated fixture',
          consoleFailures: [], failedResources: [], audit: [],
        };
      },
    };
    const service = new PreviewApplicationService(
      store, fakeRepositories(), previewWorkspace, fakeWriteWorkspace(), process, browser, fakeInputs(store),
      {
        previewWorkspaceRoot: '/ao/preview-workspaces', authentication,
        authenticationLifetimeMs: 60_000, now: () => clock,
      },
    );
    await service.setJobPreviewProfile('job:preview', 'npm run dev', true);

    const pending = await service.beginPreviewAuthentication('job:preview');
    expect(pending).toMatchObject({
      projectId, previewProfileId: expect.stringMatching(/^preview-profile:/),
      origin: 'http://127.0.0.1:4312', status: 'pending-human-login',
    });
    expect(JSON.stringify(pending)).not.toMatch(/cookie|password|token|storage/i);
    const ready = await service.verifyPreviewAuthentication('job:preview');
    expect(ready).toMatchObject({ status: 'ready', lastVerifiedAt: timestamp });
    const evidence = await service.refreshJobEvidence('job:preview');
    expect(captureSessionId).toBe(ready.id);
    expect(JSON.stringify(evidence)).not.toContain(ready.id);

    clock = new Date('2026-09-02T12:02:00.000Z');
    await expect(service.refreshJobEvidence('job:preview')).rejects.toThrow('expired');
    expect((await store.getAuthenticatedPreviewSession(ready.id))?.status).toBe('expired');
    await store.applyProjectConfiguration({
      project: { id: 'project:other', name: 'Other', createdAt: timestamp, updatedAt: timestamp },
      repositories: [], checkoutBindings: [], runtimeAgentIds: [],
    });
    await store.savePreviewProfile({
      id: 'preview-profile:other', projectId: 'project:other', name: 'default',
      command: { executable: 'npm', arguments: ['run', 'dev'] }, status: 'validated',
      authenticationRequired: true, revision: 0, createdAt: timestamp, updatedAt: timestamp,
    });
    await store.createAuthenticatedPreviewSession({
      id: 'preview-auth:other', projectId: 'project:other', previewProfileId: 'preview-profile:other',
      installationId: (await store.getInstallation()).id, origin: 'http://127.0.0.1:4999',
      status: 'pending-human-login', revision: 0, createdAt: timestamp, updatedAt: timestamp,
    });
    const revoked = await service.revokePreviewAuthentication('job:preview');
    expect(revoked.status).toBe('revoked');
    expect((await store.getAuthenticatedPreviewSession('preview-auth:other'))?.status).toBe('pending-human-login');
    expect(calls.some(call => call.startsWith('revoke:'))).toBe(true);
  });
});

async function fixtureStore() {
  const store = new InMemoryAgentOperationsStateStore();
  const installation = await store.getInstallation();
  const checkoutId = createRepositoryCheckoutBindingId(installation.id, checkoutPath);
  await store.applyProjectConfiguration({
    project: { id: projectId, name: 'Preview', createdAt: timestamp, updatedAt: timestamp },
    repositories: [{ id: repositoryId, identityKind: 'remote', name: 'preview',
      canonicalRemote: 'github.com/example/preview', createdAt: timestamp, updatedAt: timestamp }],
    checkoutBindings: [{ id: checkoutId, repositoryId, installationId: installation.id,
      canonicalPath: checkoutPath, availability: 'available', firstSeenAt: timestamp, lastSeenAt: timestamp }],
    runtimeAgentIds: ['agent-operations/rehearsal'],
  });
  await store.saveProjectProfile({
    projectId, resourceSummary: 'Git', detectedStack: ['Next.js'], packageManager: 'npm',
    buildCommandCandidates: ['npm run build'], testCommandCandidates: ['npm test'],
    previewCommandCandidates: ['npm run dev'], deploymentClues: [], documentation: [],
    capabilities: { repositoryReadOnlyJobs: 'available', isolatedCodeChangeJobs: 'available',
      boundedFileInspection: 'available', inputs: 'available', orchestratorConversation: 'available',
      build: 'detected-unvalidated', preview: 'detected-unvalidated', publish: 'unknown' },
    warnings: [], knownConstraints: [], agentsFileSuggestion: false, inspectedAt: timestamp, revision: 0,
  });
  await store.createJob({ id: 'job:preview', projectId, repositoryId, title: 'Visual check',
    description: 'Check dashboard', acceptanceCriteria: 'Render dashboard', status: 'draft',
    revision: 0, createdAt: timestamp, updatedAt: timestamp });
  await store.setJobBrowserEvidenceRequirement('job:preview', {
    kind: 'browser-render', route: '/dashboard', viewport: { width: 1440, height: 900 },
  });
  await store.recordRepositoryObservation({ repositoryId, checkoutBindingId: checkoutId,
    availability: 'available', branch: 'main', detachedHead: false, headCommit: revision,
    workingTree: 'dirty', observedAt: timestamp });
  return store;
}

function fakeRepositories(): RepositoryInventoryAdapter {
  return { inspectRepository: async path => ({ id: repositoryId, identityKind: 'remote', name: 'preview',
    checkoutPath: path, repositoryRoot: path, availability: 'available', branch: 'main', detachedHead: false,
    headCommit: revision, workingTree: 'clean', remotes: [], observedAt: timestamp }) };
}

function fakeWriteWorkspace(): RepositoryWorkspaceAdapter {
  return {
    createWorkspace: async () => ({ exists: true, registered: true }),
    inspectWorkspace: async () => ({ exists: true, registered: true }),
    captureEvidence: async () => ({ changedFiles: [], binaryFiles: [], diffStat: '', diffText: '', diffTruncated: false }),
    removeWorkspace: async () => ({ exists: false, registered: false }),
  };
}

function fakeInputs(store: InMemoryAgentOperationsStateStore): InputApplication {
  return {
    createUploadedInput: async request => {
      const sha256 = createHash('sha256').update(request.bytes).digest('hex');
      await store.createInput({ id: 'input:screenshot', displayName: request.displayName,
        mimeType: request.mimeType ?? 'application/octet-stream', byteSize: request.bytes.byteLength,
        sha256, sourceType: 'uploaded-file', projectId: request.projectId,
        storageReference: 'opaque:screenshot', ingestionState: 'complete', validationState: 'valid', createdAt: timestamp });
      return { id: 'input:screenshot', displayName: request.displayName,
        mimeType: request.mimeType ?? 'application/octet-stream', byteSize: request.bytes.byteLength,
        sha256, sourceType: 'uploaded-file', projectId: request.projectId, createdAt: timestamp } as InputMetadata;
    },
    createUrlInput: async () => { throw new Error('not used'); },
    getInput: async id => {
      const input = await store.getInput(id);
      if (!input) throw new Error('not found');
      const { storageReference: _storage, ingestionState: _ingestion, validationState: _validation, ...metadata } = input;
      return metadata;
    },
    listInputs: async () => [], readInput: async () => screenshotBytes(), associateWithConversation: async () => undefined,
  };
}

function screenshotBytes() { return Uint8Array.from([0x89, 0x50, 0x4e, 0x47]); }
