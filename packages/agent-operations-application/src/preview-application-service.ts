import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  AgentOperationsStateStore,
  BoundedBrowserAdapter,
  DurableBrowserEvidence,
  DurableJob,
  DurablePreviewProfile,
  DurablePreviewSession,
  DurableAuthenticatedPreviewSession,
  PreviewAuthenticationAdapter,
  PreviewProcessAdapter,
  PreviewWorkspaceAdapter,
  RepositoryInventoryAdapter,
  RepositoryWorkspaceAdapter,
} from '../../agent-operations-contracts/src/index.js';
import {
  createBrowserEvidenceId,
  createPreviewProfileId,
  createPreviewSessionId,
  createAuthenticatedPreviewSessionId,
  executionModeForJob,
} from '../../agent-operations-contracts/src/index.js';
import type { InputApplication, PreviewApplication } from './types.js';

export interface PreviewApplicationServiceOptions {
  readonly previewWorkspaceRoot: string;
  readonly now?: () => Date;
  readonly authentication?: PreviewAuthenticationAdapter;
  readonly authenticationLifetimeMs?: number;
}

export class PreviewApplicationService implements PreviewApplication {
  private readonly now: () => Date;
  private readonly previewWorkspaceRoot: string;
  private readonly authentication?: PreviewAuthenticationAdapter;
  private readonly authenticationLifetimeMs: number;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly repositories: RepositoryInventoryAdapter,
    private readonly previewWorkspaces: PreviewWorkspaceAdapter,
    private readonly writeWorkspaces: RepositoryWorkspaceAdapter,
    private readonly processes: PreviewProcessAdapter,
    private readonly browser: BoundedBrowserAdapter,
    private readonly inputs: InputApplication,
    options: PreviewApplicationServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.previewWorkspaceRoot = resolve(options.previewWorkspaceRoot);
    this.authentication = options.authentication;
    this.authenticationLifetimeMs = options.authenticationLifetimeMs ?? 8 * 60 * 60_000;
  }

  async setJobEvidenceRequirement(
    jobId: string,
    requirement: import('../../agent-operations-contracts/src/index.js').BrowserEvidenceRequirement,
  ): Promise<void> {
    const job = await this.requireJob(jobId);
    validateRequirement(requirement);
    await this.store.setJobBrowserEvidenceRequirement(job.id, requirement);
  }

  async setJobPreviewProfile(
    jobId: string,
    command: string,
    authenticationRequired = false,
  ): Promise<DurablePreviewProfile> {
    const job = await this.requireJob(jobId);
    const project = await this.store.getProjectProfile(job.projectId);
    if (!project) throw new Error(`Project Profile not found: ${job.projectId}`);
    const existing = (await this.store.listPreviewProfiles(job.projectId)).find(value => value.name === 'default');
    const timestamp = this.now().toISOString();
    const profile: DurablePreviewProfile = {
      id: existing?.id ?? createPreviewProfileId(job.projectId),
      projectId: job.projectId,
      name: 'default',
      command: parseCandidate(command, project.detectedStack),
      status: 'candidate',
      ...(authenticationRequired ? { authenticationRequired: true } : {}),
      revision: (existing?.revision ?? -1) + 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.store.savePreviewProfile(profile);
    return profile;
  }

  async startJobPreview(jobId: string): Promise<DurablePreviewSession> {
    const job = await this.requireJob(jobId);
    const existing = await this.store.getPreviewSessionForJob(job.id);
    if (existing) {
      if (existing.state === 'running' && existing.pid) {
        const health = await this.processes.inspect(existing.pid, existing.origin);
        if (health.running && await this.isSessionSourceCurrent(job, existing)) return existing;
        if (health.running) await this.processes.stop(existing.pid);
        if (health.running) {
          await this.transitionSession(existing, 'stopped', {});
          return this.createSession(job, await this.ensureCandidateProfile(job.projectId));
        }
        await this.transitionSession(existing, 'stale', {});
      }
      const current = await this.store.getPreviewSession(existing.id) ?? existing;
      if (!['stale', 'stopped', 'failed'].includes(current.state)) {
        throw new Error(`Preview Session ${current.id} is ${current.state}`);
      }
      return this.restartSession(current);
    }
    return this.createSession(job, await this.ensureCandidateProfile(job.projectId));
  }

  private async createSession(job: DurableJob, profile: DurablePreviewProfile): Promise<DurablePreviewSession> {
    const workspace = await this.resolveWorkspace(job);
    const port = await this.processes.reservePort();
    const timestamp = this.now().toISOString();
    const session: DurablePreviewSession = {
      id: createPreviewSessionId(),
      jobId: job.id,
      projectId: job.projectId,
      repositoryId: job.repositoryId!,
      installationId: (await this.store.getInstallation()).id,
      profileId: profile.id,
      workspaceKind: workspace.kind,
      workspacePath: workspace.path,
      revisionCommit: workspace.revisionCommit,
      sourceStateHash: workspace.sourceStateHash,
      origin: `http://127.0.0.1:${port}`,
      route: (await this.store.getJobBrowserEvidenceRequirement(job.id))?.route ?? '/',
      port,
      state: 'starting',
      logs: '',
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.createPreviewSession(session);
    return this.launchSession(session, profile);
  }

  async refreshJobEvidence(jobId: string): Promise<DurableBrowserEvidence> {
    const job = await this.requireJob(jobId);
    const requirement = await this.store.getJobBrowserEvidenceRequirement(job.id);
    if (!requirement) throw new Error(`Job ${job.id} does not require browser render evidence`);
    const session = await this.store.getPreviewSessionForJob(job.id);
    if (!session || session.state !== 'running' || !session.pid) throw new Error('Start the exact Job Preview before capturing evidence');
    const health = await this.processes.inspect(session.pid, session.origin);
    if (!health.running) {
      await this.transitionSession(session, 'stale', {});
      throw new Error('Preview Process is stale. Start it again before capturing evidence.');
    }
    if (!await this.isSessionSourceCurrent(job, session)) {
      throw new Error('Preview source state changed after startup. Restart Preview before capture.');
    }
    const profile = await this.store.getPreviewProfile(session.profileId);
    const authentication = profile?.authenticationRequired
      ? await this.requireUsableAuthentication(session)
      : null;
    const capture = await this.browser.capture({
      origin: session.origin,
      route: requirement.route,
      viewport: requirement.viewport,
      ...(authentication ? { authenticationSessionId: authentication.id } : {}),
    });
    const screenshot = await this.inputs.createUploadedInput({
      displayName: `AO browser evidence ${job.id}.png`,
      mimeType: 'image/png',
      bytes: capture.screenshot,
      projectId: job.projectId,
    });
    const core = {
      jobId: job.id,
      projectId: job.projectId,
      repositoryId: job.repositoryId!,
      previewProfileId: session.profileId,
      previewSessionId: session.id,
      revisionCommit: session.revisionCommit,
      sourceStateHash: session.sourceStateHash,
      origin: session.origin,
      route: requirement.route,
      viewport: requirement.viewport,
      capturedAt: this.now().toISOString(),
      title: capture.title,
      finalUrl: capture.finalUrl,
      screenshotInputId: screenshot.id,
      screenshotSha256: screenshot.sha256,
      screenshotByteSize: screenshot.byteSize,
      screenshotWidth: capture.screenshotWidth,
      screenshotHeight: capture.screenshotHeight,
      visibleText: capture.visibleText,
      consoleFailures: capture.consoleFailures,
      failedResources: capture.failedResources,
      audit: capture.audit,
      version: 1 as const,
    };
    const evidence: DurableBrowserEvidence = {
      id: createBrowserEvidenceId(),
      ...core,
      evidenceHash: createHash('sha256').update(JSON.stringify(core)).digest('hex'),
    };
    await this.store.createBrowserEvidence(evidence);
    const attached = await this.store.listJobInputIds(job.id);
    if (!attached.includes(screenshot.id)) await this.store.attachInputsToJob(job.id, [screenshot.id]);
    return evidence;
  }

  async ensureJobEvidence(jobId: string): Promise<DurableBrowserEvidence> {
    const session = await this.startJobPreview(jobId);
    const existing = (await this.store.listBrowserEvidenceForJob(jobId)).at(-1);
    const requirement = await this.store.getJobBrowserEvidenceRequirement(jobId);
    if (existing && requirement && existing.previewSessionId === session.id
      && existing.sourceStateHash === session.sourceStateHash
      && existing.route === requirement.route
      && existing.viewport.width === requirement.viewport.width
      && existing.viewport.height === requirement.viewport.height) return existing;
    return this.refreshJobEvidence(jobId);
  }

  async getJobPreview(jobId: string) {
    const job = await this.requireJob(jobId);
    const session = await this.store.getPreviewSessionForJob(job.id);
    const profile = session
      ? await this.store.getPreviewProfile(session.profileId)
      : (await this.store.listPreviewProfiles(job.projectId)).find(value => value.name === 'default') ?? null;
    return {
      requirement: await this.store.getJobBrowserEvidenceRequirement(job.id),
      profile,
      session,
      evidence: await this.store.listBrowserEvidenceForJob(job.id),
      authentication: await this.latestAuthentication(job.projectId, profile?.id, session?.origin),
    };
  }

  async beginPreviewAuthentication(jobId: string): Promise<DurableAuthenticatedPreviewSession> {
    if (!this.authentication) throw new Error('Preview authentication is not configured');
    const job = await this.requireJob(jobId);
    const preview = await this.startJobPreview(job.id);
    const profile = await this.store.getPreviewProfile(preview.profileId);
    if (!profile?.authenticationRequired) throw new Error('Preview Profile does not require authentication');
    const existing = await this.latestAuthentication(job.projectId, profile.id, preview.origin);
    if (existing?.status === 'ready'
      && (!existing.expiresAt || new Date(existing.expiresAt).getTime() > this.now().getTime())
      && await this.authentication.isUsable({ sessionId: existing.id, origin: existing.origin })) {
      return existing;
    }
    const timestamp = this.now().toISOString();
    const session: DurableAuthenticatedPreviewSession = {
      id: createAuthenticatedPreviewSessionId(), projectId: job.projectId,
      previewProfileId: profile.id, installationId: (await this.store.getInstallation()).id,
      origin: preview.origin, status: 'pending-human-login', revision: 0,
      createdAt: timestamp, updatedAt: timestamp,
    };
    await this.store.createAuthenticatedPreviewSession(session);
    try {
      await this.authentication.begin({ sessionId: session.id, origin: session.origin });
    } catch (error) {
      const expired = this.transitionAuthentication(session, 'expired', {});
      await this.store.saveAuthenticatedPreviewSessionTransition(expired, session.revision);
      throw error;
    }
    return session;
  }

  async verifyPreviewAuthentication(jobId: string): Promise<DurableAuthenticatedPreviewSession> {
    if (!this.authentication) throw new Error('Preview authentication is not configured');
    const job = await this.requireJob(jobId);
    const preview = await this.store.getPreviewSessionForJob(job.id);
    const profile = preview ? await this.store.getPreviewProfile(preview.profileId) : null;
    const session = await this.latestAuthentication(job.projectId, profile?.id, preview?.origin);
    if (!session || session.status !== 'pending-human-login') throw new Error('No pending human Preview authentication session exists');
    if (!await this.authentication.verify({ sessionId: session.id, origin: session.origin })) {
      throw new Error('Human login is not yet verified at the exact Preview origin');
    }
    const timestamp = this.now().toISOString();
    const ready = this.transitionAuthentication(session, 'ready', {
      lastVerifiedAt: timestamp,
      expiresAt: new Date(this.now().getTime() + this.authenticationLifetimeMs).toISOString(),
    });
    await this.store.saveAuthenticatedPreviewSessionTransition(ready, session.revision);
    return ready;
  }

  async revokePreviewAuthentication(jobId: string): Promise<DurableAuthenticatedPreviewSession> {
    if (!this.authentication) throw new Error('Preview authentication is not configured');
    const job = await this.requireJob(jobId);
    const preview = await this.store.getPreviewSessionForJob(job.id);
    const profile = preview ? await this.store.getPreviewProfile(preview.profileId) : null;
    const session = await this.latestAuthentication(job.projectId, profile?.id, preview?.origin);
    if (!session || session.status === 'revoked') throw new Error('No revocable Preview authentication session exists');
    await this.authentication.revoke({ sessionId: session.id, origin: session.origin });
    const timestamp = this.now().toISOString();
    const revoked = this.transitionAuthentication(session, 'revoked', { revokedAt: timestamp });
    await this.store.saveAuthenticatedPreviewSessionTransition(revoked, session.revision);
    return revoked;
  }

  private async restartSession(session: DurablePreviewSession): Promise<DurablePreviewSession> {
    const profile = await this.store.getPreviewProfile(session.profileId);
    if (!profile) throw new Error(`Preview Profile not found: ${session.profileId}`);
    const job = await this.requireJob(session.jobId);
    if (!await this.isSessionSourceCurrent(job, session)) {
      return this.createSession(job, profile);
    }
    return this.launchSession(await this.transitionSession(session, 'starting', {}), profile);
  }

  private async launchSession(session: DurablePreviewSession, profile: DurablePreviewProfile): Promise<DurablePreviewSession> {
    try {
      const result = await this.processes.start({ workspacePath: session.workspacePath, command: profile.command, port: session.port });
      if (result.origin !== session.origin) throw new Error('Preview Process returned an origin outside durable intent');
      const running = await this.transitionSession(session, 'running', { pid: result.pid, logs: result.logs });
      if (profile.status !== 'validated') await this.updateProfile(profile, 'validated', 'passed', 'Command produced a healthy loopback preview.');
      return running;
    } catch (error) {
      const reason = bounded(error instanceof Error ? error.message : String(error), 4_096);
      await this.transitionSession(session, 'failed', { failureReason: reason, logs: reason });
      if (profile.status !== 'invalid') await this.updateProfile(profile, 'invalid', 'failed', reason);
      throw new Error(reason);
    }
  }

  private async updateProfile(
    profile: DurablePreviewProfile,
    status: 'validated' | 'invalid',
    validationStatus: 'passed' | 'failed',
    message: string,
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.store.savePreviewProfile({
      ...profile, status,
      validation: { status: validationStatus, checkedAt: timestamp, message },
      revision: profile.revision + 1, updatedAt: timestamp,
    });
  }

  private async requireUsableAuthentication(
    preview: DurablePreviewSession,
  ): Promise<DurableAuthenticatedPreviewSession> {
    if (!this.authentication) throw new Error('Preview authentication required, but no secure node local adapter is configured');
    const session = await this.latestAuthentication(preview.projectId, preview.profileId, preview.origin);
    if (!session || session.status !== 'ready') throw new Error('Preview authentication required');
    if (session.expiresAt && new Date(session.expiresAt).getTime() <= this.now().getTime()) {
      const expired = this.transitionAuthentication(session, 'expired', {});
      await this.store.saveAuthenticatedPreviewSessionTransition(expired, session.revision);
      throw new Error('Preview authentication expired');
    }
    if (!await this.authentication.isUsable({ sessionId: session.id, origin: session.origin })) {
      const expired = this.transitionAuthentication(session, 'expired', {});
      await this.store.saveAuthenticatedPreviewSessionTransition(expired, session.revision);
      throw new Error('Preview authentication expired');
    }
    return session;
  }

  private async latestAuthentication(
    projectId: string,
    profileId?: string,
    origin?: string,
  ): Promise<DurableAuthenticatedPreviewSession | null> {
    return [...await this.store.listAuthenticatedPreviewSessions(projectId)].reverse()
      .find(session => (!profileId || session.previewProfileId === profileId)
        && (!origin || session.origin === origin)) ?? null;
  }

  private transitionAuthentication(
    session: DurableAuthenticatedPreviewSession,
    status: DurableAuthenticatedPreviewSession['status'],
    change: Partial<DurableAuthenticatedPreviewSession>,
  ): DurableAuthenticatedPreviewSession {
    return { ...session, ...change, status, revision: session.revision + 1, updatedAt: this.now().toISOString() };
  }

  private async ensureCandidateProfile(projectId: string): Promise<DurablePreviewProfile> {
    const existing = (await this.store.listPreviewProfiles(projectId)).find(value => value.name === 'default');
    if (existing) return existing;
    const project = await this.store.getProjectProfile(projectId);
    const candidate = project?.previewCommandCandidates[0];
    if (!candidate) throw new Error('No detected Preview command is available. Configure a Preview Profile first.');
    const timestamp = this.now().toISOString();
    const profile: DurablePreviewProfile = {
      id: createPreviewProfileId(projectId), projectId, name: 'default',
      command: parseCandidate(candidate, project.detectedStack), status: 'candidate', revision: 0,
      createdAt: timestamp, updatedAt: timestamp,
    };
    await this.store.savePreviewProfile(profile);
    return profile;
  }

  private async resolveWorkspace(job: DurableJob) {
    if (executionModeForJob(job) === 'repository-write-isolated') {
      const workspace = await this.store.getRepositoryWorkspaceForJob(job.id);
      if (!workspace || !['active', 'reviewing', 'ready_for_approval'].includes(workspace.state)) {
        throw new Error('Write Job has no active isolated workspace for Preview');
      }
      const inspection = await this.repositories.inspectRepository(workspace.canonicalPath);
      if (inspection.id !== job.repositoryId || inspection.headCommit !== workspace.baseRevision) {
        throw new Error('Write Job Preview workspace identity or base revision is invalid');
      }
      return {
        kind: 'isolated-write-worktree' as const, path: workspace.canonicalPath,
        revisionCommit: workspace.baseRevision,
        sourceStateHash: await this.sourceStateHash(job, workspace.canonicalPath, workspace.baseRevision),
      };
    }
    const installation = await this.store.getInstallation();
    const bindings = (await this.store.listCheckoutBindings(job.repositoryId))
      .filter(value => value.installationId === installation.id && value.availability === 'available');
    if (bindings.length !== 1) throw new Error('Read only Preview requires exactly one available checkout binding');
    const observation = await this.store.getLatestRepositoryObservation(bindings[0].id);
    const revisionCommit = observation?.headCommit;
    if (!revisionCommit) throw new Error('Read only Preview requires a verified repository revision');
    const destinationPath = resolve(this.previewWorkspaceRoot, `${job.id.replace(':', '-')}-${revisionCommit.slice(0, 12)}`);
    const inspection = await this.previewWorkspaces.prepareReadOnlyWorkspace({
      sourceCheckoutPath: bindings[0].canonicalPath, destinationPath,
      repositoryId: job.repositoryId!, revisionCommit,
    });
    if (inspection.reason || !inspection.exists || !inspection.registered || !inspection.detachedHead || !inspection.clean) {
      throw new Error(inspection.reason ?? 'Read only Preview workspace validation failed');
    }
    return {
      kind: 'read-only-detached-worktree' as const, path: destinationPath, revisionCommit,
      sourceStateHash: hashSource(revisionCommit, 'clean'),
    };
  }

  private async sourceStateHash(job: DurableJob, path: string, revision: string): Promise<string> {
    if (executionModeForJob(job) === 'repository-read-only') return hashSource(revision, 'clean');
    const evidence = await this.writeWorkspaces.captureEvidence(path);
    return hashSource(revision, JSON.stringify(evidence));
  }

  private async isSessionSourceCurrent(job: DurableJob, session: DurablePreviewSession): Promise<boolean> {
    if (executionModeForJob(job) === 'repository-write-isolated') {
      return await this.sourceStateHash(job, session.workspacePath, session.revisionCommit) === session.sourceStateHash;
    }
    const installation = await this.store.getInstallation();
    const bindings = (await this.store.listCheckoutBindings(job.repositoryId))
      .filter(value => value.installationId === installation.id && value.availability === 'available');
    if (bindings.length !== 1) return false;
    const observation = await this.store.getLatestRepositoryObservation(bindings[0].id);
    return observation?.headCommit === session.revisionCommit
      && hashSource(session.revisionCommit, 'clean') === session.sourceStateHash;
  }

  private async transitionSession(
    session: DurablePreviewSession,
    state: DurablePreviewSession['state'],
    changes: { pid?: number; logs?: string; failureReason?: string },
  ): Promise<DurablePreviewSession> {
    const updated: DurablePreviewSession = {
      ...session, state,
      ...(changes.pid ? { pid: changes.pid } : { pid: undefined }),
      logs: changes.logs ?? session.logs,
      ...(changes.failureReason ? { failureReason: changes.failureReason } : { failureReason: undefined }),
      revision: session.revision + 1, updatedAt: this.now().toISOString(),
    };
    await this.store.savePreviewSessionTransition(updated, session.revision);
    return updated;
  }

  private async requireJob(jobId: string): Promise<DurableJob> {
    const job = await this.store.getJob(jobId.trim());
    if (!job?.repositoryId) throw new Error(`Repository bound Job not found: ${jobId}`);
    return job;
  }
}

function parseCandidate(candidate: string, stack: readonly string[]) {
  const tokens = candidate.trim().split(/\s+/);
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(tokens[0]) || tokens.length < 2 || tokens.length > 8
    || tokens.some(value => !/^[a-zA-Z0-9:_./-]+$/.test(value))) {
    throw new Error('Detected Preview command is outside the bounded command contract');
  }
  const arguments_ = tokens.slice(1);
  const packageScript = tokens[1] === 'run';
  if (stack.some(value => value.toLowerCase().includes('next'))) {
    arguments_.push(...(packageScript ? ['--'] : []), '--hostname', '{host}', '--port', '{port}');
  } else if (stack.some(value => value.toLowerCase().includes('vite'))) {
    arguments_.push(...(packageScript ? ['--'] : []), '--host', '{host}', '--port', '{port}');
  }
  return { executable: tokens[0] as 'npm' | 'pnpm' | 'yarn' | 'bun', arguments: arguments_ };
}

function hashSource(revision: string, evidence: string): string {
  return createHash('sha256').update('ao-preview-source-v1\0').update(revision).update('\0').update(evidence).digest('hex');
}

function bounded(value: string, limit: number): string { return value.length > limit ? value.slice(0, limit) : value; }

function validateRequirement(
  requirement: import('../../agent-operations-contracts/src/index.js').BrowserEvidenceRequirement,
): void {
  if (requirement.kind !== 'browser-render' || !/^\/(?!\/)/.test(requirement.route)
    || requirement.route.includes('\0') || requirement.route.includes('://')) {
    throw new Error('Browser evidence route must be an application route');
  }
  if (!Number.isInteger(requirement.viewport.width) || requirement.viewport.width < 320 || requirement.viewport.width > 2_560
    || !Number.isInteger(requirement.viewport.height) || requirement.viewport.height < 240 || requirement.viewport.height > 2_560) {
    throw new Error('Browser evidence viewport is outside bounds');
  }
}
