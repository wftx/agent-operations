import { describe, expect, it, vi } from 'vitest';
import type {
  InputApplication,
  OperatorApplication,
  ProjectApplication,
  ProjectOnboardingResult,
} from '../../../packages/agent-operations-application/src/index.js';
import { OperatorWebApplication } from '../src/app.js';
import { renderProjects } from '../src/render.js';

const TIME = '2026-08-31T12:00:00.000Z';
const onboarded: ProjectOnboardingResult = {
  project: { id: 'project:new', name: 'New Project', createdAt: TIME, updatedAt: TIME },
  repositories: [], localFolders: [], repositoryReadiness: [],
  profile: {
    projectId: 'project:new', resourceSummary: 'No resource attached', detectedStack: [],
    buildCommandCandidates: [], testCommandCandidates: [], previewCommandCandidates: [], deploymentClues: [],
    documentation: [], capabilities: {
      repositoryReadOnlyJobs: 'unavailable', isolatedCodeChangeJobs: 'unavailable',
      boundedFileInspection: 'unavailable', inputs: 'available', orchestratorConversation: 'available',
      build: 'unknown', preview: 'unknown', publish: 'unknown',
    }, warnings: [], knownConstraints: [], agentsFileSuggestion: false, inspectedAt: TIME, revision: 0,
  },
};
const gitOnboarded: ProjectOnboardingResult = {
  ...onboarded,
  repositories: [{
    id: 'remote:github.com/example/site', identityKind: 'remote', name: 'site',
    canonicalRemote: 'github.com/example/site', createdAt: TIME, updatedAt: TIME,
  }],
  repositoryReadiness: [{
    repositoryId: 'remote:github.com/example/site', canonicalPath: '/projects/site',
    canonicalRemote: 'github.com/example/site', availability: 'available', branch: 'main',
    detachedHead: false, headCommit: 'a'.repeat(40), workingTree: 'dirty',
  }],
  profile: {
    ...onboarded.profile,
    resourceSummary: 'Git repository detected',
    capabilities: {
      ...onboarded.profile.capabilities,
      repositoryReadOnlyJobs: 'available', isolatedCodeChangeJobs: 'available',
      boundedFileInspection: 'available',
    },
  },
};
const folderOnboarded: ProjectOnboardingResult = {
  ...onboarded,
  localFolders: [{
    id: 'folder:local', projectId: 'project:new', installationId: 'installation:test',
    canonicalPath: '/projects/notes', fingerprint: 'b'.repeat(64), availability: 'available',
    firstSeenAt: TIME, lastSeenAt: TIME,
  }],
  profile: {
    ...onboarded.profile,
    resourceSummary: 'Local folder',
    capabilities: { ...onboarded.profile.capabilities, boundedFileInspection: 'available' },
  },
};

