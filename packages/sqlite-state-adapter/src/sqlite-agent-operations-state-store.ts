import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type {
  AgentOperationsInstallation,
  AgentOperationsStateStore,
  DurableProject,
  DurableProjectConfiguration,
  DurableJob,
  DurableJobAttempt,
  DurableExecutionPlan,
  DurableExecutionDispatch,
  DispatchStatus,
  DurableExecutionObservation,
  DurableAttemptOutcomeDecision,
  ExecutionObservationKind,
  ExecutionCorrelation,
  AttemptOutcome,
  AttemptOutcomeDecisionSource,
  DurableRepository,
  DurableRepositoryObservation,
  DurableRuntimeObservation,
  NewDurableJobAttempt,
  AttemptStatus,
  JobStatus,
  RepositoryCheckoutBinding,
  RepositoryIdentityKind,
  RepositoryAvailability,
  RuntimeProvider,
  RuntimeFilesystemPolicy,
  RuntimeNetworkPolicy,
  RuntimeEnvironmentPolicy,
  RuntimeState,
  WorkingTreeState,
  ExecutionRole,
  AttemptReviewDecision,
  DurableAttemptReview,
  DurableEscalation,
  EscalationReason,
  DurableHumanGuidance,
  DurableWorkerBudgetExtension,
  DurableOperatorNotificationDelivery,
  DurableOperatorRun,
  OperatorNotificationDeliveryStatus,
  OperatorNotificationKind,
  OperatorRunStatus,
  DurableRepositoryWorkspace,
  JobExecutionMode,
  RepositoryWorkspaceState,
  RuntimeToolOperation,
  DurableLocalFolderResource,
  DurableProjectProfile,
  ProjectDocumentationEntry,
  ProjectCapabilityReadiness,
  DurableInput,
  InputSourceType,
  BrowserEvidenceRequirement,
  DurableBrowserEvidence,
  DurablePreviewProfile,
  DurablePreviewSession,
  PreviewProcessState,
  PreviewProfileStatus,
  PreviewWorkspaceKind,
  DurableAuthenticatedPreviewSession,
  AuthenticatedPreviewSessionStatus,
  DurableTrustProfile,
  TrustProfilePolicy,
  TrustProfilePreset,
  TrustProfileScope,
  DurableJobRetirement,
  JobRetirementDisposition,
  DurableRepositoryRestoreAction,
  RepositoryRestoreState,
} from '../../agent-operations-contracts/src/index.js';
import {
  createRepositoryCheckoutBindingId,
  isRuntimeExecutionCapabilitiesNoBroaderThan,
  isRuntimeExecutionPolicyNoBroaderThan,
  isBoundedExecutionResult,
  validateTrustProfile,
} from '../../agent-operations-contracts/src/index.js';
import { applyStateMigrations, type SqliteStateMigration } from './migrations.js';
import { resolveAgentOperationsStateLocation } from './state-location.js';

export interface SqliteAgentOperationsStateStoreOptions {
  readonly databasePath?: string;
  readonly installationLabel?: string;
  readonly installationIdFactory?: () => string;
  readonly now?: () => Date;
  /** Test/migration-development seam. Production schema lives in the default migration list. */
  readonly additionalMigrations?: readonly SqliteStateMigration[];
  /** Test seam for proving an actual v1 -> v2 upgrade. Never set by production composition. */
  readonly targetSchemaVersion?: number;
}

interface ProjectRow {
  id: string;
  name: string;
  description?: string | null;
  created_at: string;
  updated_at: string;
}

interface LocalFolderRow {
  id: string;
  project_id: string;
  installation_id: string;
  canonical_path: string;
  fingerprint: string;
  availability: 'available' | 'unavailable';
  first_seen_at: string;
  last_seen_at: string;
}

interface ProjectProfileRow {
  project_id: string;
  resource_summary: string;
  detected_stack_json: string;
  package_manager: string | null;
  build_commands_json: string;
  test_commands_json: string;
  preview_commands_json: string;
  deployment_clues_json: string;
  documentation_json: string;
  capabilities_json: string;
  warnings_json: string;
  known_constraints_json: string;
  agents_file_suggestion: number;
  inspected_at: string;
  revision: number;
}

