import { createHash, randomUUID } from 'node:crypto';

export type PreviewProfileStatus = 'candidate' | 'validated' | 'invalid';

export interface PreviewCommand {
  readonly executable: 'npm' | 'pnpm' | 'yarn' | 'bun';
  readonly arguments: readonly string[];
}

export interface PreviewProfileValidation {
  readonly status: 'passed' | 'failed';
  readonly checkedAt: string;
  readonly message: string;
}

/** A human visible, durable command choice. Detection alone never authorizes execution. */
export interface DurablePreviewProfile {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly command: PreviewCommand;
  readonly status: PreviewProfileStatus;
  readonly validation?: PreviewProfileValidation;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PreviewWorkspaceKind = 'read-only-detached-worktree' | 'isolated-write-worktree';
export type PreviewProcessState = 'starting' | 'running' | 'stopped' | 'failed' | 'stale';

/** Installation-local process placement. Identity is the session ID, never the path or PID. */
export interface DurablePreviewSession {
  readonly id: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly installationId: string;
  readonly profileId: string;
  readonly workspaceKind: PreviewWorkspaceKind;
  readonly workspacePath: string;
  readonly revisionCommit: string;
  readonly sourceStateHash: string;
  readonly origin: string;
  readonly route: string;
  readonly port: number;
  readonly pid?: number;
  readonly state: PreviewProcessState;
  readonly logs: string;
  readonly failureReason?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BrowserViewport {
  readonly width: number;
  readonly height: number;
}

export interface BrowserEvidenceRequirement {
  readonly kind: 'browser-render';
  readonly route: string;
  readonly viewport: BrowserViewport;
}

export interface BrowserEvidenceAuditOperation {
  readonly operation: 'navigate' | 'screenshot' | 'read-title' | 'read-visible-text';
  readonly target: string;
  readonly occurredAt: string;
}

/** Bounded render evidence. Screenshot bytes live behind the existing Input storage boundary. */
export interface DurableBrowserEvidence {
  readonly id: string;
  readonly jobId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly previewProfileId: string;
  readonly previewSessionId: string;
  readonly revisionCommit: string;
  readonly sourceStateHash: string;
  readonly origin: string;
  readonly route: string;
  readonly viewport: BrowserViewport;
  readonly capturedAt: string;
  readonly title: string;
  readonly finalUrl: string;
  readonly screenshotInputId: string;
  readonly screenshotSha256: string;
  readonly screenshotByteSize: number;
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  readonly visibleText: string;
  readonly consoleFailures: readonly string[];
  readonly failedResources: readonly string[];
  readonly audit: readonly BrowserEvidenceAuditOperation[];
  readonly version: 1;
  readonly evidenceHash: string;
}

export interface BrowserCaptureRequest {
  readonly origin: string;
  readonly route: string;
  readonly viewport: BrowserViewport;
}

export interface BrowserCaptureResult {
  readonly title: string;
  readonly finalUrl: string;
  readonly screenshot: Uint8Array;
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  readonly visibleText: string;
  readonly consoleFailures: readonly string[];
  readonly failedResources: readonly string[];
  readonly audit: readonly BrowserEvidenceAuditOperation[];
}

/** Browser implementation port. Implementations may only reach the supplied loopback origin. */
export interface BoundedBrowserAdapter {
  capture(request: BrowserCaptureRequest): Promise<BrowserCaptureResult>;
}

export interface ReadOnlyPreviewWorkspaceRequest {
  readonly sourceCheckoutPath: string;
  readonly destinationPath: string;
  readonly repositoryId: string;
  readonly revisionCommit: string;
}

export interface ReadOnlyPreviewWorkspaceInspection {
  readonly exists: boolean;
  readonly registered: boolean;
  readonly canonicalPath?: string;
  readonly repositoryId?: string;
  readonly revisionCommit?: string;
  readonly detachedHead?: boolean;
  readonly clean?: boolean;
  readonly reason?: string;
}

export interface PreviewWorkspaceAdapter {
  prepareReadOnlyWorkspace(input: ReadOnlyPreviewWorkspaceRequest): Promise<ReadOnlyPreviewWorkspaceInspection>;
  inspectReadOnlyWorkspace(input: ReadOnlyPreviewWorkspaceRequest): Promise<ReadOnlyPreviewWorkspaceInspection>;
  removeReadOnlyWorkspace(input: ReadOnlyPreviewWorkspaceRequest): Promise<ReadOnlyPreviewWorkspaceInspection>;
}

export interface PreviewProcessStartRequest {
  readonly workspacePath: string;
  readonly command: PreviewCommand;
  readonly port: number;
}

export interface PreviewProcessStartResult {
  readonly pid: number;
  readonly origin: string;
  readonly logs: string;
}

export interface PreviewProcessInspection {
  readonly running: boolean;
  readonly pid?: number;
  readonly reason?: string;
}

export interface PreviewProcessAdapter {
  reservePort(): Promise<number>;
  start(input: PreviewProcessStartRequest): Promise<PreviewProcessStartResult>;
  inspect(pid: number, origin: string): Promise<PreviewProcessInspection>;
  stop(pid: number): Promise<void>;
}

export function createPreviewProfileId(projectId: string, name = 'default'): string {
  return `preview-profile:${createHash('sha256').update(projectId).update('\0').update(name).digest('hex')}`;
}

export function createPreviewSessionId(uuid: string = randomUUID()): string {
  return `preview-session:${uuid}`;
}

export function createBrowserEvidenceId(uuid: string = randomUUID()): string {
  return `browser-evidence:${uuid}`;
}