describe('AO Web Project onboarding and Inputs', () => {
  it('renders upload selection, drop, removal, and authorized URL controls', async () => {
    const app = new OperatorWebApplication(fakeOperator(), fakeConversation(), {}, fakeProjects(), fakeInputs());
    const page = await (await app.handle(new Request('http://127.0.0.1/orchestrator'))).text();
    expect(page).toContain('id="orchestrator-file-drop"');
    expect(page).toContain('id="orchestrator-input-chip"');
    expect(page).toContain('id="orchestrator-input-remove"');
    expect(page).toContain('name="inputUrl"');
  });

  it('offers one folder choice with automatic Git detection and Start Without Files', async () => {
    const app = new OperatorWebApplication(fakeOperator(), fakeConversation(), {}, fakeProjects(), fakeInputs());
    const page = await (await app.handle(new Request('http://127.0.0.1/projects/new'))).text();
    expect(page).toContain('Add Local Folder');
    expect(page).toContain('Start Without Files');
    expect(page).toContain('AO will detect Git and available capabilities automatically');
    expect(page).not.toContain('Existing Git repository');
    expect(page).not.toContain('Existing local folder');
  });

  it('submits Add Local Folder without asking the operator to classify Git', async () => {
    const projects = fakeProjects();
    const app = new OperatorWebApplication(fakeOperator(), fakeConversation(), {}, projects, fakeInputs());
    const body = new URLSearchParams({ name: 'New Project', description: '', resourceType: 'local-folder', path: '/projects/example' });
    const response = await app.handle(new Request('http://127.0.0.1/projects', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    }));
    expect(response.status).toBe(303);
    expect(projects.createProject).toHaveBeenCalledWith(expect.objectContaining({
      resource: { type: 'local-folder', path: '/projects/example' },
    }));
  });

  it('shows the detected repository details and capabilities after inspection', () => {
    const page = renderProjects([gitOnboarded]);
    expect(page).toContain('Git repository detected');
    expect(page).toContain('github.com/example/site');
    expect(page).toContain('<dt>Branch</dt><dd>main</dd>');
    expect(page).toContain('<dt>Working tree</dt><dd>dirty</dd>');
    expect(page).toContain('<dt>Repository read</dt><dd>Available</dd>');
    expect(page).toContain('<dt>Isolated code changes</dt><dd>Available</dd>');
  });

  it('shows bounded folder access without repository capabilities for an ordinary folder', () => {
    const page = renderProjects([folderOnboarded]);
    expect(page).toContain('<dt>Detected resource</dt><dd>Local folder</dd>');
    expect(page).toContain('<dt>Git repository</dt><dd>Not detected</dd>');
    expect(page).toContain('<dt>File and context access</dt><dd>Available</dd>');
    expect(page).toContain('<dt>Repository code change Jobs</dt><dd>Unavailable</dd>');
  });

  it('renders and submits Start Without Files without creating a Job', async () => {
    const operator = fakeOperator();
    const projects = fakeProjects();
    const app = new OperatorWebApplication(operator, fakeConversation(), {}, projects, fakeInputs());
    expect(await (await app.handle(new Request('http://127.0.0.1/projects/new'))).text()).toContain('Start Without Files');
    const body = new URLSearchParams({ name: 'New Project', description: '', resourceType: 'none', path: '' });
    const response = await app.handle(new Request('http://127.0.0.1/projects', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    }));
    expect(response.status).toBe(303);
    expect(projects.createProject).toHaveBeenCalledWith(expect.objectContaining({ resource: { type: 'none' } }));
    expect(operator.runOperatorJob).not.toHaveBeenCalled();
  });

  it('ingests an uploaded file before sending one conversation turn with its Input ID', async () => {
    const conversation = fakeConversation();
    const inputs = fakeInputs();
    const form = new FormData();
    form.set('message', 'Use the brief.');
    form.set('projectId', 'project:new');
    form.set('attachment', new File([new Uint8Array([1, 2, 3])], 'brief.bin', { type: 'application/octet-stream' }));
    const app = new OperatorWebApplication(fakeOperator(), conversation, {}, fakeProjects(), inputs);
    const response = await app.handle(new Request('http://127.0.0.1/orchestrator/turn', { method: 'POST', body: form }));
    expect(response.status).toBe(303);
    expect(inputs.createUploadedInput).toHaveBeenCalled();
    expect(conversation.sendTurn).toHaveBeenCalledWith({
      message: 'Use the brief.', projectId: 'project:new', inputIds: ['input:upload'],
    });
  });
});

function fakeProjects(): ProjectApplication & { createProject: ReturnType<typeof vi.fn> } {
  return {
    createProject: vi.fn(async () => onboarded), getProject: vi.fn(async () => onboarded),
    listProjects: vi.fn(async () => [onboarded]),
  };
}

function fakeInputs(): InputApplication & { createUploadedInput: ReturnType<typeof vi.fn> } {
  const metadata = { id: 'input:upload', displayName: 'brief.bin', mimeType: 'application/octet-stream', byteSize: 3, sha256: 'a'.repeat(64), sourceType: 'uploaded-file' as const, projectId: 'project:new', createdAt: TIME };
  return {
    createUploadedInput: vi.fn(async () => metadata), createUrlInput: vi.fn(async () => metadata),
    getInput: vi.fn(async () => metadata), listInputs: vi.fn(async () => [metadata]), readInput: vi.fn(), associateWithConversation: vi.fn(),
  };
}

function fakeConversation() {
  return {
    sendTurn: vi.fn(async input => ({ agentId: 'ao-orchestrator', sessionId: 'session', turn: { id: 'conversation:1', operatorMessage: input.message, relatedJobIds: [], clarificationRequired: false, status: 'completed' as const, createdAt: TIME } })),
    getConversationState: vi.fn(async () => ({ agentId: 'ao-orchestrator', sessionId: 'session', runtimeState: 'ready' as const, turns: [] })),
  };
}

function fakeOperator(): OperatorApplication {
  return {
    startRunner() {}, listProjects: vi.fn(async () => []), getRuntimeStatus: vi.fn(), startRuntime: vi.fn(),
    previewTask: vi.fn(), runOperatorJob: vi.fn(), waitForRun: vi.fn(), provideGuidanceAndContinue: vi.fn(),
    reconcileTimedOutExecution: vi.fn(), cancelEscalatedJob: vi.fn(), listJobs: vi.fn(async () => []), getJobDetail: vi.fn(),
  };
}