interface TrustProfileRow {
  id: string;
  scope: TrustProfileScope;
  scope_id: string | null;
  name: string;
  preset: TrustProfilePreset;
  policy_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface InputRow {
  id: string;
  display_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  source_type: InputSourceType;
  original_url: string | null;
  final_url: string | null;
  project_id: string | null;
  storage_reference: string;
  ingestion_state: 'complete';
  validation_state: 'valid';
  created_at: string;
}

interface PreviewProfileRow {
  id: string;
  project_id: string;
  name: string;
  command_json: string;
  status: PreviewProfileStatus;
  authentication_required?: number;
  validation_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface AuthenticatedPreviewSessionRow {
  id: string;
  project_id: string;
  preview_profile_id: string;
  installation_id: string;
  origin: string;
  status: AuthenticatedPreviewSessionStatus;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revision: number;
}

interface PreviewSessionRow {
  id: string;
  job_id: string;
  project_id: string;
  repository_id: string;
  installation_id: string;
  profile_id: string;
  workspace_kind: PreviewWorkspaceKind;
  workspace_path: string;
  revision_commit: string;
  source_state_hash: string;
  origin: string;
  route: string;
  port: number;
  pid: number | null;
  state: PreviewProcessState;
  logs: string;
  failure_reason: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface BrowserEvidenceRow {
  id: string;
  job_id: string;
  project_id: string;
  repository_id: string;
  preview_profile_id: string;
  preview_session_id: string;
  revision_commit: string;
  source_state_hash: string;
  origin: string;
  route: string;
  viewport_json: string;
  captured_at: string;
  title: string;
  final_url: string;
  screenshot_input_id: string;
  screenshot_sha256: string;
  screenshot_byte_size: number;
  screenshot_width: number;
  screenshot_height: number;
  visible_text: string;
  console_failures_json: string;
  failed_resources_json: string;
  audit_json: string;
  version: 1;
  evidence_hash: string;
}

interface RepositoryRow {
  id: string;
  identity_kind: RepositoryIdentityKind;
  name: string;
  canonical_remote: string | null;
  created_at: string;
  updated_at: string;
}

interface CheckoutRow {
  id: string;
  repository_id: string;
  installation_id: string;
  canonical_path: string;
  availability: RepositoryAvailability;
  first_seen_at: string;
  last_seen_at: string;
}

interface RepositoryObservationRow {
  repository_id: string;
  checkout_binding_id: string;
  availability: RepositoryAvailability;
  branch: string | null;
  detached_head: number;
  head_commit: string | null;
  working_tree: WorkingTreeState;
  reason: string | null;
  observed_at: string;
}

interface RuntimeObservationRow {
  project_id: string;
  agent_id: string;
  association_state: 'available' | 'unavailable';
  provider: RuntimeProvider | null;
  runtime_state: RuntimeState | null;
  enabled_known: number;
  enabled: number | null;
  configured_known: number;
  configured: number | null;
  last_heartbeat: string | null;
  reason: string | null;
  observed_at: string;
}

interface JobRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  acceptance_criteria?: string | null;
  automatic_read_only_completion?: number;
  execution_mode?: JobExecutionMode;
  status: JobStatus;
  repository_id: string | null;
  preferred_runtime_agent_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  job_id: string;
  sequence: number;
  execution_role?: ExecutionRole;
  role_sequence?: number;
  runtime_agent_id: string | null;
  status: AttemptStatus;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  failure_reason: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ExecutionPlanRow {
  id: string;
  attempt_id: string;
  job_id: string;
  project_id: string;
  installation_id: string;
  runtime_agent_id: string;
  repository_id: string | null;
  checkout_binding_id: string | null;
  repository_workspace_id?: string | null;
  input_version: 1;
  instruction: string;
  requested_policy_version?: 1 | null;
  requested_filesystem?: RuntimeFilesystemPolicy | null;
  requested_network?: RuntimeNetworkPolicy | null;
  requested_environment?: RuntimeEnvironmentPolicy | null;
  requested_capabilities_version?: 1 | null;
  requested_repository_read?: number | null;
  requested_repository_patch?: number | null;
  requested_test_run?: number | null;
  requested_git_inspect?: number | null;
  requested_input_read?: number | null;
  job_revision: number;
  attempt_revision: number;
  created_at: string;
}

interface ExecutionDispatchRow {
  id: string;
  execution_plan_id: string;
  attempt_id: string;
  job_id: string;
  runtime_agent_id: string;
  idempotency_key: string;
  status: DispatchStatus;
  effective_policy_version?: 1 | null;
  effective_filesystem?: RuntimeFilesystemPolicy | null;
  effective_network?: RuntimeNetworkPolicy | null;
  effective_environment?: RuntimeEnvironmentPolicy | null;
  effective_capabilities_version?: 1 | null;
  effective_repository_read?: number | null;
  effective_repository_patch?: number | null;
  effective_test_run?: number | null;
  effective_git_inspect?: number | null;
  effective_input_read?: number | null;
  external_reference: string | null;
  message: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  accepted_at: string | null;
  resolved_at: string | null;
}

interface ExecutionObservationRow {
  id: string;
  dispatch_id: string;
  attempt_id: string;
  source: string;
  source_event_id: string;
  kind: ExecutionObservationKind;
  correlation: ExecutionCorrelation;
  correlated_dispatch_id: string | null;
  runtime_session_id: string | null;
  external_reference: string | null;
  message: string | null;
  output_summary: string | null;
  result_text?: string | null;
  execution_working_directory?: string | null;
  effective_policy_version?: 1 | null;
  effective_filesystem?: RuntimeFilesystemPolicy | null;
  effective_network?: RuntimeNetworkPolicy | null;
  effective_environment?: RuntimeEnvironmentPolicy | null;
  repository_read_root?: string | null;
  repository_write_root?: string | null;
  effective_capabilities_version?: 1 | null;
  effective_repository_read?: number | null;
  effective_repository_patch?: number | null;
  effective_test_run?: number | null;
  effective_git_inspect?: number | null;
  effective_input_read?: number | null;
  tool_operations_json?: string | null;
  observed_at: string;
  recorded_at: string;
}

interface RepositoryWorkspaceRow {
  id: string;
  job_id: string;
  project_id: string;
  repository_id: string;
  source_checkout_binding_id: string;
  base_revision: string;
  base_branch: string | null;
  branch_name: string;
  canonical_path: string;
  state: RepositoryWorkspaceState;
  evidence_json: string | null;
  failure_reason: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface JobRetirementRow {
  job_id: string;
  disposition: JobRetirementDisposition;
  reason: string;
  actor: string;
  evidence_reference: string | null;
  retired_at: string;
}

interface RepositoryRestoreActionRow {
  id: string;
  project_id: string;
  repository_id: string;
  checkout_binding_id: string;
  state: RepositoryRestoreState;
  preconditions_json: string;
  approval_summary: string;
  requested_by: string;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  result_json: string | null;
  failure_reason: string | null;
  revision: number;
}

interface AttemptReviewRow {
  id: string;
  job_id: string;
  worker_attempt_id: string;
  reviewer_attempt_id: string;
  reviewer_runtime_agent_id: string;
  decision: AttemptReviewDecision;
  summary: string;
  feedback: string | null;
  created_at: string;
}

interface EscalationRow {
  id: string;
  job_id: string;
  attempt_id: string | null;
  review_id: string | null;
  reason: EscalationReason;
  summary: string;
  created_at: string;
  resolved_at: string | null;
  resolution_summary?: string | null;
}

interface AttemptOutcomeDecisionRow {
  id: string;
  attempt_id: string;
  dispatch_id: string;
  outcome: AttemptOutcome;
  source: AttemptOutcomeDecisionSource;
  summary: string | null;
  reason: string | null;
  evidence_observation_id: string | null;
  override_without_exact_evidence: number;
  created_at: string;
}

interface OperatorRunRow {
  id: string;
  job_id: string;
  status: OperatorRunStatus;
  failure_message: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface HumanGuidanceRow {
  id: string;
  job_id: string;
  escalation_id: string;
  instruction: string;
  created_at: string;
}

interface WorkerBudgetExtensionRow {
  id: string;
  job_id: string;
  escalation_id: string;
  additional_worker_executions: 1;
  created_at: string;
}

interface OperatorNotificationDeliveryRow {
  id: string;
  event_key: string;
  kind: OperatorNotificationKind;
  job_id: string;
  escalation_id: string | null;
  status: OperatorNotificationDeliveryStatus;
  message: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  attempted_at: string | null;
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} is required`);
}

function rejectDuplicates(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    requireNonEmpty(value, field);
    if (seen.has(value)) throw new Error(`Duplicate ${field}: ${value}`);
    seen.add(value);
  }
}

function toProject(row: ProjectRow): DurableProject {
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLocalFolder(row: LocalFolderRow): DurableLocalFolderResource {
  return {
    id: row.id,
    projectId: row.project_id,
    installationId: row.installation_id,
    canonicalPath: row.canonical_path,
    fingerprint: row.fingerprint,
    availability: row.availability,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function jsonArray<T>(value: string, field: string): readonly T[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Invalid ${field} JSON in Agent Operations state`);
  return parsed as T[];
}

function toProjectProfile(row: ProjectProfileRow): DurableProjectProfile {
  const capabilities = JSON.parse(row.capabilities_json) as ProjectCapabilityReadiness;
  return {
    projectId: row.project_id,
    resourceSummary: row.resource_summary,
    detectedStack: jsonArray<string>(row.detected_stack_json, 'detected stack'),
    ...(row.package_manager ? { packageManager: row.package_manager } : {}),
    buildCommandCandidates: jsonArray<string>(row.build_commands_json, 'build commands'),
    testCommandCandidates: jsonArray<string>(row.test_commands_json, 'test commands'),
    previewCommandCandidates: jsonArray<string>(row.preview_commands_json, 'preview commands'),
    deploymentClues: jsonArray<string>(row.deployment_clues_json, 'deployment clues'),
    documentation: jsonArray<ProjectDocumentationEntry>(row.documentation_json, 'documentation'),
    capabilities,
    warnings: jsonArray<string>(row.warnings_json, 'warnings'),
    knownConstraints: jsonArray<string>(row.known_constraints_json, 'known constraints'),
    agentsFileSuggestion: row.agents_file_suggestion === 1,
    inspectedAt: row.inspected_at,
    revision: row.revision,
  };
}

function toTrustProfile(row: TrustProfileRow): DurableTrustProfile {
  return {
    id: row.id,
    scope: row.scope,
    ...(row.scope_id ? { scopeId: row.scope_id } : {}),
    name: row.name,
    preset: row.preset,
    policy: JSON.parse(row.policy_json) as TrustProfilePolicy,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toInput(row: InputRow): DurableInput {
  return {
    id: row.id,
    displayName: row.display_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    sourceType: row.source_type,
    ...(row.original_url ? { originalUrl: row.original_url } : {}),
    ...(row.final_url ? { finalUrl: row.final_url } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    storageReference: row.storage_reference,
    ingestionState: row.ingestion_state,
    validationState: row.validation_state,
    createdAt: row.created_at,
  };
}

function toPreviewProfile(row: PreviewProfileRow): DurablePreviewProfile {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    command: JSON.parse(row.command_json) as DurablePreviewProfile['command'],
    status: row.status,
    ...(row.authentication_required === 1 ? { authenticationRequired: true } : {}),
    ...(row.validation_json
      ? { validation: JSON.parse(row.validation_json) as NonNullable<DurablePreviewProfile['validation']> }
      : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAuthenticatedPreviewSession(row: AuthenticatedPreviewSessionRow): DurableAuthenticatedPreviewSession {
  return {
    id: row.id, projectId: row.project_id, previewProfileId: row.preview_profile_id,
    installationId: row.installation_id, origin: row.origin, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.last_verified_at ? { lastVerifiedAt: row.last_verified_at } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    revision: row.revision,
  };
}

function toPreviewSession(row: PreviewSessionRow): DurablePreviewSession {
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    installationId: row.installation_id,
    profileId: row.profile_id,
    workspaceKind: row.workspace_kind,
    workspacePath: row.workspace_path,
    revisionCommit: row.revision_commit,
    sourceStateHash: row.source_state_hash,
    origin: row.origin,
    route: row.route,
    port: row.port,
    ...(row.pid ? { pid: row.pid } : {}),
    state: row.state,
    logs: row.logs,
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBrowserEvidence(row: BrowserEvidenceRow): DurableBrowserEvidence {
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    previewProfileId: row.preview_profile_id,
    previewSessionId: row.preview_session_id,
    revisionCommit: row.revision_commit,
    sourceStateHash: row.source_state_hash,
    origin: row.origin,
    route: row.route,
    viewport: JSON.parse(row.viewport_json) as DurableBrowserEvidence['viewport'],
    capturedAt: row.captured_at,
    title: row.title,
    finalUrl: row.final_url,
    screenshotInputId: row.screenshot_input_id,
    screenshotSha256: row.screenshot_sha256,
    screenshotByteSize: row.screenshot_byte_size,
    screenshotWidth: row.screenshot_width,
    screenshotHeight: row.screenshot_height,
    visibleText: row.visible_text,
    consoleFailures: jsonArray<string>(row.console_failures_json, 'browser console failures'),
    failedResources: jsonArray<string>(row.failed_resources_json, 'browser failed resources'),
    audit: jsonArray(row.audit_json, 'browser audit'),
    version: row.version,
    evidenceHash: row.evidence_hash,
  };
}

function toRepository(row: RepositoryRow): DurableRepository {
  return {
    id: row.id,
    identityKind: row.identity_kind,
    name: row.name,
    ...(row.canonical_remote ? { canonicalRemote: row.canonical_remote } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCheckout(row: CheckoutRow): RepositoryCheckoutBinding {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    installationId: row.installation_id,
    canonicalPath: row.canonical_path,
    availability: row.availability,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toRepositoryObservation(row: RepositoryObservationRow): DurableRepositoryObservation {
  return {
    repositoryId: row.repository_id,
    checkoutBindingId: row.checkout_binding_id,
    availability: row.availability,
    ...(row.branch ? { branch: row.branch } : {}),
    detachedHead: row.detached_head === 1,
    ...(row.head_commit ? { headCommit: row.head_commit } : {}),
    workingTree: row.working_tree,
    ...(row.reason ? { reason: row.reason } : {}),
    observedAt: row.observed_at,
  };
}

function toRuntimeObservation(row: RuntimeObservationRow): DurableRuntimeObservation {
  return {
    projectId: row.project_id,
    agentId: row.agent_id,
    associationState: row.association_state,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.runtime_state ? { runtimeState: row.runtime_state } : {}),
    ...(row.enabled_known === 1
      ? { enabled: row.enabled === null ? null : row.enabled === 1 }
      : {}),
    ...(row.configured_known === 1 ? { configured: row.configured === 1 } : {}),
    ...(row.last_heartbeat ? { lastHeartbeat: row.last_heartbeat } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    observedAt: row.observed_at,
  };
}

function toJob(row: JobRow): DurableJob {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    ...(row.acceptance_criteria ? { acceptanceCriteria: row.acceptance_criteria } : {}),
    ...(row.automatic_read_only_completion === 1
      ? { automaticReadOnlyCompletion: true }
      : {}),
    ...(row.execution_mode === 'repository-write-isolated'
      ? { executionMode: row.execution_mode }
      : {}),
    status: row.status,
    ...(row.repository_id ? { repositoryId: row.repository_id } : {}),
    ...(row.preferred_runtime_agent_id
      ? { preferredRuntimeAgentId: row.preferred_runtime_agent_id }
      : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row: AttemptRow): DurableJobAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    sequence: row.sequence,
    executionRole: row.execution_role ?? 'worker',
    roleSequence: row.role_sequence ?? row.sequence,
    ...(row.runtime_agent_id ? { runtimeAgentId: row.runtime_agent_id } : {}),
    status: row.status,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toExecutionPlan(row: ExecutionPlanRow, inputIds: readonly string[] = []): DurableExecutionPlan {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    jobId: row.job_id,
    projectId: row.project_id,
    installationId: row.installation_id,
    runtimeAgentId: row.runtime_agent_id,
    ...(row.repository_id ? { repositoryId: row.repository_id } : {}),
    ...(row.checkout_binding_id ? { checkoutBindingId: row.checkout_binding_id } : {}),
    ...(row.repository_workspace_id
      ? { repositoryWorkspaceId: row.repository_workspace_id }
      : {}),
    ...(inputIds.length ? { inputIds } : {}),
    input: { version: row.input_version, instruction: row.instruction },
    ...(row.requested_policy_version && row.requested_filesystem
      && row.requested_network && row.requested_environment
      ? {
          requestedPolicy: {
            version: row.requested_policy_version,
            filesystem: row.requested_filesystem,
            network: row.requested_network,
            environment: row.requested_environment,
          },
        }
      : {}),
    ...(row.requested_capabilities_version && row.requested_repository_read !== null
      && row.requested_repository_read !== undefined
      ? {
          requestedCapabilities: {
            version: row.requested_capabilities_version,
            repositoryRead: row.requested_repository_read === 1,
            ...(row.requested_repository_patch === 1 ? { repositoryPatch: true } : {}),
            ...(row.requested_test_run === 1 ? { testRun: true } : {}),
            ...(row.requested_git_inspect === 1 ? { gitInspect: true } : {}),
            ...(row.requested_input_read === 1 ? { inputRead: true } : {}),
          },
        }
      : {}),
    jobRevisionAtPreparation: row.job_revision,
    attemptRevisionAtPreparation: row.attempt_revision,
    createdAt: row.created_at,
  };
}

function toExecutionDispatch(row: ExecutionDispatchRow): DurableExecutionDispatch {
  return {
    id: row.id,
    executionPlanId: row.execution_plan_id,
    attemptId: row.attempt_id,
    jobId: row.job_id,
    runtimeAgentId: row.runtime_agent_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    ...(row.effective_policy_version && row.effective_filesystem
      && row.effective_network && row.effective_environment
      ? {
          effectivePolicy: {
            version: row.effective_policy_version,
            filesystem: row.effective_filesystem,
            network: row.effective_network,
            environment: row.effective_environment,
          },
        }
      : {}),
    ...(row.effective_capabilities_version && row.effective_repository_read !== null
      && row.effective_repository_read !== undefined
      ? {
          effectiveCapabilities: {
            version: row.effective_capabilities_version,
            repositoryRead: row.effective_repository_read === 1,
            ...(row.effective_repository_patch === 1 ? { repositoryPatch: true } : {}),
            ...(row.effective_test_run === 1 ? { testRun: true } : {}),
            ...(row.effective_git_inspect === 1 ? { gitInspect: true } : {}),
            ...(row.effective_input_read === 1 ? { inputRead: true } : {}),
          },
        }
      : {}),
    ...(row.external_reference ? { externalReference: row.external_reference } : {}),
    ...(row.message ? { message: row.message } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.submitted_at ? { submittedAt: row.submitted_at } : {}),
    ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}

function toExecutionObservation(row: ExecutionObservationRow): DurableExecutionObservation {
  return {
    id: row.id,
    dispatchId: row.dispatch_id,
    attemptId: row.attempt_id,
    source: row.source,
    sourceEventId: row.source_event_id,
    kind: row.kind,
    correlation: row.correlation,
    ...(row.correlated_dispatch_id ? { correlatedDispatchId: row.correlated_dispatch_id } : {}),
    ...(row.runtime_session_id ? { runtimeSessionId: row.runtime_session_id } : {}),
    ...(row.external_reference ? { externalReference: row.external_reference } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.output_summary ? { outputSummary: row.output_summary } : {}),
    ...(row.result_text ? { resultText: row.result_text } : {}),
    ...(row.execution_working_directory
      ? {
          executionContext: {
            workingDirectory: row.execution_working_directory,
            ...(row.repository_read_root ? { repositoryReadRoot: row.repository_read_root } : {}),
            ...(row.repository_write_root ? { repositoryWriteRoot: row.repository_write_root } : {}),
          },
        }
      : {}),
    ...(row.effective_policy_version && row.effective_filesystem
      && row.effective_network && row.effective_environment
      ? {
          effectivePolicy: {
            version: row.effective_policy_version,
            filesystem: row.effective_filesystem,
            network: row.effective_network,
            environment: row.effective_environment,
          },
        }
      : {}),
    ...(row.effective_capabilities_version && row.effective_repository_read !== null
      && row.effective_repository_read !== undefined
      ? {
          effectiveCapabilities: {
            version: row.effective_capabilities_version,
            repositoryRead: row.effective_repository_read === 1,
            ...(row.effective_repository_patch === 1 ? { repositoryPatch: true } : {}),
            ...(row.effective_test_run === 1 ? { testRun: true } : {}),
            ...(row.effective_git_inspect === 1 ? { gitInspect: true } : {}),
            ...(row.effective_input_read === 1 ? { inputRead: true } : {}),
          },
        }
      : {}),
    ...(row.tool_operations_json
      ? { toolOperations: JSON.parse(row.tool_operations_json) as RuntimeToolOperation[] }
      : {}),
    observedAt: row.observed_at,
    recordedAt: row.recorded_at,
  };
}

function toRepositoryWorkspace(row: RepositoryWorkspaceRow): DurableRepositoryWorkspace {
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    sourceCheckoutBindingId: row.source_checkout_binding_id,
    baseRevision: row.base_revision,
    ...(row.base_branch ? { baseBranch: row.base_branch } : {}),
    branchName: row.branch_name,
    canonicalPath: row.canonical_path,
    state: row.state,
    ...(row.evidence_json
      ? { evidence: JSON.parse(row.evidence_json) as DurableRepositoryWorkspace['evidence'] }
      : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toJobRetirement(row: JobRetirementRow): DurableJobRetirement {
  return {
    jobId: row.job_id,
    disposition: row.disposition,
    reason: row.reason,
    actor: row.actor,
    ...(row.evidence_reference ? { evidenceReference: row.evidence_reference } : {}),
    retiredAt: row.retired_at,
  };
}

function toRepositoryRestoreAction(row: RepositoryRestoreActionRow): DurableRepositoryRestoreAction {
  return {
    id: row.id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    checkoutBindingId: row.checkout_binding_id,
    state: row.state,
    preconditions: JSON.parse(row.preconditions_json) as DurableRepositoryRestoreAction['preconditions'],
    approvalSummary: row.approval_summary,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    ...(row.result_json
      ? { result: JSON.parse(row.result_json) as NonNullable<DurableRepositoryRestoreAction['result']> }
      : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    revision: row.revision,
  };
}

function toAttemptReview(row: AttemptReviewRow): DurableAttemptReview {
  return {
    id: row.id,
    jobId: row.job_id,
    workerAttemptId: row.worker_attempt_id,
    reviewerAttemptId: row.reviewer_attempt_id,
    reviewerRuntimeAgentId: row.reviewer_runtime_agent_id,
    decision: row.decision,
    summary: row.summary,
    ...(row.feedback ? { feedback: row.feedback } : {}),
    createdAt: row.created_at,
  };
}

function toEscalation(row: EscalationRow): DurableEscalation {
  return {
    id: row.id,
    jobId: row.job_id,
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    ...(row.review_id ? { reviewId: row.review_id } : {}),
    reason: row.reason,
    summary: row.summary,
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.resolution_summary ? { resolutionSummary: row.resolution_summary } : {}),
  };
}

function toAttemptOutcomeDecision(row: AttemptOutcomeDecisionRow): DurableAttemptOutcomeDecision {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    dispatchId: row.dispatch_id,
    outcome: row.outcome,
    source: row.source,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.evidence_observation_id ? { evidenceObservationId: row.evidence_observation_id } : {}),
    overrideWithoutExactCompletionEvidence: row.override_without_exact_evidence === 1,
    createdAt: row.created_at,
  };
}

function toOperatorRun(row: OperatorRunRow): DurableOperatorRun {
  return {
    id: row.id,
    jobId: row.job_id,
    status: row.status,
    ...(row.failure_message ? { failureMessage: row.failure_message } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function toHumanGuidance(row: HumanGuidanceRow): DurableHumanGuidance {
  return {
    id: row.id,
    jobId: row.job_id,
    escalationId: row.escalation_id,
    instruction: row.instruction,
    createdAt: row.created_at,
  };
}

function toWorkerBudgetExtension(row: WorkerBudgetExtensionRow): DurableWorkerBudgetExtension {
  return {
    id: row.id,
    jobId: row.job_id,
    escalationId: row.escalation_id,
    additionalWorkerExecutions: row.additional_worker_executions,
    createdAt: row.created_at,
  };
}

function toOperatorNotificationDelivery(
  row: OperatorNotificationDeliveryRow,
): DurableOperatorNotificationDelivery {
  return {
    id: row.id,
    eventKey: row.event_key,
    kind: row.kind,
    jobId: row.job_id,
    ...(row.escalation_id ? { escalationId: row.escalation_id } : {}),
    status: row.status,
    ...(row.message ? { message: row.message } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.attempted_at ? { attemptedAt: row.attempted_at } : {}),
  };
}

function isValidDispatchTransition(from: DispatchStatus, to: DispatchStatus): boolean {
  return from === 'prepared' && to === 'submitting'
    || from === 'submitting' && (to === 'accepted' || to === 'rejected' || to === 'uncertain');
}

function isValidOperatorRunTransition(from: OperatorRunStatus, to: OperatorRunStatus): boolean {
  return from === 'pending' && (to === 'running' || to === 'failed')
    || from === 'running' && (to === 'completed' || to === 'needs_human' || to === 'failed')
    || from === 'needs_human' && (to === 'pending' || to === 'cancelled');
}

function isValidRepositoryWorkspaceTransition(
  from: RepositoryWorkspaceState,
  to: RepositoryWorkspaceState,
): boolean {
  return from === 'preparing' && (to === 'active' || to === 'failed' || to === 'cancelled')
    || from === 'active' && (to === 'reviewing' || to === 'failed' || to === 'cancelled')
    || from === 'reviewing' && (to === 'active' || to === 'ready_for_approval' || to === 'failed' || to === 'cleanup_pending' || to === 'cancelled')
    || from === 'ready_for_approval' && (to === 'active' || to === 'failed' || to === 'cleanup_pending' || to === 'cancelled')
    || from === 'failed' && (to === 'cleanup_pending' || to === 'cancelled')
    || from === 'cancelled' && to === 'cleanup_pending'
    || from === 'cleanup_pending' && (to === 'cleaned' || to === 'failed');
}

function isValidPreviewSessionTransition(from: PreviewProcessState, to: PreviewProcessState): boolean {
  return from === 'starting' && (to === 'running' || to === 'failed')
    || from === 'running' && (to === 'stopped' || to === 'failed' || to === 'stale')
    || from === 'stale' && (to === 'starting' || to === 'stopped')
    || from === 'stopped' && to === 'starting'
    || from === 'failed' && to === 'starting';
}

function validAuthenticatedPreviewTransition(
  from: AuthenticatedPreviewSessionStatus,
  to: AuthenticatedPreviewSessionStatus,
): boolean {
  return from === 'pending-human-login' && (to === 'ready' || to === 'expired' || to === 'revoked')
    || from === 'ready' && (to === 'expired' || to === 'revoked')
    || from === 'expired' && to === 'revoked';
}

function validateBrowserRequirement(requirement: BrowserEvidenceRequirement): void {
  if (requirement.kind !== 'browser-render' || !/^\/(?!\/)/.test(requirement.route)
    || requirement.route.includes('\0') || requirement.route.includes('://')
    || !Number.isInteger(requirement.viewport.width) || requirement.viewport.width < 320
    || requirement.viewport.width > 2_560 || !Number.isInteger(requirement.viewport.height)
    || requirement.viewport.height < 240 || requirement.viewport.height > 2_560) {
    throw new Error('Invalid browser render evidence requirement');
  }
}

export class SqliteAgentOperationsStateStore implements AgentOperationsStateStore {
  readonly databasePath: string;
  private readonly database: Database.Database;
  private closed = false;
  private readonly supportsRuntimePolicies: boolean;
  private readonly supportsExecutionContextEvidence: boolean;
  private readonly supportsExecutionCapabilities: boolean;
  private readonly supportsOrchestration: boolean;
  private readonly supportsDailyOperator: boolean;
  private readonly supportsLateExecutionReconciliation: boolean;
  private readonly supportsIsolatedWriteWorkspaces: boolean;
  private readonly supportsProjectInputs: boolean;
  private readonly supportsWorkerBudgetExtensions: boolean;
  private readonly supportsPreviewBrowserEvidence: boolean;
  private readonly supportsDailyDriverTrust: boolean;
  private readonly supportsAuthenticatedPreview: boolean;
  private readonly supportsJobRetirementAndRestore: boolean;

  private constructor(databasePath: string, database: Database.Database) {
    this.databasePath = databasePath;
    this.database = database;
    this.supportsRuntimePolicies = (database.prepare(
      "SELECT 1 FROM pragma_table_info('execution_plans') WHERE name = 'requested_policy_version'",
    ).get() as unknown) !== undefined;
    this.supportsExecutionContextEvidence = (database.prepare(
      "SELECT 1 FROM pragma_table_info('execution_observations') WHERE name = 'execution_working_directory'",
    ).get() as unknown) !== undefined;
    this.supportsExecutionCapabilities = (database.prepare(
      "SELECT 1 FROM pragma_table_info('execution_plans') WHERE name = 'requested_capabilities_version'",
    ).get() as unknown) !== undefined;
    this.supportsOrchestration = (database.prepare(
      "SELECT 1 FROM pragma_table_info('jobs') WHERE name = 'acceptance_criteria'",
    ).get() as unknown) !== undefined;
    this.supportsDailyOperator = (database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operator_runs'",
    ).get() as unknown) !== undefined;
    this.supportsLateExecutionReconciliation = (database.prepare(
      "SELECT 1 FROM pragma_table_info('escalations') WHERE name = 'resolution_summary'",
    ).get() as unknown) !== undefined;
    this.supportsIsolatedWriteWorkspaces = (database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'repository_workspaces'",
    ).get() as unknown) !== undefined;
    this.supportsProjectInputs = (database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inputs'",
    ).get() as unknown) !== undefined;
    this.supportsWorkerBudgetExtensions = (database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker_budget_extensions'",
    ).get() as unknown) !== undefined;
    this.supportsPreviewBrowserEvidence = (database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'browser_evidence'",
    ).get() as unknown) !== undefined;
    this.supportsDailyDriverTrust = (database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trust_profiles'",
    ).get() as unknown) !== undefined;
    this.supportsAuthenticatedPreview = (database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authenticated_preview_sessions'",
    ).get() as unknown) !== undefined;
    this.supportsJobRetirementAndRestore = (database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_retirements'",
    ).get() as unknown) !== undefined;
  }

  static open(options: SqliteAgentOperationsStateStoreOptions = {}): SqliteAgentOperationsStateStore {
    const now = options.now ?? (() => new Date());
    const databasePath = resolve(options.databasePath ?? resolveAgentOperationsStateLocation().databasePath);
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    let database: Database.Database | undefined;
    try {
      database = new Database(databasePath, { timeout: 5_000 });
      database.pragma('busy_timeout = 5000');
      database.pragma('foreign_keys = ON');
      applyStateMigrations(
        database,
        options.additionalMigrations,
        now,
        options.targetSchemaVersion,
      );
      const installation = database.prepare('SELECT id FROM installations LIMIT 1').get() as { id: string } | undefined;
      if (!installation) {
        const id = options.installationIdFactory?.() ?? `installation:${randomUUID()}`;
        requireNonEmpty(id, 'Installation ID');
        database.prepare('INSERT INTO installations (id, created_at, label) VALUES (?, ?, ?)')
          .run(id, now().toISOString(), options.installationLabel ?? null);
      }
      chmodSync(databasePath, 0o600);
      return new SqliteAgentOperationsStateStore(databasePath, database);
    } catch (error) {
      database?.close();
      throw new Error(`Could not open Agent Operations state at ${databasePath}: ${(error as Error).message}`);
    }
  }

  async getInstallation(): Promise<AgentOperationsInstallation> {
    this.assertOpen();
    const row = this.database.prepare('SELECT id, created_at, label FROM installations LIMIT 1')
      .get() as { id: string; created_at: string; label: string | null } | undefined;
    if (!row) throw new Error('Agent Operations state has no installation identity');
    return {
      id: row.id,
      createdAt: row.created_at,
      ...(row.label ? { label: row.label } : {}),
    };
  }

  async applyProjectConfiguration(configuration: DurableProjectConfiguration): Promise<void> {
    this.assertOpen();
    this.validateConfiguration(configuration);
    const apply = this.database.transaction(() => {
      const { project, repositories, checkoutBindings, runtimeAgentIds } = configuration;
      if (this.supportsProjectInputs) {
        this.database.prepare(`
          INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, description = excluded.description, updated_at = excluded.updated_at
        `).run(project.id, project.name, project.description ?? null, project.createdAt, project.updatedAt);
      } else {
        this.database.prepare(`
          INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
        `).run(project.id, project.name, project.createdAt, project.updatedAt);
      }

      for (const repository of repositories) {
        const existing = this.database.prepare(
          'SELECT identity_kind, canonical_remote FROM repositories WHERE id = ?',
        ).get(repository.id) as { identity_kind: RepositoryIdentityKind; canonical_remote: string | null } | undefined;
        if (existing && (existing.identity_kind !== repository.identityKind
          || existing.canonical_remote !== (repository.canonicalRemote ?? null))) {
          throw new Error(`Repository identity conflict for ${repository.id}`);
        }
        this.database.prepare(`
          INSERT INTO repositories
            (id, identity_kind, name, canonical_remote, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
        `).run(
          repository.id,
          repository.identityKind,
          repository.name,
          repository.canonicalRemote ?? null,
          repository.createdAt,
          repository.updatedAt,
        );
      }

      for (const binding of checkoutBindings) {
        const pathConflict = this.database.prepare(`
          SELECT repository_id FROM repository_checkouts
          WHERE installation_id = ? AND canonical_path = ? AND repository_id <> ?
        `).get(binding.installationId, binding.canonicalPath, binding.repositoryId) as
          { repository_id: string } | undefined;
        if (pathConflict) {
          throw new Error(
            `Checkout path identity conflict: ${binding.canonicalPath} is already bound to ${pathConflict.repository_id}`,
          );
        }
        const idConflict = this.database.prepare(`
          SELECT repository_id, installation_id, canonical_path FROM repository_checkouts WHERE id = ?
        `).get(binding.id) as Pick<CheckoutRow, 'repository_id' | 'installation_id' | 'canonical_path'> | undefined;
        if (idConflict && (idConflict.repository_id !== binding.repositoryId
          || idConflict.installation_id !== binding.installationId
          || idConflict.canonical_path !== binding.canonicalPath)) {
          throw new Error(`Checkout binding identity conflict for ${binding.id}`);
        }
        this.database.prepare(`
          INSERT INTO repository_checkouts
            (id, repository_id, installation_id, canonical_path, availability, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            availability = excluded.availability,
            last_seen_at = excluded.last_seen_at
        `).run(
          binding.id,
          binding.repositoryId,
          binding.installationId,
          binding.canonicalPath,
          binding.availability,
          binding.firstSeenAt,
          binding.lastSeenAt,
        );
      }

      this.database.prepare('DELETE FROM project_repositories WHERE project_id = ?').run(project.id);
      const insertRepositoryAssociation = this.database.prepare(
        'INSERT INTO project_repositories (project_id, repository_id) VALUES (?, ?)',
      );
      for (const repository of repositories) insertRepositoryAssociation.run(project.id, repository.id);

      this.database.prepare('DELETE FROM project_runtime_agents WHERE project_id = ?').run(project.id);
      const insertRuntimeAssociation = this.database.prepare(
        'INSERT INTO project_runtime_agents (project_id, agent_id) VALUES (?, ?)',
      );
      for (const agentId of runtimeAgentIds) insertRuntimeAssociation.run(project.id, agentId);
    });
    apply();
  }

  async getProject(id: string): Promise<DurableProject | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  async listProjects(): Promise<readonly DurableProject[]> {
    this.assertOpen();
    return (this.database.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[]).map(toProject);
  }

  async getRepository(id: string): Promise<DurableRepository | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM repositories WHERE id = ?')
      .get(id) as RepositoryRow | undefined;
    return row ? toRepository(row) : null;
  }

  async listRepositories(): Promise<readonly DurableRepository[]> {
    this.assertOpen();
    return (this.database.prepare('SELECT * FROM repositories ORDER BY id').all() as RepositoryRow[])
      .map(toRepository);
  }

  async listCheckoutBindings(repositoryId?: string): Promise<readonly RepositoryCheckoutBinding[]> {
    this.assertOpen();
    const rows = repositoryId
      ? this.database.prepare('SELECT * FROM repository_checkouts WHERE repository_id = ? ORDER BY id').all(repositoryId)
      : this.database.prepare('SELECT * FROM repository_checkouts ORDER BY id').all();
    return (rows as CheckoutRow[]).map(toCheckout);
  }

  async listProjectRepositoryIds(projectId: string): Promise<readonly string[]> {
    this.assertOpen();
    return (this.database.prepare(
      'SELECT repository_id FROM project_repositories WHERE project_id = ? ORDER BY repository_id',
    ).all(projectId) as Array<{ repository_id: string }>).map(row => row.repository_id);
  }

  async listProjectRuntimeAgentIds(projectId: string): Promise<readonly string[]> {
    this.assertOpen();
    return (this.database.prepare(
      'SELECT agent_id FROM project_runtime_agents WHERE project_id = ? ORDER BY agent_id',
    ).all(projectId) as Array<{ agent_id: string }>).map(row => row.agent_id);
  }

  async createLocalFolderResource(resource: DurableLocalFolderResource): Promise<void> {
    this.assertOpen();
    if (!this.supportsProjectInputs) throw new Error('Project Resources require Agent Operations schema v13');
    requireNonEmpty(resource.id, 'Project Resource ID');
    requireNonEmpty(resource.canonicalPath, 'Project Resource canonical path');
    requireNonEmpty(resource.fingerprint, 'Project Resource fingerprint');
    const installation = await this.getInstallation();
    if (resource.installationId !== installation.id) throw new Error('Project Resource belongs to another installation');
    if (!await this.getProject(resource.projectId)) throw new Error(`Project not found: ${resource.projectId}`);
    try {
      this.database.prepare(`
        INSERT INTO project_local_folders
          (id, project_id, installation_id, canonical_path, fingerprint, availability, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resource.id, resource.projectId, resource.installationId, resource.canonicalPath,
        resource.fingerprint, resource.availability, resource.firstSeenAt, resource.lastSeenAt,
      );
    } catch (error) {
      throw new Error(`Could not create local folder resource: ${(error as Error).message}`);
    }
  }

  async listLocalFolderResources(projectId?: string): Promise<readonly DurableLocalFolderResource[]> {
    this.assertOpen();
    if (!this.supportsProjectInputs) return [];
    const rows = projectId
      ? this.database.prepare('SELECT * FROM project_local_folders WHERE project_id = ? ORDER BY id').all(projectId)
      : this.database.prepare('SELECT * FROM project_local_folders ORDER BY id').all();
    return (rows as LocalFolderRow[]).map(toLocalFolder);
  }

  async saveProjectProfile(profile: DurableProjectProfile): Promise<void> {
    this.assertOpen();
    if (!this.supportsProjectInputs) throw new Error('Project Profiles require Agent Operations schema v13');
    if (!await this.getProject(profile.projectId)) throw new Error(`Project not found: ${profile.projectId}`);
    const existing = this.database.prepare('SELECT revision FROM project_profiles WHERE project_id = ?')
      .get(profile.projectId) as { revision: number } | undefined;
    if (profile.revision !== (existing ? existing.revision + 1 : 0)) {
      throw new Error(`Stale Project Profile revision for ${profile.projectId}`);
    }
    this.database.prepare(`
      INSERT INTO project_profiles (
        project_id, resource_summary, detected_stack_json, package_manager,
        build_commands_json, test_commands_json, preview_commands_json,
        deployment_clues_json, documentation_json, capabilities_json,
        warnings_json, known_constraints_json, agents_file_suggestion, inspected_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        resource_summary=excluded.resource_summary, detected_stack_json=excluded.detected_stack_json,
        package_manager=excluded.package_manager, build_commands_json=excluded.build_commands_json,
        test_commands_json=excluded.test_commands_json, preview_commands_json=excluded.preview_commands_json,
        deployment_clues_json=excluded.deployment_clues_json, documentation_json=excluded.documentation_json,
        capabilities_json=excluded.capabilities_json, warnings_json=excluded.warnings_json,
        known_constraints_json=excluded.known_constraints_json,
        agents_file_suggestion=excluded.agents_file_suggestion, inspected_at=excluded.inspected_at,
        revision=excluded.revision
    `).run(
      profile.projectId, profile.resourceSummary, JSON.stringify(profile.detectedStack),
      profile.packageManager ?? null, JSON.stringify(profile.buildCommandCandidates),
      JSON.stringify(profile.testCommandCandidates), JSON.stringify(profile.previewCommandCandidates),
      JSON.stringify(profile.deploymentClues), JSON.stringify(profile.documentation),
      JSON.stringify(profile.capabilities), JSON.stringify(profile.warnings),
      JSON.stringify(profile.knownConstraints), profile.agentsFileSuggestion ? 1 : 0,
      profile.inspectedAt, profile.revision,
    );
  }

  async getProjectProfile(projectId: string): Promise<DurableProjectProfile | null> {
    this.assertOpen();
    if (!this.supportsProjectInputs) return null;
    const row = this.database.prepare('SELECT * FROM project_profiles WHERE project_id = ?')
      .get(projectId) as ProjectProfileRow | undefined;
    return row ? toProjectProfile(row) : null;
  }

  async saveTrustProfile(profile: DurableTrustProfile): Promise<void> {
    this.assertOpen();
    if (!this.supportsDailyDriverTrust) throw new Error('Trust Profiles require Agent Operations schema v16');
    validateTrustProfile(profile);
    if (profile.scope === 'project' && !await this.getProject(profile.scopeId!)) {
      throw new Error(`Project not found: ${profile.scopeId}`);
    }
    if (profile.scope === 'job' && !await this.getJob(profile.scopeId!)) {
      throw new Error(`Job not found: ${profile.scopeId}`);
    }
    const existing = this.database.prepare('SELECT * FROM trust_profiles WHERE id = ?')
      .get(profile.id) as TrustProfileRow | undefined;
    if (profile.revision !== (existing ? existing.revision + 1 : 0)
      || (existing && (existing.scope !== profile.scope
        || (existing.scope_id ?? undefined) !== profile.scopeId
        || existing.created_at !== profile.createdAt))) {
      throw new Error(`Stale or rewritten Trust Profile: ${profile.id}`);
    }
    this.database.prepare(`
      INSERT INTO trust_profiles
        (id, scope, scope_id, name, preset, policy_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, preset=excluded.preset,
        policy_json=excluded.policy_json, revision=excluded.revision, updated_at=excluded.updated_at
    `).run(
      profile.id, profile.scope, profile.scopeId ?? null, profile.name, profile.preset,
      JSON.stringify(profile.policy), profile.revision, profile.createdAt, profile.updatedAt,
    );
  }

  async getTrustProfile(id: string): Promise<DurableTrustProfile | null> {
    this.assertOpen();
    if (!this.supportsDailyDriverTrust) return null;
    const row = this.database.prepare('SELECT * FROM trust_profiles WHERE id = ?')
      .get(id) as TrustProfileRow | undefined;
    return row ? toTrustProfile(row) : null;
  }

  async listTrustProfiles(): Promise<readonly DurableTrustProfile[]> {
    this.assertOpen();
    if (!this.supportsDailyDriverTrust) return [];
    return (this.database.prepare(
      'SELECT * FROM trust_profiles ORDER BY scope, COALESCE(scope_id, \'\'), id',
    ).all() as TrustProfileRow[]).map(toTrustProfile);
  }

  async savePreviewProfile(profile: DurablePreviewProfile): Promise<void> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) throw new Error('Preview Profiles require Agent Operations schema v15');
    if (!profile.id.startsWith('preview-profile:') || !profile.name.trim()) {
      throw new Error(`Invalid Preview Profile: ${profile.id}`);
    }
    const existing = this.database.prepare('SELECT * FROM preview_profiles WHERE id = ?')
      .get(profile.id) as PreviewProfileRow | undefined;
    if (profile.revision !== (existing ? existing.revision + 1 : 0)
      || (existing && (existing.project_id !== profile.projectId || existing.name !== profile.name
        || existing.created_at !== profile.createdAt))) {
      throw new Error(`Stale or rewritten Preview Profile: ${profile.id}`);
    }
    if (this.supportsAuthenticatedPreview) {
      this.database.prepare(`
        INSERT INTO preview_profiles
          (id, project_id, name, command_json, status, validation_json, revision, created_at, updated_at, authentication_required)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET command_json=excluded.command_json, status=excluded.status,
          validation_json=excluded.validation_json, revision=excluded.revision, updated_at=excluded.updated_at,
          authentication_required=excluded.authentication_required
      `).run(
        profile.id, profile.projectId, profile.name, JSON.stringify(profile.command), profile.status,
        profile.validation ? JSON.stringify(profile.validation) : null, profile.revision,
        profile.createdAt, profile.updatedAt, profile.authenticationRequired ? 1 : 0,
      );
    } else {
      this.database.prepare(`
        INSERT INTO preview_profiles
          (id, project_id, name, command_json, status, validation_json, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET command_json=excluded.command_json, status=excluded.status,
          validation_json=excluded.validation_json, revision=excluded.revision, updated_at=excluded.updated_at
      `).run(
        profile.id, profile.projectId, profile.name, JSON.stringify(profile.command), profile.status,
        profile.validation ? JSON.stringify(profile.validation) : null, profile.revision,
        profile.createdAt, profile.updatedAt,
      );
    }
  }

  async getPreviewProfile(id: string): Promise<DurablePreviewProfile | null> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) return null;
    const row = this.database.prepare('SELECT * FROM preview_profiles WHERE id = ?')
      .get(id) as PreviewProfileRow | undefined;
    return row ? toPreviewProfile(row) : null;
  }

  async listPreviewProfiles(projectId?: string): Promise<readonly DurablePreviewProfile[]> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) return [];
    const rows = projectId
      ? this.database.prepare('SELECT * FROM preview_profiles WHERE project_id = ? ORDER BY name, id').all(projectId)
      : this.database.prepare('SELECT * FROM preview_profiles ORDER BY project_id, name, id').all();
    return (rows as PreviewProfileRow[]).map(toPreviewProfile);
  }

  async createAuthenticatedPreviewSession(session: DurableAuthenticatedPreviewSession): Promise<void> {
    this.assertOpen();
    if (!this.supportsAuthenticatedPreview) throw new Error('Authenticated Preview Sessions require Agent Operations schema v17');
    const profile = await this.getPreviewProfile(session.previewProfileId);
    if (!session.id.startsWith('preview-auth:') || session.status !== 'pending-human-login'
      || session.revision !== 0 || !profile || profile.projectId !== session.projectId
      || !profile.authenticationRequired) throw new Error(`Invalid Authenticated Preview Session: ${session.id}`);
    this.database.prepare(`
      INSERT INTO authenticated_preview_sessions
        (id, project_id, preview_profile_id, installation_id, origin, status, created_at,
         updated_at, last_verified_at, expires_at, revoked_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.projectId, session.previewProfileId, session.installationId,
      session.origin, session.status, session.createdAt, session.updatedAt,
      session.lastVerifiedAt ?? null, session.expiresAt ?? null, session.revokedAt ?? null, session.revision,
    );
  }

  async getAuthenticatedPreviewSession(id: string): Promise<DurableAuthenticatedPreviewSession | null> {
    this.assertOpen();
    if (!this.supportsAuthenticatedPreview) return null;
    const row = this.database.prepare('SELECT * FROM authenticated_preview_sessions WHERE id = ?')
      .get(id) as AuthenticatedPreviewSessionRow | undefined;
    return row ? toAuthenticatedPreviewSession(row) : null;
  }

  async listAuthenticatedPreviewSessions(projectId?: string): Promise<readonly DurableAuthenticatedPreviewSession[]> {
    this.assertOpen();
    if (!this.supportsAuthenticatedPreview) return [];
    const rows = projectId
      ? this.database.prepare('SELECT * FROM authenticated_preview_sessions WHERE project_id = ? ORDER BY created_at, id').all(projectId)
      : this.database.prepare('SELECT * FROM authenticated_preview_sessions ORDER BY created_at, id').all();
    return (rows as AuthenticatedPreviewSessionRow[]).map(toAuthenticatedPreviewSession);
  }

  async saveAuthenticatedPreviewSessionTransition(
    session: DurableAuthenticatedPreviewSession,
    expectedRevision: number,
  ): Promise<void> {
    this.assertOpen();
    if (!this.supportsAuthenticatedPreview) throw new Error('Authenticated Preview Sessions require Agent Operations schema v17');
    const existing = await this.getAuthenticatedPreviewSession(session.id);
    if (!existing || existing.revision !== expectedRevision || session.revision !== expectedRevision + 1
      || existing.projectId !== session.projectId || existing.previewProfileId !== session.previewProfileId
      || existing.installationId !== session.installationId || existing.origin !== session.origin
      || existing.createdAt !== session.createdAt || !validAuthenticatedPreviewTransition(existing.status, session.status)) {
      throw new Error(`Invalid Authenticated Preview Session transition: ${session.id}`);
    }
    const result = this.database.prepare(`
      UPDATE authenticated_preview_sessions SET status=?, updated_at=?, last_verified_at=?,
        expires_at=?, revoked_at=?, revision=? WHERE id=? AND revision=?
    `).run(
      session.status, session.updatedAt, session.lastVerifiedAt ?? null, session.expiresAt ?? null,
      session.revokedAt ?? null, session.revision, session.id, expectedRevision,
    );
    if (result.changes !== 1) throw new Error(`Authenticated Preview Session transition conflict: ${session.id}`);
  }

  async createInput(input: DurableInput): Promise<void> {
    this.assertOpen();
    if (!this.supportsProjectInputs) throw new Error('Inputs require Agent Operations schema v13');
    if (!input.id.startsWith('input:')) throw new Error(`Invalid Input ID: ${input.id}`);
    requireNonEmpty(input.displayName, 'Input display name');
    if (!/^[a-f0-9]{64}$/.test(input.sha256) || input.byteSize < 0) throw new Error(`Invalid Input evidence: ${input.id}`);
    if (input.projectId && !await this.getProject(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    this.database.prepare(`
      INSERT INTO inputs (
        id, display_name, mime_type, byte_size, sha256, source_type, original_url,
        final_url, project_id, storage_reference, ingestion_state, validation_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.displayName, input.mimeType, input.byteSize, input.sha256,
      input.sourceType, input.originalUrl ?? null, input.finalUrl ?? null,
      input.projectId ?? null, input.storageReference, input.ingestionState,
      input.validationState, input.createdAt,
    );
  }

  async getInput(id: string): Promise<DurableInput | null> {
    this.assertOpen();
    if (!this.supportsProjectInputs) return null;
    const row = this.database.prepare('SELECT * FROM inputs WHERE id = ?').get(id) as InputRow | undefined;
    return row ? toInput(row) : null;
  }

  async listInputs(projectId?: string): Promise<readonly DurableInput[]> {
    this.assertOpen();
    if (!this.supportsProjectInputs) return [];
    const rows = projectId
      ? this.database.prepare('SELECT * FROM inputs WHERE project_id = ? ORDER BY created_at, id').all(projectId)
      : this.database.prepare('SELECT * FROM inputs ORDER BY created_at, id').all();
    return (rows as InputRow[]).map(toInput);
  }

  async associateInputsWithConversation(conversationId: string, inputIds: readonly string[]): Promise<void> {
    this.assertOpen();
    if (!this.supportsProjectInputs) throw new Error('Conversation Inputs require Agent Operations schema v13');
    requireNonEmpty(conversationId, 'Conversation ID');
    rejectDuplicates(inputIds, 'Input ID');
    const insert = this.database.prepare(
      'INSERT INTO conversation_inputs (conversation_id, input_id) VALUES (?, ?)',
    );
    const apply = this.database.transaction(() => {
      for (const inputId of inputIds) insert.run(conversationId, inputId);
    });
    apply();
  }

  async listConversationInputIds(conversationId: string): Promise<readonly string[]> {
    this.assertOpen();
    if (!this.supportsProjectInputs) return [];
    return (this.database.prepare(
      'SELECT input_id FROM conversation_inputs WHERE conversation_id = ? ORDER BY input_id',
    ).all(conversationId) as Array<{ input_id: string }>).map(row => row.input_id);
  }

  async attachInputsToJob(jobId: string, inputIds: readonly string[]): Promise<void> {
    this.assertOpen();
    if (!this.supportsProjectInputs) throw new Error('Job Inputs require Agent Operations schema v13');
    rejectDuplicates(inputIds, 'Input ID');
    const job = await this.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const insert = this.database.prepare('INSERT INTO job_inputs (job_id, input_id) VALUES (?, ?)');
    const apply = this.database.transaction(() => {
      for (const inputId of inputIds) {
        const input = this.database.prepare('SELECT project_id FROM inputs WHERE id = ?')
          .get(inputId) as { project_id: string | null } | undefined;
        if (!input) throw new Error(`Input not found: ${inputId}`);
        if (input.project_id && input.project_id !== job.projectId) {
          throw new Error(`Input ${inputId} belongs to another Project`);
        }
        insert.run(jobId, inputId);
      }
    });
    apply();
  }

  async listJobInputIds(jobId: string): Promise<readonly string[]> {
    this.assertOpen();
    if (!this.supportsProjectInputs) return [];
    return (this.database.prepare('SELECT input_id FROM job_inputs WHERE job_id = ? ORDER BY input_id')
      .all(jobId) as Array<{ input_id: string }>).map(row => row.input_id);
  }

  async setJobBrowserEvidenceRequirement(
    jobId: string,
    requirement: BrowserEvidenceRequirement,
  ): Promise<void> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) throw new Error('Browser evidence requires Agent Operations schema v15');
    if (!await this.getJob(jobId)) throw new Error(`Job not found: ${jobId}`);
    validateBrowserRequirement(requirement);
    this.database.prepare(`
      INSERT INTO job_browser_evidence_requirements
        (job_id, kind, route, viewport_width, viewport_height)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET kind=excluded.kind, route=excluded.route,
        viewport_width=excluded.viewport_width, viewport_height=excluded.viewport_height
    `).run(jobId, requirement.kind, requirement.route, requirement.viewport.width, requirement.viewport.height);
  }

  async getJobBrowserEvidenceRequirement(jobId: string): Promise<BrowserEvidenceRequirement | null> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) return null;
    const row = this.database.prepare(`
      SELECT kind, route, viewport_width, viewport_height
      FROM job_browser_evidence_requirements WHERE job_id = ?
    `).get(jobId) as {
      kind: 'browser-render'; route: string; viewport_width: number; viewport_height: number;
    } | undefined;
    return row ? {
      kind: row.kind,
      route: row.route,
      viewport: { width: row.viewport_width, height: row.viewport_height },
    } : null;
  }

  async createPreviewSession(session: DurablePreviewSession): Promise<void> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) throw new Error('Preview Sessions require Agent Operations schema v15');
    if (!session.id.startsWith('preview-session:') || session.revision !== 0 || session.state !== 'starting'
      || session.pid !== undefined || session.failureReason !== undefined) {
      throw new Error(`Invalid new Preview Session: ${session.id}`);
    }
    this.database.prepare(`
      INSERT INTO preview_sessions
        (id, job_id, project_id, repository_id, installation_id, profile_id, workspace_kind,
        workspace_path, revision_commit, source_state_hash, origin, route, port, pid, state, logs, failure_reason,
         revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.jobId, session.projectId, session.repositoryId, session.installationId,
      session.profileId, session.workspaceKind, session.workspacePath, session.revisionCommit,
      session.sourceStateHash, session.origin, session.route, session.port, null, session.state, session.logs, null,
      session.revision, session.createdAt, session.updatedAt,
    );
  }

  async getPreviewSession(id: string): Promise<DurablePreviewSession | null> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) return null;
    const row = this.database.prepare('SELECT * FROM preview_sessions WHERE id = ?')
      .get(id) as PreviewSessionRow | undefined;
    return row ? toPreviewSession(row) : null;
  }

  async getPreviewSessionForJob(jobId: string): Promise<DurablePreviewSession | null> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) return null;
    const row = this.database.prepare('SELECT * FROM preview_sessions WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(jobId) as PreviewSessionRow | undefined;
    return row ? toPreviewSession(row) : null;
  }

  async savePreviewSessionTransition(session: DurablePreviewSession, expectedRevision: number): Promise<void> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) throw new Error('Preview Sessions require Agent Operations schema v15');
    const existing = await this.getPreviewSession(session.id);
    if (!existing || existing.revision !== expectedRevision || session.revision !== expectedRevision + 1
      || existing.jobId !== session.jobId || existing.projectId !== session.projectId
      || existing.repositoryId !== session.repositoryId || existing.installationId !== session.installationId
      || existing.profileId !== session.profileId || existing.workspaceKind !== session.workspaceKind
      || existing.workspacePath !== session.workspacePath || existing.revisionCommit !== session.revisionCommit
      || existing.sourceStateHash !== session.sourceStateHash
      || existing.origin !== session.origin || existing.route !== session.route || existing.port !== session.port
      || existing.createdAt !== session.createdAt || !isValidPreviewSessionTransition(existing.state, session.state)
      || ((session.state === 'failed') !== Boolean(session.failureReason))) {
      throw new Error(`Invalid Preview Session transition: ${session.id}`);
    }
    const updated = this.database.prepare(`
      UPDATE preview_sessions SET pid=?, state=?, logs=?, failure_reason=?, revision=?, updated_at=?
      WHERE id=? AND revision=?
    `).run(
      session.pid ?? null, session.state, session.logs, session.failureReason ?? null,
      session.revision, session.updatedAt, session.id, expectedRevision,
    );
    if (updated.changes !== 1) throw new Error(`Preview Session transition conflict: ${session.id}`);
  }

  async createBrowserEvidence(evidence: DurableBrowserEvidence): Promise<void> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) throw new Error('Browser Evidence requires Agent Operations schema v15');
    if (!evidence.id.startsWith('browser-evidence:') || evidence.version !== 1
      || !/^[a-f0-9]{64}$/.test(evidence.evidenceHash)
      || !/^[a-f0-9]{64}$/.test(evidence.screenshotSha256)) {
      throw new Error(`Invalid Browser Evidence: ${evidence.id}`);
    }
    this.database.prepare(`
      INSERT INTO browser_evidence
        (id, job_id, project_id, repository_id, preview_profile_id, preview_session_id,
         revision_commit, source_state_hash, origin, route, viewport_json, captured_at, title, final_url,
         screenshot_input_id, screenshot_sha256, screenshot_byte_size, screenshot_width,
         screenshot_height, visible_text, console_failures_json, failed_resources_json,
         audit_json, version, evidence_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidence.id, evidence.jobId, evidence.projectId, evidence.repositoryId,
      evidence.previewProfileId, evidence.previewSessionId, evidence.revisionCommit,
      evidence.sourceStateHash, evidence.origin, evidence.route, JSON.stringify(evidence.viewport), evidence.capturedAt,
      evidence.title, evidence.finalUrl, evidence.screenshotInputId, evidence.screenshotSha256,
      evidence.screenshotByteSize, evidence.screenshotWidth, evidence.screenshotHeight,
      evidence.visibleText, JSON.stringify(evidence.consoleFailures),
      JSON.stringify(evidence.failedResources), JSON.stringify(evidence.audit),
      evidence.version, evidence.evidenceHash,
    );
  }

  async getBrowserEvidence(id: string): Promise<DurableBrowserEvidence | null> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) return null;
    const row = this.database.prepare('SELECT * FROM browser_evidence WHERE id = ?')
      .get(id) as BrowserEvidenceRow | undefined;
    return row ? toBrowserEvidence(row) : null;
  }

  async listBrowserEvidenceForJob(jobId: string): Promise<readonly DurableBrowserEvidence[]> {
    this.assertOpen();
    if (!this.supportsPreviewBrowserEvidence) return [];
    return (this.database.prepare('SELECT * FROM browser_evidence WHERE job_id = ? ORDER BY captured_at, id')
      .all(jobId) as BrowserEvidenceRow[]).map(toBrowserEvidence);
  }

  async recordRepositoryObservation(observation: DurableRepositoryObservation): Promise<void> {
    this.assertOpen();
    try {
      this.database.prepare(`
        INSERT INTO repository_observations
          (repository_id, checkout_binding_id, availability, branch, detached_head,
           head_commit, working_tree, reason, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.repositoryId,
        observation.checkoutBindingId,
        observation.availability,
        observation.branch ?? null,
        observation.detachedHead ? 1 : 0,
        observation.headCommit ?? null,
        observation.workingTree,
        observation.reason ?? null,
        observation.observedAt,
      );
    } catch (error) {
      throw new Error(`Could not record repository observation: ${(error as Error).message}`);
    }
  }

  async getLatestRepositoryObservation(checkoutBindingId: string): Promise<DurableRepositoryObservation | null> {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT repository_id, checkout_binding_id, availability, branch, detached_head,
             head_commit, working_tree, reason, observed_at
      FROM repository_observations
      WHERE checkout_binding_id = ?
      ORDER BY observed_at DESC, sequence DESC LIMIT 1
    `).get(checkoutBindingId) as RepositoryObservationRow | undefined;
    return row ? toRepositoryObservation(row) : null;
  }

  async recordRuntimeObservation(observation: DurableRuntimeObservation): Promise<void> {
    this.assertOpen();
    try {
      const association = this.database.prepare(`
        SELECT 1 FROM project_runtime_agents WHERE project_id = ? AND agent_id = ?
      `).get(observation.projectId, observation.agentId);
      if (!association) {
        throw new Error(`Unknown project runtime association: ${observation.projectId}/${observation.agentId}`);
      }
      this.database.prepare(`
        INSERT INTO runtime_observations
          (project_id, agent_id, association_state, provider, runtime_state,
           enabled_known, enabled, configured_known, configured, last_heartbeat, reason, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.projectId,
        observation.agentId,
        observation.associationState,
        observation.provider ?? null,
        observation.runtimeState ?? null,
        Object.hasOwn(observation, 'enabled') ? 1 : 0,
        observation.enabled === undefined || observation.enabled === null
          ? null
          : observation.enabled ? 1 : 0,
        Object.hasOwn(observation, 'configured') ? 1 : 0,
        observation.configured === undefined ? null : observation.configured ? 1 : 0,
        observation.lastHeartbeat ?? null,
        observation.reason ?? null,
        observation.observedAt,
      );
    } catch (error) {
      throw new Error(`Could not record runtime observation: ${(error as Error).message}`);
    }
  }

  async getLatestRuntimeObservation(projectId: string, agentId: string): Promise<DurableRuntimeObservation | null> {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT project_id, agent_id, association_state, provider, runtime_state,
             enabled_known, enabled, configured_known, configured, last_heartbeat, reason, observed_at
      FROM runtime_observations
      WHERE project_id = ? AND agent_id = ?
      ORDER BY observed_at DESC, sequence DESC LIMIT 1
    `).get(projectId, agentId) as RuntimeObservationRow | undefined;
    return row ? toRuntimeObservation(row) : null;
  }

  async createRepositoryWorkspace(workspace: DurableRepositoryWorkspace): Promise<void> {
    this.assertOpen();
    if (!this.supportsIsolatedWriteWorkspaces) {
      throw new Error('Repository Workspaces require Agent Operations schema v12');
    }
    if (!workspace.id.startsWith('workspace:') || workspace.state !== 'preparing'
      || workspace.revision !== 0 || workspace.evidence || workspace.failureReason) {
      throw new Error(`Invalid new Repository Workspace: ${workspace.id}`);
    }
    const job = this.database.prepare(
      'SELECT project_id, repository_id, execution_mode FROM jobs WHERE id = ?',
    ).get(workspace.jobId) as {
      project_id: string;
      repository_id: string | null;
      execution_mode: JobExecutionMode;
    } | undefined;
    const binding = this.database.prepare(
      'SELECT repository_id FROM repository_checkouts WHERE id = ?',
    ).get(workspace.sourceCheckoutBindingId) as { repository_id: string } | undefined;
    if (!job || job.project_id !== workspace.projectId
      || job.repository_id !== workspace.repositoryId
      || job.execution_mode !== 'repository-write-isolated'
      || binding?.repository_id !== workspace.repositoryId) {
      throw new Error(`Invalid Repository Workspace associations: ${workspace.id}`);
    }
    try {
      this.database.prepare(`
        INSERT INTO repository_workspaces
          (id, job_id, project_id, repository_id, source_checkout_binding_id,
           base_revision, base_branch, branch_name, canonical_path, state,
           evidence_json, failure_reason, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        workspace.id, workspace.jobId, workspace.projectId, workspace.repositoryId,
        workspace.sourceCheckoutBindingId, workspace.baseRevision, workspace.baseBranch ?? null,
        workspace.branchName, workspace.canonicalPath, workspace.state, null, null,
        workspace.revision, workspace.createdAt, workspace.updatedAt,
      );
    } catch (error) {
      throw new Error(`Could not create Repository Workspace ${workspace.id}: ${(error as Error).message}`);
    }
  }

  async getRepositoryWorkspace(id: string): Promise<DurableRepositoryWorkspace | null> {
    this.assertOpen();
    if (!this.supportsIsolatedWriteWorkspaces) return null;
    const row = this.database.prepare('SELECT * FROM repository_workspaces WHERE id = ?')
      .get(id) as RepositoryWorkspaceRow | undefined;
    return row ? toRepositoryWorkspace(row) : null;
  }

  async getRepositoryWorkspaceForJob(jobId: string): Promise<DurableRepositoryWorkspace | null> {
    this.assertOpen();
    if (!this.supportsIsolatedWriteWorkspaces) return null;
    const row = this.database.prepare('SELECT * FROM repository_workspaces WHERE job_id = ?')
      .get(jobId) as RepositoryWorkspaceRow | undefined;
    return row ? toRepositoryWorkspace(row) : null;
  }

  async listRepositoryWorkspaces(): Promise<readonly DurableRepositoryWorkspace[]> {
    this.assertOpen();
    if (!this.supportsIsolatedWriteWorkspaces) return [];
    return (this.database.prepare('SELECT * FROM repository_workspaces ORDER BY created_at, id')
      .all() as RepositoryWorkspaceRow[]).map(toRepositoryWorkspace);
  }

  async saveRepositoryWorkspaceTransition(
    workspace: DurableRepositoryWorkspace,
    expectedRevision: number,
  ): Promise<void> {
    this.assertOpen();
    if (!this.supportsIsolatedWriteWorkspaces) {
      throw new Error('Repository Workspaces require Agent Operations schema v12');
    }
    const existing = await this.getRepositoryWorkspace(workspace.id);
    if (!existing || existing.revision !== expectedRevision
      || workspace.revision !== expectedRevision + 1
      || existing.jobId !== workspace.jobId
      || existing.projectId !== workspace.projectId
      || existing.repositoryId !== workspace.repositoryId
      || existing.sourceCheckoutBindingId !== workspace.sourceCheckoutBindingId
      || existing.baseRevision !== workspace.baseRevision
      || existing.baseBranch !== workspace.baseBranch
      || existing.branchName !== workspace.branchName
      || existing.canonicalPath !== workspace.canonicalPath
      || existing.createdAt !== workspace.createdAt
      || !isValidRepositoryWorkspaceTransition(existing.state, workspace.state)) {
      throw new Error(`Invalid Repository Workspace transition: ${workspace.id}`);
    }
    if ((workspace.state === 'failed') !== Boolean(workspace.failureReason)) {
      throw new Error(`Failed Repository Workspace must record exactly one failure reason: ${workspace.id}`);
    }
    const result = this.database.prepare(`
      UPDATE repository_workspaces SET
        state = ?, evidence_json = ?, failure_reason = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      workspace.state, workspace.evidence ? JSON.stringify(workspace.evidence) : null,
      workspace.failureReason ?? null, workspace.revision, workspace.updatedAt,
      workspace.id, expectedRevision,
    );
    if (result.changes !== 1) {
      throw new Error(`Repository Workspace transition conflict: ${workspace.id}`);
    }
  }

  async retireJob(retirement: DurableJobRetirement): Promise<void> {
    this.assertOpen();
    if (!this.supportsJobRetirementAndRestore) {
      throw new Error('Job retirement requires Agent Operations schema v18');
    }
    const retire = this.database.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM job_retirements WHERE job_id = ?')
        .get(retirement.jobId) as JobRetirementRow | undefined;
      if (existing) {
        if (JSON.stringify(toJobRetirement(existing)) !== JSON.stringify(retirement)) {
          throw new Error(`Job ${retirement.jobId} already has another retirement disposition`);
        }
        return;
      }
      const job = this.database.prepare('SELECT id FROM jobs WHERE id = ?')
        .get(retirement.jobId) as { id: string } | undefined;
      if (!job) throw new Error(`Job not found: ${retirement.jobId}`);
      this.database.prepare(`
        INSERT INTO job_retirements
          (job_id, disposition, reason, actor, evidence_reference, retired_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        retirement.jobId, retirement.disposition, retirement.reason, retirement.actor,
        retirement.evidenceReference ?? null, retirement.retiredAt,
      );
      if (this.supportsLateExecutionReconciliation) {
        this.database.prepare(`
          UPDATE escalations SET resolved_at = ?, resolution_summary = ?
          WHERE job_id = ? AND resolved_at IS NULL
        `).run(retirement.retiredAt, `Job retired: ${retirement.reason}`, retirement.jobId);
      } else {
        this.database.prepare('UPDATE escalations SET resolved_at = ? WHERE job_id = ? AND resolved_at IS NULL')
          .run(retirement.retiredAt, retirement.jobId);
      }
    });
    retire();
  }

  async getJobRetirement(jobId: string): Promise<DurableJobRetirement | null> {
    this.assertOpen();
    if (!this.supportsJobRetirementAndRestore) return null;
    const row = this.database.prepare('SELECT * FROM job_retirements WHERE job_id = ?')
      .get(jobId) as JobRetirementRow | undefined;
    return row ? toJobRetirement(row) : null;
  }

  async listJobRetirements(): Promise<readonly DurableJobRetirement[]> {
    this.assertOpen();
    if (!this.supportsJobRetirementAndRestore) return [];
    return (this.database.prepare('SELECT * FROM job_retirements ORDER BY retired_at, job_id')
      .all() as JobRetirementRow[]).map(toJobRetirement);
  }

  async createRepositoryRestoreAction(action: DurableRepositoryRestoreAction): Promise<void> {
    this.assertOpen();
    if (!this.supportsJobRetirementAndRestore) {
      throw new Error('Repository Restore actions require Agent Operations schema v18');
    }
    if (!action.id.startsWith('repository-restore:') || action.state !== 'pending-approval'
      || action.revision !== 0 || action.result || action.failureReason) {
      throw new Error(`Invalid new Repository Restore action: ${action.id}`);
    }
    const binding = this.database.prepare(`
      SELECT repository_id, canonical_path FROM repository_checkouts WHERE id = ?
    `).get(action.checkoutBindingId) as { repository_id: string; canonical_path: string } | undefined;
    if (!binding || binding.repository_id !== action.repositoryId
      || binding.canonical_path !== action.preconditions.canonicalPath) {
      throw new Error(`Invalid Repository Restore associations: ${action.id}`);
    }
    this.database.prepare(`
      INSERT INTO repository_restore_actions
        (id, project_id, repository_id, checkout_binding_id, state, preconditions_json,
         approval_summary, requested_by, created_at, approved_at, approved_by,
         result_json, failure_reason, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      action.id, action.projectId, action.repositoryId, action.checkoutBindingId, action.state,
      JSON.stringify(action.preconditions), action.approvalSummary, action.requestedBy,
      action.createdAt, null, null, null, null, action.revision,
    );
  }

  async getRepositoryRestoreAction(id: string): Promise<DurableRepositoryRestoreAction | null> {
    this.assertOpen();
    if (!this.supportsJobRetirementAndRestore) return null;
    const row = this.database.prepare('SELECT * FROM repository_restore_actions WHERE id = ?')
      .get(id) as RepositoryRestoreActionRow | undefined;
    return row ? toRepositoryRestoreAction(row) : null;
  }

  async listRepositoryRestoreActions(): Promise<readonly DurableRepositoryRestoreAction[]> {
    this.assertOpen();
    if (!this.supportsJobRetirementAndRestore) return [];
    return (this.database.prepare('SELECT * FROM repository_restore_actions ORDER BY created_at, id')
      .all() as RepositoryRestoreActionRow[]).map(toRepositoryRestoreAction);
  }

  async saveRepositoryRestoreActionTransition(
    action: DurableRepositoryRestoreAction,
    expectedRevision: number,
  ): Promise<void> {
    this.assertOpen();
    if (!this.supportsJobRetirementAndRestore) {
      throw new Error('Repository Restore actions require Agent Operations schema v18');
    }
    const existing = await this.getRepositoryRestoreAction(action.id);
    const allowed = existing?.state === 'pending-approval'
      ? ['approved', 'rejected']
      : existing?.state === 'approved' ? ['completed', 'failed'] : [];
    if (!existing || existing.revision !== expectedRevision || action.revision !== expectedRevision + 1
      || existing.projectId !== action.projectId || existing.repositoryId !== action.repositoryId
      || existing.checkoutBindingId !== action.checkoutBindingId || existing.createdAt !== action.createdAt
      || JSON.stringify(existing.preconditions) !== JSON.stringify(action.preconditions)
      || !allowed.includes(action.state)
      || ((action.state === 'completed') !== Boolean(action.result))
      || ((action.state === 'failed') !== Boolean(action.failureReason))) {
      throw new Error(`Invalid Repository Restore transition: ${action.id}`);
    }
    const result = this.database.prepare(`
      UPDATE repository_restore_actions SET
        state = ?, approved_at = ?, approved_by = ?, result_json = ?, failure_reason = ?, revision = ?
      WHERE id = ? AND revision = ?
    `).run(
      action.state, action.approvedAt ?? null, action.approvedBy ?? null,
      action.result ? JSON.stringify(action.result) : null, action.failureReason ?? null,
      action.revision, action.id, expectedRevision,
    );
    if (result.changes !== 1) throw new Error(`Repository Restore transition conflict: ${action.id}`);
  }

  async createJob(job: DurableJob): Promise<void> {
    this.assertOpen();
    requireNonEmpty(job.title, 'Job title');
    if (!job.id.startsWith('job:')) throw new Error(`Invalid Agent Operations job ID: ${job.id}`);
    if (job.status !== 'draft' || job.revision !== 0) throw new Error('New jobs must be draft at revision 0');
    if (job.automaticReadOnlyCompletion && !job.acceptanceCriteria?.trim()) {
      throw new Error('Automatic read-only completion requires acceptance criteria');
    }
    if (!this.supportsOrchestration
      && (job.acceptanceCriteria !== undefined || job.automaticReadOnlyCompletion === true)) {
      throw new Error('Job orchestration fields require Agent Operations schema v9');
    }
    const executionMode = job.executionMode ?? 'repository-read-only';
    if (!this.supportsIsolatedWriteWorkspaces && executionMode !== 'repository-read-only') {
      throw new Error('Isolated repository write Jobs require Agent Operations schema v12');
    }
    try {
      const project = this.database.prepare('SELECT 1 FROM projects WHERE id = ?').get(job.projectId);
      if (!project) throw new Error(`Unknown project for job: ${job.projectId}`);
      if (job.repositoryId) {
        const association = this.database.prepare(`
          SELECT 1 FROM project_repositories WHERE project_id = ? AND repository_id = ?
        `).get(job.projectId, job.repositoryId);
        if (!association) {
          throw new Error(`Repository ${job.repositoryId} is not associated with project ${job.projectId}`);
        }
      }
      if (job.preferredRuntimeAgentId) {
        const association = this.database.prepare(`
          SELECT 1 FROM project_runtime_agents WHERE project_id = ? AND agent_id = ?
        `).get(job.projectId, job.preferredRuntimeAgentId);
        if (!association) {
          throw new Error(
            `Runtime ${job.preferredRuntimeAgentId} is not associated with project ${job.projectId}`,
          );
        }
      }
      const common = [
        job.id,
        job.projectId,
        job.title,
        job.description ?? null,
        job.status,
        job.repositoryId ?? null,
        job.preferredRuntimeAgentId ?? null,
        job.revision,
        job.createdAt,
        job.updatedAt,
      ] as const;
      if (this.supportsIsolatedWriteWorkspaces) {
        this.database.prepare(`
          INSERT INTO jobs
            (id, project_id, title, description, status, repository_id,
             preferred_runtime_agent_id, revision, created_at, updated_at,
             acceptance_criteria, automatic_read_only_completion, execution_mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...common,
          job.acceptanceCriteria ?? null,
          job.automaticReadOnlyCompletion ? 1 : 0,
          executionMode,
        );
      } else if (this.supportsOrchestration) {
        this.database.prepare(`
          INSERT INTO jobs
            (id, project_id, title, description, status, repository_id,
             preferred_runtime_agent_id, revision, created_at, updated_at,
             acceptance_criteria, automatic_read_only_completion)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...common,
          job.acceptanceCriteria ?? null,
          job.automaticReadOnlyCompletion ? 1 : 0,
        );
      } else {
        this.database.prepare(`
          INSERT INTO jobs
            (id, project_id, title, description, status, repository_id,
             preferred_runtime_agent_id, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(...common);
      }
    } catch (error) {
      throw new Error(`Could not create job ${job.id}: ${(error as Error).message}`);
    }
  }

  async getJob(id: string): Promise<DurableJob | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  async listJobs(projectId?: string): Promise<readonly DurableJob[]> {
    this.assertOpen();
    const rows = projectId
      ? this.database.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at, id').all(projectId)
      : this.database.prepare('SELECT * FROM jobs ORDER BY created_at, id').all();
    return (rows as JobRow[]).map(toJob);
  }

  async saveJobTransition(job: DurableJob, expectedRevision: number): Promise<void> {
    this.assertOpen();
    const existingRow = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) as JobRow | undefined;
    if (!existingRow) throw new Error(`Job not found: ${job.id}`);
    const existing = toJob(existingRow);
    if (existing.projectId !== job.projectId
      || existing.repositoryId !== job.repositoryId
      || existing.preferredRuntimeAgentId !== job.preferredRuntimeAgentId
      || (existing.executionMode ?? 'repository-read-only')
        !== (job.executionMode ?? 'repository-read-only')
      || existing.acceptanceCriteria !== job.acceptanceCriteria
      || existing.automaticReadOnlyCompletion !== job.automaticReadOnlyCompletion
      || existing.createdAt !== job.createdAt) {
      throw new Error(`Job transition cannot rewrite durable identity or assignment: ${job.id}`);
    }
    if (job.revision !== expectedRevision + 1) {
      throw new Error(`Job transition revision must advance exactly once: ${job.id}`);
    }
    const result = this.database.prepare(`
      UPDATE jobs SET title = ?, description = ?, status = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      job.title,
      job.description ?? null,
      job.status,
      job.revision,
      job.updatedAt,
      job.id,
      expectedRevision,
    );
    if (result.changes !== 1) throw new Error(`Stale job revision for ${job.id}`);
  }

  async createAttempt(attempt: NewDurableJobAttempt): Promise<DurableJobAttempt> {
    this.assertOpen();
    if (!attempt.id.startsWith('attempt:')) throw new Error(`Invalid Agent Operations attempt ID: ${attempt.id}`);
    if (attempt.status !== 'created' || attempt.revision !== 0) {
      throw new Error('New attempts must be created at revision 0');
    }
    const executionRole = attempt.executionRole ?? 'worker';
    if (!this.supportsOrchestration && executionRole !== 'worker') {
      throw new Error('Reviewer Attempts require Agent Operations schema v9');
    }
    try {
      const create = this.database.transaction(() => {
        const job = this.database.prepare('SELECT project_id FROM jobs WHERE id = ?')
          .get(attempt.jobId) as { project_id: string } | undefined;
        if (!job) throw new Error(`Unknown job for attempt: ${attempt.jobId}`);
        if (attempt.runtimeAgentId) {
          const association = this.database.prepare(`
            SELECT 1 FROM project_runtime_agents WHERE project_id = ? AND agent_id = ?
          `).get(job.project_id, attempt.runtimeAgentId);
          if (!association) {
            throw new Error(
              `Runtime ${attempt.runtimeAgentId} is not associated with project ${job.project_id}`,
            );
          }
        }
        const active = this.supportsOrchestration
          ? this.database.prepare(`
              SELECT id FROM job_attempts
              WHERE job_id = ? AND execution_role = ? AND status IN ('created', 'running') LIMIT 1
            `).get(attempt.jobId, executionRole) as { id: string } | undefined
          : this.database.prepare(`
              SELECT id FROM job_attempts WHERE job_id = ? AND status IN ('created', 'running') LIMIT 1
            `).get(attempt.jobId) as { id: string } | undefined;
        if (active) throw new Error(`Job ${attempt.jobId} already has an active attempt for role ${executionRole}`);
        const row = this.database.prepare(`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM job_attempts WHERE job_id = ?
        `).get(attempt.jobId) as { next_sequence: number };
        const roleRow = this.supportsOrchestration
          ? this.database.prepare(`
              SELECT COALESCE(MAX(role_sequence), 0) + 1 AS next_sequence
              FROM job_attempts WHERE job_id = ? AND execution_role = ?
            `).get(attempt.jobId, executionRole) as { next_sequence: number }
          : row;
        if (this.supportsOrchestration) {
          this.database.prepare(`
            INSERT INTO job_attempts
              (id, job_id, sequence, runtime_agent_id, status, revision, created_at, updated_at,
               execution_role, role_sequence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            attempt.id,
            attempt.jobId,
            row.next_sequence,
            attempt.runtimeAgentId ?? null,
            attempt.status,
            attempt.revision,
            attempt.createdAt,
            attempt.updatedAt,
            executionRole,
            roleRow.next_sequence,
          );
        } else {
          this.database.prepare(`
            INSERT INTO job_attempts
              (id, job_id, sequence, runtime_agent_id, status, revision, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            attempt.id,
            attempt.jobId,
            row.next_sequence,
            attempt.runtimeAgentId ?? null,
            attempt.status,
            attempt.revision,
            attempt.createdAt,
            attempt.updatedAt,
          );
        }
        return {
          ...attempt,
          sequence: row.next_sequence,
          executionRole,
          roleSequence: roleRow.next_sequence,
        };
      });
      return create.immediate();
    } catch (error) {
      throw new Error(`Could not create attempt ${attempt.id}: ${(error as Error).message}`);
    }
  }

  async getAttempt(id: string): Promise<DurableJobAttempt | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM job_attempts WHERE id = ?')
      .get(id) as AttemptRow | undefined;
    return row ? toAttempt(row) : null;
  }

  async listAttemptsForJob(jobId: string): Promise<readonly DurableJobAttempt[]> {
    this.assertOpen();
    return (this.database.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY sequence')
      .all(jobId) as AttemptRow[]).map(toAttempt);
  }

  async saveAttemptTransition(attempt: DurableJobAttempt, expectedRevision: number): Promise<void> {
    this.assertOpen();
    const existingRow = this.database.prepare('SELECT * FROM job_attempts WHERE id = ?')
      .get(attempt.id) as AttemptRow | undefined;
    if (!existingRow) throw new Error(`Attempt not found: ${attempt.id}`);
    const existing = toAttempt(existingRow);
    if (existing.jobId !== attempt.jobId
      || existing.sequence !== attempt.sequence
      || existing.executionRole !== attempt.executionRole
      || existing.roleSequence !== attempt.roleSequence
      || existing.runtimeAgentId !== attempt.runtimeAgentId
      || existing.createdAt !== attempt.createdAt) {
      throw new Error(`Attempt transition cannot rewrite durable identity or assignment: ${attempt.id}`);
    }
    if (attempt.revision !== expectedRevision + 1) {
      throw new Error(`Attempt transition revision must advance exactly once: ${attempt.id}`);
    }
    const result = this.database.prepare(`
      UPDATE job_attempts SET
        status = ?, started_at = ?, finished_at = ?, summary = ?, failure_reason = ?,
        revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      attempt.status,
      attempt.startedAt ?? null,
      attempt.finishedAt ?? null,
      attempt.summary ?? null,
      attempt.failureReason ?? null,
      attempt.revision,
      attempt.updatedAt,
      attempt.id,
      expectedRevision,
    );
    if (result.changes !== 1) throw new Error(`Stale attempt revision for ${attempt.id}`);
  }

  async createExecutionPlan(plan: DurableExecutionPlan): Promise<void> {
    this.assertOpen();
    requireNonEmpty(plan.input.instruction, 'Execution instruction');
    if (!plan.id.startsWith('plan:')) throw new Error(`Invalid Execution Plan ID: ${plan.id}`);
    if (plan.input.version !== 1) throw new Error(`Unsupported execution input version: ${plan.input.version}`);
    if (this.supportsRuntimePolicies && !plan.requestedPolicy) {
      throw new Error('New Execution Plans require an explicit runtime execution policy');
    }
    if (!this.supportsRuntimePolicies && plan.requestedPolicy) {
      throw new Error('Runtime execution policy requires Agent Operations schema v6');
    }
    if (this.supportsExecutionCapabilities && !plan.requestedCapabilities) {
      throw new Error('New Execution Plans require explicit runtime tool capabilities');
    }
    if (!this.supportsExecutionCapabilities && plan.requestedCapabilities) {
      throw new Error('Runtime tool capabilities require Agent Operations schema v8');
    }
    if (!this.supportsIsolatedWriteWorkspaces && plan.repositoryWorkspaceId) {
      throw new Error('Repository Workspace Plans require Agent Operations schema v12');
    }
    if (plan.jobRevisionAtPreparation < 0 || plan.attemptRevisionAtPreparation < 0) {
      throw new Error('Execution Plan revisions must be non-negative');
    }
    const attempt = this.database.prepare(`
      SELECT a.job_id, a.runtime_agent_id, a.revision AS attempt_revision,
             j.project_id, j.repository_id, j.revision AS job_revision
      FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?
    `).get(plan.attemptId) as {
      job_id: string;
      runtime_agent_id: string | null;
      project_id: string;
      repository_id: string | null;
      job_revision: number;
      attempt_revision: number;
    } | undefined;
    if (!attempt
      || attempt.job_id !== plan.jobId
      || attempt.project_id !== plan.projectId
      || attempt.runtime_agent_id !== plan.runtimeAgentId
      || (attempt.repository_id ?? undefined) !== plan.repositoryId
      || attempt.job_revision !== plan.jobRevisionAtPreparation
      || attempt.attempt_revision !== plan.attemptRevisionAtPreparation) {
      throw new Error(`Invalid Execution Plan durable associations: ${plan.id}`);
    }
    if (plan.repositoryWorkspaceId) {
      const workspace = await this.getRepositoryWorkspace(plan.repositoryWorkspaceId);
      if (!workspace || workspace.jobId !== plan.jobId
        || workspace.repositoryId !== plan.repositoryId
        || workspace.sourceCheckoutBindingId !== plan.checkoutBindingId
        || !['active', 'reviewing', 'ready_for_approval'].includes(workspace.state)) {
        throw new Error(`Invalid Execution Plan Repository Workspace: ${plan.id}`);
      }
    }
    if (this.supportsProjectInputs) {
      rejectDuplicates(plan.inputIds ?? [], 'Execution Plan Input ID');
      for (const inputId of plan.inputIds ?? []) {
        const attached = this.database.prepare(
          'SELECT 1 FROM job_inputs WHERE job_id = ? AND input_id = ?',
        ).get(plan.jobId, inputId);
        if (!attached) throw new Error(`Execution Plan Input is not attached to Job: ${inputId}`);
      }
    } else if (plan.inputIds?.length || plan.requestedCapabilities?.inputRead) {
      throw new Error('Execution Plan Inputs require Agent Operations schema v13');
    }
    try {
      const common = [
        plan.id,
        plan.attemptId,
        plan.jobId,
        plan.projectId,
        plan.installationId,
        plan.runtimeAgentId,
        plan.repositoryId ?? null,
        plan.checkoutBindingId ?? null,
        plan.input.version,
        plan.input.instruction,
        plan.jobRevisionAtPreparation,
        plan.attemptRevisionAtPreparation,
        plan.createdAt,
      ] as const;
      if (this.supportsIsolatedWriteWorkspaces) {
        this.database.prepare(`
          INSERT INTO execution_plans
            (id, attempt_id, job_id, project_id, installation_id, runtime_agent_id,
             repository_id, checkout_binding_id, input_version, instruction,
             job_revision, attempt_revision, created_at, requested_policy_version,
             requested_filesystem, requested_network, requested_environment,
             requested_capabilities_version, requested_repository_read,
             repository_workspace_id, requested_repository_patch,
             requested_test_run, requested_git_inspect)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...common,
          plan.requestedPolicy!.version,
          plan.requestedPolicy!.filesystem,
          plan.requestedPolicy!.network,
          plan.requestedPolicy!.environment,
          plan.requestedCapabilities!.version,
          plan.requestedCapabilities!.repositoryRead ? 1 : 0,
          plan.repositoryWorkspaceId ?? null,
          plan.requestedCapabilities!.repositoryPatch ? 1 : 0,
          plan.requestedCapabilities!.testRun ? 1 : 0,
          plan.requestedCapabilities!.gitInspect ? 1 : 0,
        );
      } else if (this.supportsExecutionCapabilities) {
        this.database.prepare(`
          INSERT INTO execution_plans
            (id, attempt_id, job_id, project_id, installation_id, runtime_agent_id,
             repository_id, checkout_binding_id, input_version, instruction,
             job_revision, attempt_revision, created_at, requested_policy_version,
             requested_filesystem, requested_network, requested_environment,
             requested_capabilities_version, requested_repository_read)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...common,
          plan.requestedPolicy!.version,
          plan.requestedPolicy!.filesystem,
          plan.requestedPolicy!.network,
          plan.requestedPolicy!.environment,
          plan.requestedCapabilities!.version,
          plan.requestedCapabilities!.repositoryRead ? 1 : 0,
        );
      } else if (this.supportsRuntimePolicies) {
        this.database.prepare(`
          INSERT INTO execution_plans
            (id, attempt_id, job_id, project_id, installation_id, runtime_agent_id,
             repository_id, checkout_binding_id, input_version, instruction,
             job_revision, attempt_revision, created_at, requested_policy_version,
             requested_filesystem, requested_network, requested_environment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...common,
          plan.requestedPolicy!.version,
          plan.requestedPolicy!.filesystem,
          plan.requestedPolicy!.network,
          plan.requestedPolicy!.environment,
        );
      } else {
        this.database.prepare(`
          INSERT INTO execution_plans
            (id, attempt_id, job_id, project_id, installation_id, runtime_agent_id,
             repository_id, checkout_binding_id, input_version, instruction,
             job_revision, attempt_revision, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(...common);
      }
      if (this.supportsProjectInputs) {
        this.database.prepare('UPDATE execution_plans SET requested_input_read = ? WHERE id = ?')
          .run(plan.requestedCapabilities?.inputRead ? 1 : 0, plan.id);
        const insertInput = this.database.prepare(
          'INSERT INTO execution_plan_inputs (execution_plan_id, input_id) VALUES (?, ?)',
        );
        for (const inputId of plan.inputIds ?? []) insertInput.run(plan.id, inputId);
      }
    } catch (error) {
      throw new Error(`Could not create Execution Plan ${plan.id}: ${(error as Error).message}`);
    }
  }

  async getExecutionPlan(id: string): Promise<DurableExecutionPlan | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_plans WHERE id = ?')
      .get(id) as ExecutionPlanRow | undefined;
    return row ? toExecutionPlan(row, this.listExecutionPlanInputIds(id)) : null;
  }

  async getExecutionPlanForAttempt(attemptId: string): Promise<DurableExecutionPlan | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_plans WHERE attempt_id = ?')
      .get(attemptId) as ExecutionPlanRow | undefined;
    return row ? toExecutionPlan(row, this.listExecutionPlanInputIds(row.id)) : null;
  }

  private listExecutionPlanInputIds(planId: string): readonly string[] {
    if (!this.supportsProjectInputs) return [];
    return (this.database.prepare(
      'SELECT input_id FROM execution_plan_inputs WHERE execution_plan_id = ? ORDER BY input_id',
    ).all(planId) as Array<{ input_id: string }>).map(value => value.input_id);
  }

  async createExecutionDispatch(dispatch: DurableExecutionDispatch): Promise<void> {
    this.assertOpen();
    requireNonEmpty(dispatch.idempotencyKey, 'Execution Dispatch idempotency key');
    if (!dispatch.id.startsWith('dispatch:')) throw new Error(`Invalid Execution Dispatch ID: ${dispatch.id}`);
    if (dispatch.status !== 'prepared' || dispatch.revision !== 0) {
      throw new Error('New Execution Dispatches must be prepared at revision 0');
    }
    const plan = this.database.prepare(`
      SELECT attempt_id, job_id, runtime_agent_id FROM execution_plans WHERE id = ?
    `).get(dispatch.executionPlanId) as {
      attempt_id: string;
      job_id: string;
      runtime_agent_id: string;
    } | undefined;
    if (!plan
      || plan.attempt_id !== dispatch.attemptId
      || plan.job_id !== dispatch.jobId
      || plan.runtime_agent_id !== dispatch.runtimeAgentId) {
      throw new Error(`Invalid Execution Dispatch Plan associations: ${dispatch.id}`);
    }
    try {
      this.database.prepare(`
        INSERT INTO execution_dispatches
          (id, execution_plan_id, attempt_id, job_id, runtime_agent_id, idempotency_key,
           status, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        dispatch.id,
        dispatch.executionPlanId,
        dispatch.attemptId,
        dispatch.jobId,
        dispatch.runtimeAgentId,
        dispatch.idempotencyKey,
        dispatch.status,
        dispatch.revision,
        dispatch.createdAt,
        dispatch.updatedAt,
      );
    } catch (error) {
      throw new Error(`Could not create Execution Dispatch ${dispatch.id}: ${(error as Error).message}`);
    }
  }

  async getExecutionDispatch(id: string): Promise<DurableExecutionDispatch | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_dispatches WHERE id = ?')
      .get(id) as ExecutionDispatchRow | undefined;
    return row ? toExecutionDispatch(row) : null;
  }

  async getExecutionDispatchForPlan(executionPlanId: string): Promise<DurableExecutionDispatch | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM execution_dispatches WHERE execution_plan_id = ?')
      .get(executionPlanId) as ExecutionDispatchRow | undefined;
    return row ? toExecutionDispatch(row) : null;
  }

  async saveExecutionDispatchTransition(
    dispatch: DurableExecutionDispatch,
    expectedRevision: number,
  ): Promise<void> {
    this.assertOpen();
    const existingRow = this.database.prepare('SELECT * FROM execution_dispatches WHERE id = ?')
      .get(dispatch.id) as ExecutionDispatchRow | undefined;
    if (!existingRow) throw new Error(`Execution Dispatch not found: ${dispatch.id}`);
    const existing = toExecutionDispatch(existingRow);
    if (existing.executionPlanId !== dispatch.executionPlanId
      || existing.attemptId !== dispatch.attemptId
      || existing.jobId !== dispatch.jobId
      || existing.runtimeAgentId !== dispatch.runtimeAgentId
      || existing.idempotencyKey !== dispatch.idempotencyKey
      || existing.createdAt !== dispatch.createdAt) {
      throw new Error(`Execution Dispatch transition cannot rewrite durable identity: ${dispatch.id}`);
    }
    if (dispatch.revision !== expectedRevision + 1) {
      throw new Error(`Execution Dispatch transition revision must advance exactly once: ${dispatch.id}`);
    }
    if (!isValidDispatchTransition(existing.status, dispatch.status)) {
      throw new Error(`Execution Dispatch cannot transition from ${existing.status} to ${dispatch.status}`);
    }
    if (dispatch.status !== 'accepted' && (dispatch.effectivePolicy || dispatch.effectiveCapabilities)) {
      throw new Error(`Only an accepted Execution Dispatch may record effective policy and capabilities: ${dispatch.id}`);
    }
    if (dispatch.status === 'accepted' && this.supportsRuntimePolicies) {
      const planRow = this.database.prepare('SELECT * FROM execution_plans WHERE id = ?')
        .get(dispatch.executionPlanId) as ExecutionPlanRow | undefined;
      const requestedPolicy = planRow ? toExecutionPlan(planRow).requestedPolicy : undefined;
      if (requestedPolicy && (!dispatch.effectivePolicy
        || !isRuntimeExecutionPolicyNoBroaderThan(dispatch.effectivePolicy, requestedPolicy))) {
        throw new Error(`Accepted Execution Dispatch must record a non-broader effective policy: ${dispatch.id}`);
      }
      if (!requestedPolicy && dispatch.effectivePolicy) {
        throw new Error(`Legacy Execution Dispatch cannot invent effective policy: ${dispatch.id}`);
      }
    }
    if (dispatch.status === 'accepted' && this.supportsExecutionCapabilities) {
      const planRow = this.database.prepare('SELECT * FROM execution_plans WHERE id = ?')
        .get(dispatch.executionPlanId) as ExecutionPlanRow | undefined;
      const requestedCapabilities = planRow
        ? toExecutionPlan(planRow).requestedCapabilities
        : undefined;
      if (requestedCapabilities && (!dispatch.effectiveCapabilities
        || !isRuntimeExecutionCapabilitiesNoBroaderThan(
          dispatch.effectiveCapabilities,
          requestedCapabilities,
        ))) {
        throw new Error(`Accepted Execution Dispatch must record non-broader effective capabilities: ${dispatch.id}`);
      }
      if (!requestedCapabilities && dispatch.effectiveCapabilities) {
        throw new Error(`Legacy Execution Dispatch cannot invent effective capabilities: ${dispatch.id}`);
      }
    }
    try {
      const common = [
        dispatch.status,
        dispatch.externalReference ?? null,
        dispatch.message ?? null,
        dispatch.revision,
        dispatch.updatedAt,
        dispatch.submittedAt ?? null,
        dispatch.acceptedAt ?? null,
        dispatch.resolvedAt ?? null,
      ] as const;
      const result = this.supportsIsolatedWriteWorkspaces
        ? this.database.prepare(`
            UPDATE execution_dispatches SET
              status = ?, external_reference = ?, message = ?, revision = ?, updated_at = ?,
              submitted_at = ?, accepted_at = ?, resolved_at = ?,
              effective_policy_version = ?, effective_filesystem = ?,
              effective_network = ?, effective_environment = ?,
              effective_capabilities_version = ?, effective_repository_read = ?,
              effective_repository_patch = ?, effective_test_run = ?, effective_git_inspect = ?
            WHERE id = ? AND revision = ?
          `).run(
            ...common,
            dispatch.effectivePolicy?.version ?? null,
            dispatch.effectivePolicy?.filesystem ?? null,
            dispatch.effectivePolicy?.network ?? null,
            dispatch.effectivePolicy?.environment ?? null,
            dispatch.effectiveCapabilities?.version ?? null,
            dispatch.effectiveCapabilities?.repositoryRead === undefined
              ? null
              : dispatch.effectiveCapabilities.repositoryRead ? 1 : 0,
            dispatch.effectiveCapabilities?.repositoryPatch === undefined
              ? null
              : dispatch.effectiveCapabilities.repositoryPatch ? 1 : 0,
            dispatch.effectiveCapabilities?.testRun === undefined
              ? null
              : dispatch.effectiveCapabilities.testRun ? 1 : 0,
            dispatch.effectiveCapabilities?.gitInspect === undefined
              ? null
              : dispatch.effectiveCapabilities.gitInspect ? 1 : 0,
            dispatch.id,
            expectedRevision,
          )
        : this.supportsExecutionCapabilities
        ? this.database.prepare(`
            UPDATE execution_dispatches SET
              status = ?, external_reference = ?, message = ?, revision = ?, updated_at = ?,
              submitted_at = ?, accepted_at = ?, resolved_at = ?,
              effective_policy_version = ?, effective_filesystem = ?,
              effective_network = ?, effective_environment = ?,
              effective_capabilities_version = ?, effective_repository_read = ?
            WHERE id = ? AND revision = ?
          `).run(
            ...common,
            dispatch.effectivePolicy?.version ?? null,
            dispatch.effectivePolicy?.filesystem ?? null,
            dispatch.effectivePolicy?.network ?? null,
            dispatch.effectivePolicy?.environment ?? null,
            dispatch.effectiveCapabilities?.version ?? null,
            dispatch.effectiveCapabilities?.repositoryRead === undefined
              ? null
              : dispatch.effectiveCapabilities.repositoryRead ? 1 : 0,
            dispatch.id,
            expectedRevision,
          )
        : this.supportsRuntimePolicies
          ? this.database.prepare(`
            UPDATE execution_dispatches SET
              status = ?, external_reference = ?, message = ?, revision = ?, updated_at = ?,
              submitted_at = ?, accepted_at = ?, resolved_at = ?,
              effective_policy_version = ?, effective_filesystem = ?,
              effective_network = ?, effective_environment = ?
            WHERE id = ? AND revision = ?
          `).run(
            ...common,
            dispatch.effectivePolicy?.version ?? null,
            dispatch.effectivePolicy?.filesystem ?? null,
            dispatch.effectivePolicy?.network ?? null,
            dispatch.effectivePolicy?.environment ?? null,
            dispatch.id,
            expectedRevision,
          )
          : this.database.prepare(`
            UPDATE execution_dispatches SET
              status = ?, external_reference = ?, message = ?, revision = ?, updated_at = ?,
              submitted_at = ?, accepted_at = ?, resolved_at = ?
            WHERE id = ? AND revision = ?
          `).run(...common, dispatch.id, expectedRevision);
      if (result.changes !== 1) throw new Error(`Stale Execution Dispatch revision for ${dispatch.id}`);
      if (this.supportsProjectInputs) {
        this.database.prepare('UPDATE execution_dispatches SET effective_input_read = ? WHERE id = ?')
          .run(dispatch.effectiveCapabilities?.inputRead === undefined
            ? null : dispatch.effectiveCapabilities.inputRead ? 1 : 0, dispatch.id);
      }
    } catch (error) {
      throw new Error(`Could not transition Execution Dispatch ${dispatch.id}: ${(error as Error).message}`);
    }
  }

  async appendExecutionObservation(observation: DurableExecutionObservation): Promise<boolean> {
    this.assertOpen();
    requireNonEmpty(observation.source, 'Execution Observation source');
    requireNonEmpty(observation.sourceEventId, 'Execution Observation source event ID');
    if (observation.resultText !== undefined
      && (!isBoundedExecutionResult(observation.resultText)
        || observation.kind !== 'turn-completed'
        || observation.correlation !== 'exact')) {
      throw new Error(`Execution result text requires exact bounded completion evidence: ${observation.id}`);
    }
    if (!this.supportsOrchestration && observation.resultText !== undefined) {
      throw new Error('Execution result capture requires Agent Operations schema v9');
    }
    const existing = this.database.prepare(`
      SELECT id FROM execution_observations
      WHERE id = ? OR (dispatch_id = ? AND source = ? AND source_event_id = ?)
      LIMIT 1
    `).get(
      observation.id,
      observation.dispatchId,
      observation.source,
      observation.sourceEventId,
    );
    if (existing) return false;
    try {
      const common = [
        observation.id,
        observation.dispatchId,
        observation.attemptId,
        observation.source,
        observation.sourceEventId,
        observation.kind,
        observation.correlation,
        observation.correlatedDispatchId ?? null,
        observation.runtimeSessionId ?? null,
        observation.externalReference ?? null,
        observation.message ?? null,
        observation.outputSummary ?? null,
      ];
      if (this.supportsIsolatedWriteWorkspaces) {
        this.database.prepare(`
          INSERT INTO execution_observations
            (id, dispatch_id, attempt_id, source, source_event_id, kind, correlation,
             correlated_dispatch_id, runtime_session_id, external_reference, message,
             output_summary, execution_working_directory, effective_policy_version,
             effective_filesystem, effective_network, effective_environment,
             repository_read_root, repository_write_root, effective_capabilities_version,
             effective_repository_read, effective_repository_patch, effective_test_run,
             effective_git_inspect, tool_operations_json, observed_at, recorded_at, result_text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...common,
          observation.executionContext?.workingDirectory ?? null,
          observation.effectivePolicy?.version ?? null,
          observation.effectivePolicy?.filesystem ?? null,
          observation.effectivePolicy?.network ?? null,
          observation.effectivePolicy?.environment ?? null,
          observation.executionContext?.repositoryReadRoot ?? null,
          observation.executionContext?.repositoryWriteRoot ?? null,
          observation.effectiveCapabilities?.version ?? null,
          observation.effectiveCapabilities?.repositoryRead === undefined
            ? null
            : observation.effectiveCapabilities.repositoryRead ? 1 : 0,
          observation.effectiveCapabilities?.repositoryPatch === undefined
            ? null
            : observation.effectiveCapabilities.repositoryPatch ? 1 : 0,
          observation.effectiveCapabilities?.testRun === undefined
            ? null
            : observation.effectiveCapabilities.testRun ? 1 : 0,
          observation.effectiveCapabilities?.gitInspect === undefined
            ? null
            : observation.effectiveCapabilities.gitInspect ? 1 : 0,
          observation.toolOperations ? JSON.stringify(observation.toolOperations) : null,
          observation.observedAt,
          observation.recordedAt,
          observation.resultText ?? null,
        );
      } else if (this.supportsOrchestration) {
        this.database.prepare(`
          INSERT INTO execution_observations
            (id, dispatch_id, attempt_id, source, source_event_id, kind, correlation,
             correlated_dispatch_id, runtime_session_id, external_reference, message,
             output_summary, execution_working_directory, effective_policy_version,
             effective_filesystem, effective_network, effective_environment,
             repository_read_root, effective_capabilities_version,
             effective_repository_read, observed_at, recorded_at, result_text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...common,
          observation.executionContext?.workingDirectory ?? null,
          observation.effectivePolicy?.version ?? null,
          observation.effectivePolicy?.filesystem ?? null,
          observation.effectivePolicy?.network ?? null,
          observation.effectivePolicy?.environment ?? null,
          observation.executionContext?.repositoryReadRoot ?? null,
          observation.effectiveCapabilities?.version ?? null,
          observation.effectiveCapabilities?.repositoryRead === undefined
            ? null
            : observation.effectiveCapabilities.repositoryRead ? 1 : 0,
          observation.observedAt,
          observation.recordedAt,
          observation.resultText ?? null,
        );
      } else if (this.supportsExecutionCapabilities) {
        this.database.prepare(`
          INSERT INTO execution_observations
            (id, dispatch_id, attempt_id, source, source_event_id, kind, correlation,
             correlated_dispatch_id, runtime_session_id, external_reference, message,
             output_summary, execution_working_directory, effective_policy_version,
             effective_filesystem, effective_network, effective_environment,
             repository_read_root, effective_capabilities_version,
             effective_repository_read, observed_at, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...common,
          observation.executionContext?.workingDirectory ?? null,
          observation.effectivePolicy?.version ?? null,
          observation.effectivePolicy?.filesystem ?? null,
          observation.effectivePolicy?.network ?? null,
          observation.effectivePolicy?.environment ?? null,
          observation.executionContext?.repositoryReadRoot ?? null,
          observation.effectiveCapabilities?.version ?? null,
          observation.effectiveCapabilities?.repositoryRead === undefined
            ? null
            : observation.effectiveCapabilities.repositoryRead ? 1 : 0,
          observation.observedAt,
          observation.recordedAt,
        );
      } else if (this.supportsExecutionContextEvidence) {
        this.database.prepare(`
          INSERT INTO execution_observations
            (id, dispatch_id, attempt_id, source, source_event_id, kind, correlation,
             correlated_dispatch_id, runtime_session_id, external_reference, message,
             output_summary, execution_working_directory, effective_policy_version,
             effective_filesystem, effective_network, effective_environment,
             observed_at, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...common,
          observation.executionContext?.workingDirectory ?? null,
          observation.effectivePolicy?.version ?? null,
          observation.effectivePolicy?.filesystem ?? null,
          observation.effectivePolicy?.network ?? null,
          observation.effectivePolicy?.environment ?? null,
          observation.observedAt,
          observation.recordedAt,
        );
      } else {
        this.database.prepare(`
          INSERT INTO execution_observations
            (id, dispatch_id, attempt_id, source, source_event_id, kind, correlation,
             correlated_dispatch_id, runtime_session_id, external_reference, message,
             output_summary, observed_at, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(...common, observation.observedAt, observation.recordedAt);
      }
      if (this.supportsProjectInputs) {
        this.database.prepare('UPDATE execution_observations SET effective_input_read = ? WHERE id = ?')
          .run(observation.effectiveCapabilities?.inputRead === undefined
            ? null : observation.effectiveCapabilities.inputRead ? 1 : 0, observation.id);
      }
      return true;
    } catch (error) {
      const raced = this.database.prepare(`
        SELECT id FROM execution_observations
        WHERE id = ? OR (dispatch_id = ? AND source = ? AND source_event_id = ?)
        LIMIT 1
      `).get(
        observation.id,
        observation.dispatchId,
        observation.source,
        observation.sourceEventId,
      );
      if (raced) return false;
      throw new Error(`Could not append Execution Observation ${observation.id}: ${(error as Error).message}`);
    }
  }

  async listExecutionObservationsForDispatch(
    dispatchId: string,
  ): Promise<readonly DurableExecutionObservation[]> {
    this.assertOpen();
    return (this.database.prepare(`
      SELECT * FROM execution_observations
      WHERE dispatch_id = ? ORDER BY observed_at, id
    `).all(dispatchId) as ExecutionObservationRow[]).map(toExecutionObservation);
  }

  async createAttemptOutcomeDecision(decision: DurableAttemptOutcomeDecision): Promise<void> {
    this.assertOpen();
    try {
      this.database.prepare(`
        INSERT INTO attempt_outcome_decisions
          (id, attempt_id, dispatch_id, outcome, source, summary, reason,
           evidence_observation_id, override_without_exact_evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decision.id,
        decision.attemptId,
        decision.dispatchId,
        decision.outcome,
        decision.source,
        decision.summary ?? null,
        decision.reason ?? null,
        decision.evidenceObservationId ?? null,
        decision.overrideWithoutExactCompletionEvidence ? 1 : 0,
        decision.createdAt,
      );
    } catch (error) {
      throw new Error(`Could not create Attempt Outcome Decision ${decision.id}: ${(error as Error).message}`);
    }
  }

  async getAttemptOutcomeDecision(attemptId: string): Promise<DurableAttemptOutcomeDecision | null> {
    this.assertOpen();
    const row = this.database.prepare('SELECT * FROM attempt_outcome_decisions WHERE attempt_id = ?')
      .get(attemptId) as AttemptOutcomeDecisionRow | undefined;
    return row ? toAttemptOutcomeDecision(row) : null;
  }

  async createAttemptReview(review: DurableAttemptReview): Promise<void> {
    this.assertOpen();
    if (!this.supportsOrchestration) throw new Error('Attempt Reviews require Agent Operations schema v9');
    requireNonEmpty(review.summary, 'Attempt Review summary');
    if (!review.id.startsWith('review:')) throw new Error(`Invalid Attempt Review ID: ${review.id}`);
    if (review.decision === 'REVISION_REQUIRED' && !review.feedback?.trim()) {
      throw new Error('Revision-required review needs concrete feedback');
    }
    const worker = this.database.prepare('SELECT * FROM job_attempts WHERE id = ?')
      .get(review.workerAttemptId) as AttemptRow | undefined;
    const reviewer = this.database.prepare('SELECT * FROM job_attempts WHERE id = ?')
      .get(review.reviewerAttemptId) as AttemptRow | undefined;
    if (!worker || !reviewer || worker.job_id !== review.jobId || reviewer.job_id !== review.jobId
      || worker.execution_role !== 'worker' || reviewer.execution_role !== 'reviewer'
      || reviewer.runtime_agent_id !== review.reviewerRuntimeAgentId) {
      throw new Error(`Invalid Attempt Review associations: ${review.id}`);
    }
    try {
      this.database.prepare(`
        INSERT INTO attempt_reviews
          (id, job_id, worker_attempt_id, reviewer_attempt_id,
           reviewer_runtime_agent_id, decision, summary, feedback, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        review.id,
        review.jobId,
        review.workerAttemptId,
        review.reviewerAttemptId,
        review.reviewerRuntimeAgentId,
        review.decision,
        review.summary,
        review.feedback ?? null,
        review.createdAt,
      );
    } catch (error) {
      throw new Error(`Could not create Attempt Review ${review.id}: ${(error as Error).message}`);
    }
  }

  async getAttemptReviewForWorkerAttempt(workerAttemptId: string): Promise<DurableAttemptReview | null> {
    this.assertOpen();
    if (!this.supportsOrchestration) return null;
    const row = this.database.prepare('SELECT * FROM attempt_reviews WHERE worker_attempt_id = ?')
      .get(workerAttemptId) as AttemptReviewRow | undefined;
    return row ? toAttemptReview(row) : null;
  }

  async listAttemptReviewsForJob(jobId: string): Promise<readonly DurableAttemptReview[]> {
    this.assertOpen();
    if (!this.supportsOrchestration) return [];
    return (this.database.prepare(`
      SELECT * FROM attempt_reviews WHERE job_id = ? ORDER BY created_at, id
    `).all(jobId) as AttemptReviewRow[]).map(toAttemptReview);
  }

  async createEscalation(escalation: DurableEscalation): Promise<void> {
    this.assertOpen();
    if (!this.supportsOrchestration) throw new Error('Escalations require Agent Operations schema v9');
    requireNonEmpty(escalation.summary, 'Escalation summary');
    if (!escalation.id.startsWith('escalation:')) {
      throw new Error(`Invalid Escalation ID: ${escalation.id}`);
    }
    const job = this.database.prepare('SELECT 1 FROM jobs WHERE id = ?').get(escalation.jobId);
    if (!job) throw new Error(`Unknown Job for Escalation: ${escalation.jobId}`);
    if (escalation.attemptId) {
      const attempt = this.database.prepare('SELECT job_id FROM job_attempts WHERE id = ?')
        .get(escalation.attemptId) as { job_id: string } | undefined;
      if (attempt?.job_id !== escalation.jobId) {
        throw new Error(`Invalid Escalation Attempt association: ${escalation.id}`);
      }
    }
    if (escalation.reviewId) {
      const review = this.database.prepare('SELECT job_id FROM attempt_reviews WHERE id = ?')
        .get(escalation.reviewId) as { job_id: string } | undefined;
      if (review?.job_id !== escalation.jobId) {
        throw new Error(`Invalid Escalation Review association: ${escalation.id}`);
      }
    }
    try {
      this.database.prepare(`
        INSERT INTO escalations
          (id, job_id, attempt_id, review_id, reason, summary, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        escalation.id,
        escalation.jobId,
        escalation.attemptId ?? null,
        escalation.reviewId ?? null,
        escalation.reason,
        escalation.summary,
        escalation.createdAt,
        escalation.resolvedAt ?? null,
      );
    } catch (error) {
      throw new Error(`Could not create Escalation ${escalation.id}: ${(error as Error).message}`);
    }
  }

  async getEscalation(id: string): Promise<DurableEscalation | null> {
    this.assertOpen();
    if (!this.supportsOrchestration) return null;
    const row = this.database.prepare('SELECT * FROM escalations WHERE id = ?')
      .get(id) as EscalationRow | undefined;
    return row ? toEscalation(row) : null;
  }

  async listEscalations(
    jobId?: string,
    unresolvedOnly = false,
  ): Promise<readonly DurableEscalation[]> {
    this.assertOpen();
    if (!this.supportsOrchestration) return [];
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (jobId) {
      clauses.push('job_id = ?');
      parameters.push(jobId);
    }
    if (unresolvedOnly) clauses.push('resolved_at IS NULL');
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return (this.database.prepare(
      `SELECT * FROM escalations${where} ORDER BY created_at, id`,
    ).all(...parameters) as EscalationRow[]).map(toEscalation);
  }

  async resolveEscalation(
    id: string,
    resolvedAt: string,
    resolutionSummary?: string,
  ): Promise<DurableEscalation> {
    this.assertOpen();
    if (!this.supportsDailyOperator) throw new Error('Escalation resolution requires Agent Operations schema v10');
    requireNonEmpty(id, 'Escalation ID');
    requireNonEmpty(resolvedAt, 'Escalation resolution timestamp');
    if (resolutionSummary !== undefined) requireNonEmpty(resolutionSummary, 'Escalation resolution summary');
    if (resolutionSummary !== undefined && !this.supportsLateExecutionReconciliation) {
      throw new Error('Escalation resolution summaries require Agent Operations schema v11');
    }
    const existing = await this.getEscalation(id);
    if (!existing) throw new Error(`Escalation not found: ${id}`);
    if (existing.resolvedAt) {
      if (existing.resolvedAt !== resolvedAt
        || existing.resolutionSummary !== resolutionSummary) {
        throw new Error(`Escalation ${id} is already resolved`);
      }
      return existing;
    }
    const result = this.supportsLateExecutionReconciliation
      ? this.database.prepare(
        'UPDATE escalations SET resolved_at = ?, resolution_summary = ? WHERE id = ? AND resolved_at IS NULL',
      ).run(resolvedAt, resolutionSummary ?? null, id)
      : this.database.prepare(
        'UPDATE escalations SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL',
      ).run(resolvedAt, id);
    if (result.changes !== 1) throw new Error(`Escalation resolution conflict: ${id}`);
    return { ...existing, resolvedAt, ...(resolutionSummary ? { resolutionSummary } : {}) };
  }

  async resolveEscalationAndResumeOperatorRun(
    id: string,
    resolvedAt: string,
    resolutionSummary: string,
    run: DurableOperatorRun,
    expectedRunRevision: number,
  ): Promise<void> {
    this.assertOpen();
    if (!this.supportsLateExecutionReconciliation) throw new Error('Late execution reconciliation requires Agent Operations schema v11');
    requireNonEmpty(resolutionSummary, 'Escalation resolution summary');
    const persist = this.database.transaction(() => {
      const escalation = this.database.prepare('SELECT job_id, resolved_at FROM escalations WHERE id = ?')
        .get(id) as { job_id: string; resolved_at: string | null } | undefined;
      const existingRun = this.database.prepare('SELECT * FROM operator_runs WHERE id = ?')
        .get(run.id) as OperatorRunRow | undefined;
      if (!escalation || escalation.resolved_at || escalation.job_id !== run.jobId) {
        throw new Error(`Escalation resolution conflict: ${id}`);
      }
      if (!existingRun || existingRun.revision !== expectedRunRevision
        || run.revision !== expectedRunRevision + 1
        || existingRun.job_id !== run.jobId
        || !isValidOperatorRunTransition(existingRun.status, run.status)) {
        throw new Error(`Operator Run transition conflict: ${run.id}`);
      }
      const resolution = this.database.prepare(
        'UPDATE escalations SET resolved_at = ?, resolution_summary = ? WHERE id = ? AND resolved_at IS NULL',
      ).run(resolvedAt, resolutionSummary, id);
      if (resolution.changes !== 1) throw new Error(`Escalation resolution conflict: ${id}`);
      const transition = this.database.prepare(`
        UPDATE operator_runs
        SET status = ?, failure_message = ?, revision = ?, updated_at = ?, started_at = ?, finished_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        run.status, run.failureMessage ?? null, run.revision, run.updatedAt,
        run.startedAt ?? null, run.finishedAt ?? null, run.id, expectedRunRevision,
      );
      if (transition.changes !== 1) throw new Error(`Operator Run transition conflict: ${run.id}`);
    });
    persist();
  }

  async resolveEscalationAndCreateEscalation(
    id: string,
    resolvedAt: string,
    resolutionSummary: string,
    replacement: DurableEscalation,
  ): Promise<void> {
    this.assertOpen();
    if (!this.supportsLateExecutionReconciliation) throw new Error('Late execution reconciliation requires Agent Operations schema v11');
    requireNonEmpty(resolutionSummary, 'Escalation resolution summary');
    requireNonEmpty(replacement.summary, 'Replacement Escalation summary');
    if (!replacement.id.startsWith('escalation:')) {
      throw new Error(`Invalid replacement Escalation ID: ${replacement.id}`);
    }
    const persist = this.database.transaction(() => {
      const existing = this.database.prepare('SELECT job_id, resolved_at FROM escalations WHERE id = ?')
        .get(id) as { job_id: string; resolved_at: string | null } | undefined;
      if (!existing || existing.resolved_at || existing.job_id !== replacement.jobId
        || replacement.resolvedAt) throw new Error(`Escalation resolution conflict: ${id}`);
      if (replacement.attemptId) {
        const attempt = this.database.prepare('SELECT job_id FROM job_attempts WHERE id = ?')
          .get(replacement.attemptId) as { job_id: string } | undefined;
        if (attempt?.job_id !== replacement.jobId) {
          throw new Error(`Invalid replacement Escalation Attempt association: ${replacement.id}`);
        }
      }
      const resolution = this.database.prepare(
        'UPDATE escalations SET resolved_at = ?, resolution_summary = ? WHERE id = ? AND resolved_at IS NULL',
      ).run(resolvedAt, resolutionSummary, id);
      if (resolution.changes !== 1) throw new Error(`Escalation resolution conflict: ${id}`);
      this.database.prepare(`
        INSERT INTO escalations
          (id, job_id, attempt_id, review_id, reason, summary, created_at, resolved_at, resolution_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        replacement.id, replacement.jobId, replacement.attemptId ?? null,
        replacement.reviewId ?? null, replacement.reason, replacement.summary, replacement.createdAt,
      );
    });
    persist();
  }

  async createOperatorRun(run: DurableOperatorRun): Promise<void> {
    this.assertOpen();
    if (!this.supportsDailyOperator) throw new Error('Operator Runs require Agent Operations schema v10');
    if (!run.id.startsWith('operator-run:') || run.status !== 'pending' || run.revision !== 0) {
      throw new Error(`Invalid new Operator Run: ${run.id}`);
    }
    try {
      this.database.prepare(`
        INSERT INTO operator_runs
          (id, job_id, status, failure_message, revision, created_at, updated_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id, run.jobId, run.status, run.failureMessage ?? null, run.revision,
        run.createdAt, run.updatedAt, run.startedAt ?? null, run.finishedAt ?? null,
      );
    } catch (error) {
      throw new Error(`Could not create Operator Run ${run.id}: ${(error as Error).message}`);
    }
  }

  async getOperatorRun(id: string): Promise<DurableOperatorRun | null> {
    this.assertOpen();
    if (!this.supportsDailyOperator) return null;
    const row = this.database.prepare('SELECT * FROM operator_runs WHERE id = ?')
      .get(id) as OperatorRunRow | undefined;
    return row ? toOperatorRun(row) : null;
  }

  async getOperatorRunForJob(jobId: string): Promise<DurableOperatorRun | null> {
    this.assertOpen();
    if (!this.supportsDailyOperator) return null;
    const row = this.database.prepare('SELECT * FROM operator_runs WHERE job_id = ?')
      .get(jobId) as OperatorRunRow | undefined;
    return row ? toOperatorRun(row) : null;
  }

  async listOperatorRuns(): Promise<readonly DurableOperatorRun[]> {
    this.assertOpen();
    if (!this.supportsDailyOperator) return [];
    return (this.database.prepare('SELECT * FROM operator_runs ORDER BY created_at, id')
      .all() as OperatorRunRow[]).map(toOperatorRun);
  }

  async saveOperatorRunTransition(run: DurableOperatorRun, expectedRevision: number): Promise<void> {
    this.assertOpen();
    if (!this.supportsDailyOperator) throw new Error('Operator Runs require Agent Operations schema v10');
    const existing = await this.getOperatorRun(run.id);
    if (!existing || existing.revision !== expectedRevision || run.revision !== expectedRevision + 1
      || existing.jobId !== run.jobId || !isValidOperatorRunTransition(existing.status, run.status)) {
      throw new Error(`Invalid Operator Run transition: ${run.id}`);
    }
    const result = this.database.prepare(`
      UPDATE operator_runs
      SET status = ?, failure_message = ?, revision = ?, updated_at = ?, started_at = ?, finished_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      run.status, run.failureMessage ?? null, run.revision, run.updatedAt,
      run.startedAt ?? null, run.finishedAt ?? null, run.id, expectedRevision,
    );
    if (result.changes !== 1) throw new Error(`Operator Run transition conflict: ${run.id}`);
  }

  async createHumanGuidanceAndResolveEscalation(
    guidance: DurableHumanGuidance,
    resolvedAt: string,
  ): Promise<void> {
    this.assertOpen();
    if (!this.supportsDailyOperator) throw new Error('Human Guidance requires Agent Operations schema v10');
    requireNonEmpty(guidance.instruction, 'Human Guidance instruction');
    if (guidance.instruction.length > 4_096 || !guidance.id.startsWith('guidance:')) {
      throw new Error(`Invalid Human Guidance: ${guidance.id}`);
    }
    const persist = this.database.transaction(() => {
      const escalation = this.database.prepare('SELECT job_id, resolved_at FROM escalations WHERE id = ?')
        .get(guidance.escalationId) as { job_id: string; resolved_at: string | null } | undefined;
      if (!escalation || escalation.job_id !== guidance.jobId || escalation.resolved_at) {
        throw new Error(`Invalid Human Guidance association: ${guidance.id}`);
      }
      this.database.prepare(`
        INSERT INTO human_guidance (id, job_id, escalation_id, instruction, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(guidance.id, guidance.jobId, guidance.escalationId, guidance.instruction, guidance.createdAt);
      const update = this.database.prepare(
        'UPDATE escalations SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL',
      ).run(resolvedAt, guidance.escalationId);
      if (update.changes !== 1) throw new Error(`Escalation resolution conflict: ${guidance.escalationId}`);
    });
    try {
      persist();
    } catch (error) {
      throw new Error(`Could not persist Human Guidance ${guidance.id}: ${(error as Error).message}`);
    }
  }

  async createHumanGuidanceAndResumeOperatorRun(
    guidance: DurableHumanGuidance,
    resolvedAt: string,
    run: DurableOperatorRun,
    expectedRunRevision: number,
  ): Promise<void> {
    this.assertOpen();
    if (!this.supportsDailyOperator) throw new Error('Human Guidance requires Agent Operations schema v10');
    requireNonEmpty(guidance.instruction, 'Human Guidance instruction');
    if (guidance.instruction.length > 4_096 || !guidance.id.startsWith('guidance:')) {
      throw new Error(`Invalid Human Guidance: ${guidance.id}`);
    }
    const persist = this.database.transaction(() => {
      const escalation = this.database.prepare('SELECT job_id, resolved_at FROM escalations WHERE id = ?')
        .get(guidance.escalationId) as { job_id: string; resolved_at: string | null } | undefined;
      const runRow = this.database.prepare('SELECT * FROM operator_runs WHERE id = ?')
        .get(run.id) as OperatorRunRow | undefined;
      const existingRun = runRow ? toOperatorRun(runRow) : null;
      if (!escalation || escalation.job_id !== guidance.jobId || escalation.resolved_at) {
        throw new Error(`Invalid Human Guidance association: ${guidance.id}`);
      }
      if (!existingRun || existingRun.jobId !== guidance.jobId
        || existingRun.revision !== expectedRunRevision || run.revision !== expectedRunRevision + 1
        || !isValidOperatorRunTransition(existingRun.status, run.status)) {
        throw new Error(`Operator Run transition conflict: ${run.id}`);
      }
      this.database.prepare(`
        INSERT INTO human_guidance (id, job_id, escalation_id, instruction, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(guidance.id, guidance.jobId, guidance.escalationId, guidance.instruction, guidance.createdAt);
      const escalationUpdate = this.database.prepare(
        'UPDATE escalations SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL',
      ).run(resolvedAt, guidance.escalationId);
      if (escalationUpdate.changes !== 1) {
        throw new Error(`Escalation resolution conflict: ${guidance.escalationId}`);
      }
      const runUpdate = this.database.prepare(`
        UPDATE operator_runs
        SET status = ?, failure_message = ?, revision = ?, updated_at = ?, started_at = ?, finished_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        run.status, run.failureMessage ?? null, run.revision, run.updatedAt,
        run.startedAt ?? null, run.finishedAt ?? null, run.id, expectedRunRevision,
      );
      if (runUpdate.changes !== 1) throw new Error(`Operator Run transition conflict: ${run.id}`);
    });
    try {
      persist();
    } catch (error) {
      throw new Error(`Could not persist Human Guidance ${guidance.id}: ${(error as Error).message}`);
    }
  }

  async listHumanGuidance(jobId: string): Promise<readonly DurableHumanGuidance[]> {
    this.assertOpen();
    if (!this.supportsDailyOperator) return [];
    return (this.database.prepare(
      'SELECT * FROM human_guidance WHERE job_id = ? ORDER BY created_at, id',
    ).all(jobId) as HumanGuidanceRow[]).map(toHumanGuidance);
  }

  async authorizeWorkerBudgetExtensionAndResumeOperatorRun(
    extension: DurableWorkerBudgetExtension,
    guidance: DurableHumanGuidance | null,
    resolvedAt: string,
    resolutionSummary: string,
    run: DurableOperatorRun,
    expectedRunRevision: number,
  ): Promise<void> {
    this.assertOpen();
    if (!this.supportsWorkerBudgetExtensions) {
      throw new Error('Worker Budget Extensions require Agent Operations schema v14');
    }
    requireNonEmpty(resolutionSummary, 'Escalation resolution summary');
    if (!extension.id.startsWith('worker-budget-extension:')
      || extension.additionalWorkerExecutions !== 1) {
      throw new Error(`Invalid Worker Budget Extension: ${extension.id}`);
    }
    if (guidance && (!guidance.id.startsWith('guidance:')
      || guidance.jobId !== extension.jobId
      || guidance.escalationId !== extension.escalationId
      || !guidance.instruction.trim()
      || guidance.instruction.length > 4_096)) {
      throw new Error(`Invalid Human Guidance association: ${guidance.id}`);
    }
    const persist = this.database.transaction(() => {
      const escalation = this.database.prepare('SELECT job_id, resolved_at FROM escalations WHERE id = ?')
        .get(extension.escalationId) as { job_id: string; resolved_at: string | null } | undefined;
      const runRow = this.database.prepare('SELECT * FROM operator_runs WHERE id = ?')
        .get(run.id) as OperatorRunRow | undefined;
      const existingRun = runRow ? toOperatorRun(runRow) : null;
      if (!escalation || escalation.job_id !== extension.jobId || escalation.resolved_at) {
        throw new Error(`Invalid Worker Budget Extension association: ${extension.id}`);
      }
      if (!existingRun || existingRun.jobId !== extension.jobId
        || existingRun.revision !== expectedRunRevision || run.revision !== expectedRunRevision + 1
        || !isValidOperatorRunTransition(existingRun.status, run.status)) {
        throw new Error(`Operator Run transition conflict: ${run.id}`);
      }
      this.database.prepare(`
        INSERT INTO worker_budget_extensions
          (id, job_id, escalation_id, additional_worker_executions, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        extension.id,
        extension.jobId,
        extension.escalationId,
        extension.additionalWorkerExecutions,
        extension.createdAt,
      );
      if (guidance) {
        this.database.prepare(`
          INSERT INTO human_guidance (id, job_id, escalation_id, instruction, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(guidance.id, guidance.jobId, guidance.escalationId, guidance.instruction, guidance.createdAt);
      }
      const escalationUpdate = this.database.prepare(`
        UPDATE escalations
        SET resolved_at = ?, resolution_summary = ?
        WHERE id = ? AND resolved_at IS NULL
      `).run(resolvedAt, resolutionSummary, extension.escalationId);
      if (escalationUpdate.changes !== 1) {
        throw new Error(`Escalation resolution conflict: ${extension.escalationId}`);
      }
      const runUpdate = this.database.prepare(`
        UPDATE operator_runs
        SET status = ?, failure_message = ?, revision = ?, updated_at = ?, started_at = ?, finished_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        run.status, run.failureMessage ?? null, run.revision, run.updatedAt,
        run.startedAt ?? null, run.finishedAt ?? null, run.id, expectedRunRevision,
      );
      if (runUpdate.changes !== 1) throw new Error(`Operator Run transition conflict: ${run.id}`);
    });
    try {
      persist();
    } catch (error) {
      throw new Error(`Could not persist Worker Budget Extension ${extension.id}: ${(error as Error).message}`);
    }
  }

  async listWorkerBudgetExtensions(jobId: string): Promise<readonly DurableWorkerBudgetExtension[]> {
    this.assertOpen();
    if (!this.supportsWorkerBudgetExtensions) return [];
    return (this.database.prepare(`
      SELECT id, job_id, escalation_id, additional_worker_executions, created_at
      FROM worker_budget_extensions
      WHERE job_id = ?
      ORDER BY created_at, id
    `).all(jobId) as WorkerBudgetExtensionRow[]).map(toWorkerBudgetExtension);
  }

  async createOperatorNotificationDelivery(
    delivery: DurableOperatorNotificationDelivery,
  ): Promise<boolean> {
    this.assertOpen();
    if (!this.supportsDailyOperator) throw new Error('Operator Notifications require Agent Operations schema v10');
    if (!delivery.id.startsWith('notification-delivery:')
      || delivery.status !== 'pending' || delivery.revision !== 0) {
      throw new Error(`Invalid new Operator Notification Delivery: ${delivery.id}`);
    }
    try {
      this.database.prepare(`
        INSERT INTO operator_notification_deliveries
          (id, event_key, kind, job_id, escalation_id, status, message,
           revision, created_at, updated_at, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        delivery.id, delivery.eventKey, delivery.kind, delivery.jobId,
        delivery.escalationId ?? null, delivery.status, delivery.message ?? null,
        delivery.revision, delivery.createdAt, delivery.updatedAt, delivery.attemptedAt ?? null,
      );
      return true;
    } catch (error) {
      const existing = await this.getOperatorNotificationDeliveryByEventKey(delivery.eventKey);
      if (existing) return false;
      throw new Error(`Could not create Operator Notification Delivery ${delivery.id}: ${(error as Error).message}`);
    }
  }

  async getOperatorNotificationDeliveryByEventKey(
    eventKey: string,
  ): Promise<DurableOperatorNotificationDelivery | null> {
    this.assertOpen();
    if (!this.supportsDailyOperator) return null;
    const row = this.database.prepare(
      'SELECT * FROM operator_notification_deliveries WHERE event_key = ?',
    ).get(eventKey) as OperatorNotificationDeliveryRow | undefined;
    return row ? toOperatorNotificationDelivery(row) : null;
  }

  async listOperatorNotificationDeliveries(
    jobId?: string,
  ): Promise<readonly DurableOperatorNotificationDelivery[]> {
    this.assertOpen();
    if (!this.supportsDailyOperator) return [];
    const rows = jobId
      ? this.database.prepare(
        'SELECT * FROM operator_notification_deliveries WHERE job_id = ? ORDER BY created_at, id',
      ).all(jobId)
      : this.database.prepare(
        'SELECT * FROM operator_notification_deliveries ORDER BY created_at, id',
      ).all();
    return (rows as OperatorNotificationDeliveryRow[]).map(toOperatorNotificationDelivery);
  }

  async saveOperatorNotificationDeliveryTransition(
    delivery: DurableOperatorNotificationDelivery,
    expectedRevision: number,
  ): Promise<void> {
    this.assertOpen();
    if (!this.supportsDailyOperator) throw new Error('Operator Notifications require Agent Operations schema v10');
    if (delivery.status === 'pending' || delivery.revision !== expectedRevision + 1
      || !delivery.attemptedAt) {
      throw new Error(`Invalid Operator Notification transition: ${delivery.id}`);
    }
    const result = this.database.prepare(`
      UPDATE operator_notification_deliveries
      SET status = ?, message = ?, revision = ?, updated_at = ?, attempted_at = ?
      WHERE id = ? AND revision = ? AND status = 'pending'
    `).run(
      delivery.status, delivery.message ?? null, delivery.revision,
      delivery.updatedAt, delivery.attemptedAt, delivery.id, expectedRevision,
    );
    if (result.changes !== 1) {
      throw new Error(`Operator Notification transition conflict: ${delivery.id}`);
    }
  }

  async close(): Promise<void> {
    this.assertOpen();
    this.database.close();
    this.closed = true;
  }

  private validateConfiguration(configuration: DurableProjectConfiguration): void {
    const { project, repositories, checkoutBindings, runtimeAgentIds } = configuration;
    requireNonEmpty(project.id, 'Project ID');
    requireNonEmpty(project.name, 'Project name');
    rejectDuplicates(repositories.map(item => item.id), 'repository ID');
    rejectDuplicates(checkoutBindings.map(item => item.id), 'checkout binding ID');
    rejectDuplicates(runtimeAgentIds, 'runtime agent ID');
    const repositoryIds = new Set(repositories.map(item => item.id));
    const installation = this.database.prepare('SELECT id FROM installations LIMIT 1').get() as { id: string };
    for (const repository of repositories) {
      if (repository.identityKind === 'remote'
        && (!repository.canonicalRemote || repository.id !== `remote:${repository.canonicalRemote}`)) {
        throw new Error(`Remote repository ${repository.id} has inconsistent canonical identity`);
      }
      if (repository.identityKind === 'local'
        && (!repository.id.startsWith('local:') || repository.canonicalRemote !== undefined)) {
        throw new Error(`Local repository ${repository.id} has inconsistent local identity`);
      }
    }
    for (const binding of checkoutBindings) {
      if (!repositoryIds.has(binding.repositoryId)) {
        throw new Error(`Checkout ${binding.id} references unknown repository ${binding.repositoryId}`);
      }
      if (binding.installationId !== installation.id) {
        throw new Error(`Checkout ${binding.id} belongs to another installation`);
      }
      if (binding.id !== createRepositoryCheckoutBindingId(binding.installationId, binding.canonicalPath)) {
        throw new Error(`Checkout binding ID does not match its installation and path: ${binding.id}`);
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Agent Operations state store is closed');
  }
}
