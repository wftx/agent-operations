import { describe, expect, it } from 'vitest';
import type {
  AuthorizedUrlInputFetcher,
  DurableInput,
  InputObjectStorageAdapter,
  ProjectResourceInspectionAdapter,
  RepositoryInventoryAdapter,
} from '../../agent-operations-contracts/src/index.js';
import { toInputMetadata } from '../../agent-operations-contracts/src/index.js';
import { InMemoryAgentOperationsStateStore } from '../../agent-operations-contracts/src/testing/in-memory-agent-operations-state-store.js';
import { InputApplicationService, ProjectApplicationService } from '../src/index.js';

const TIME = '2026-08-31T12:00:00.000Z';
const profile = {
  canonicalPath: '/projects/example', fingerprint: 'a'.repeat(64), readable: true,
  profile: {
    detectedStack: ['Node.js'], packageManager: 'npm',
    buildCommandCandidates: ['npm run build'], testCommandCandidates: ['npm run test'],
    previewCommandCandidates: ['npm run dev'], deploymentClues: [], documentation: [],
    warnings: [], knownConstraints: [], agentsFileSuggestion: true, inspectedAt: TIME,
  },
} as const;

describe('Project and Input application services', () => {
  it('keeps Input identity and provider metadata independent of physical storage location', () => {
    const durable: DurableInput = {
      id: 'input:stable', displayName: 'brief.txt', mimeType: 'text/plain', byteSize: 5,
      sha256: 'c'.repeat(64), sourceType: 'uploaded-file', projectId: 'project:1',
      storageReference: '/node-a/ao-inputs/stable/content', ingestionState: 'complete',
      validationState: 'valid', createdAt: TIME,
    };
    const relocated = { ...durable, storageReference: '/node-b/object-store/42' };

    expect(toInputMetadata(durable)).toEqual(toInputMetadata(relocated));
    expect(toInputMetadata(durable)).not.toHaveProperty('storageReference');
  });

  it('onboards Git, local folder, and resource free Projects without executing discovered commands', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const repositories: RepositoryInventoryAdapter = { inspectRepository: async path => path === '/projects/example' ? ({
      id: 'remote:github.com/example/site', identityKind: 'remote', name: 'site',
      checkoutPath: path, repositoryRoot: path, availability: 'available',
      branch: 'main', detachedHead: false, headCommit: 'a'.repeat(40), workingTree: 'clean',
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com/example/site.git', identity: { host: 'github.com', repositoryPath: 'example/site', canonical: 'github.com/example/site' } }],
      primaryRemote: { name: 'origin', fetchUrl: 'https://github.com/example/site.git', identity: { host: 'github.com', repositoryPath: 'example/site', canonical: 'github.com/example/site' } },
      observedAt: TIME,
    }) : ({
      id: 'local:notes', identityKind: 'local', name: 'notes', checkoutPath: path,
      availability: 'not-a-repository', detachedHead: false, workingTree: 'unknown', remotes: [],
      observedAt: TIME, reason: 'Path is not inside a Git repository',
    }) };
    const inspector: ProjectResourceInspectionAdapter = { inspectLocalFolder: async path => ({
      ...profile, canonicalPath: path, fingerprint: path === '/projects/example' ? 'a'.repeat(64) : 'b'.repeat(64),
    }) };
    let sequence = 0;
    const projects = new ProjectApplicationService(store, repositories, inspector, {
      now: () => new Date(TIME), projectIdFactory: () => `project:${++sequence}`,
    });

    const git = await projects.createProject({ name: 'Site', resource: { type: 'local-folder', path: '/projects/example' } });
    const folder = await projects.createProject({ name: 'Notes', resource: { type: 'local-folder', path: '/projects/notes' } });
    const context = await projects.createProject({ name: 'Strategy', resource: { type: 'none' } });

    expect(git.repositories[0]?.id).toBe('remote:github.com/example/site');
    expect(git.repositoryReadiness[0]).toMatchObject({
      canonicalRemote: 'github.com/example/site', branch: 'main', workingTree: 'clean',
    });
    expect(git.profile.capabilities.isolatedCodeChangeJobs).toBe('available');
    expect(folder.localFolders[0]).toMatchObject({ canonicalPath: '/projects/notes', availability: 'available' });
    expect(folder.profile.capabilities.repositoryReadOnlyJobs).toBe('unavailable');
    expect(context.profile.resourceSummary).toBe('No resource attached');
    expect(context.profile.capabilities.inputs).toBe('available');
  });

  it('stores immutable upload and URL Inputs and exposes no storage path in metadata', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    await store.applyProjectConfiguration({
      project: { id: 'project:1', name: 'Example', createdAt: TIME, updatedAt: TIME },
      repositories: [], checkoutBindings: [], runtimeAgentIds: [],
    });
    const objects = new Map<string, Uint8Array>();
    const storage: InputObjectStorageAdapter = {
      async store(id, bytes) {
        const reference = `/private/input-storage/${id}`; objects.set(reference, new Uint8Array(bytes));
        return { storageReference: reference, byteSize: bytes.byteLength, sha256: 'b'.repeat(64) };
      },
      async read(reference) { return objects.get(reference)!; },
      async remove(reference) { objects.delete(reference); },
    };
    const fetcher: AuthorizedUrlInputFetcher = { fetch: async () => ({
      bytes: new TextEncoder().encode('remote'), contentType: 'text/plain',
      finalUrl: 'https://example.com/reference.txt', displayName: 'reference.txt',
    }) };
    let sequence = 0;
    const inputs = new InputApplicationService(store, storage, fetcher, {
      now: () => new Date(TIME), inputIdFactory: () => `input:${++sequence}`,
    });
    const upload = await inputs.createUploadedInput({
      displayName: '../brief.txt', bytes: new TextEncoder().encode('brief'), projectId: 'project:1',
    });
    const url = await inputs.createUrlInput({ url: 'https://example.com/reference.txt', projectId: 'project:1' });

    expect(upload).toMatchObject({ id: 'input:1', displayName: 'brief.txt', sourceType: 'uploaded-file' });
    expect(url).toMatchObject({ id: 'input:2', sourceType: 'authorized-url', finalUrl: 'https://example.com/reference.txt' });
    expect(upload).not.toHaveProperty('storageReference');
    expect(new TextDecoder().decode(await inputs.readInput(upload.id))).toBe('brief');
  });
});
