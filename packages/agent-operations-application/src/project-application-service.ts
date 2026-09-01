import { randomUUID } from 'node:crypto';
import type {
  AgentOperationsStateStore,
  DurableProject,
  DurableProjectProfile,
  ProjectCapabilityReadiness,
  ProjectResourceInspectionAdapter,
  RepositoryInventoryAdapter,
} from '../../agent-operations-contracts/src/index.js';
import {
  createLocalFolderResourceId,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import type {
  CreateProjectInput,
  ProjectApplication,
  ProjectOnboardingResult,
} from './types.js';

export interface ProjectApplicationServiceOptions {
  readonly now?: () => Date;
  readonly projectIdFactory?: () => string;
  readonly runtimeAgentIds?: readonly string[];
}

/** Creates provider neutral Projects while reusing AO's existing Git identity model. */
export class ProjectApplicationService implements ProjectApplication {
  private readonly now: () => Date;
  private readonly projectIdFactory: () => string;
  private readonly runtimeAgentIds: readonly string[];

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly repositories: RepositoryInventoryAdapter,
    private readonly resources: ProjectResourceInspectionAdapter,
    options: ProjectApplicationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.projectIdFactory = options.projectIdFactory ?? (() => `project:${randomUUID()}`);
    this.runtimeAgentIds = [...new Set(options.runtimeAgentIds ?? [])];
  }

  async createProject(input: CreateProjectInput): Promise<ProjectOnboardingResult> {
    const name = required(input.name, 'Project name', 200);
    const description = input.description?.trim();
    if (description && description.length > 2_000) throw new Error('Project description exceeds 2000 characters');
    const id = this.projectIdFactory();
    const now = this.now().toISOString();
    const project: DurableProject = {
      id,
      name,
      ...(description ? { description } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const installation = await this.store.getInstallation();
    let repositories: ProjectOnboardingResult['repositories'] = [];
    let checkoutBindings: Parameters<AgentOperationsStateStore['applyProjectConfiguration']>[0]['checkoutBindings'] = [];
    let localFolder = null;
    let inspectedProfile = null;
    let repositoryObservation = null;

    if (input.resource.type === 'git-repository') {
      const summary = await this.repositories.inspectRepository(required(input.resource.path, 'Repository path', 4_096));
      if (!summary.repositoryRoot || summary.availability === 'unavailable' || summary.availability === 'not-a-repository') {
        throw new Error(summary.reason ?? 'The selected path is not an available Git repository');
      }
      repositories = [{
        id: summary.id,
        identityKind: summary.identityKind,
        name: summary.name,
        ...(summary.primaryRemote?.identity ? { canonicalRemote: summary.primaryRemote.identity.canonical } : {}),
        createdAt: now,
        updatedAt: now,
      }];
      checkoutBindings = [{
        id: createRepositoryCheckoutBindingId(installation.id, summary.repositoryRoot),
        repositoryId: summary.id,
        installationId: installation.id,
        canonicalPath: summary.repositoryRoot,
        availability: summary.availability,
        firstSeenAt: now,
        lastSeenAt: now,
      }];
      inspectedProfile = await this.resources.inspectLocalFolder(summary.repositoryRoot);
      repositoryObservation = {
        repositoryId: summary.id,
        checkoutBindingId: checkoutBindings[0]!.id,
        availability: summary.availability,
        ...(summary.branch ? { branch: summary.branch } : {}),
        detachedHead: summary.detachedHead,
        ...(summary.headCommit ? { headCommit: summary.headCommit } : {}),
        workingTree: summary.workingTree,
        ...(summary.reason ? { reason: summary.reason } : {}),
        observedAt: summary.observedAt,
      };
    } else if (input.resource.type === 'local-folder') {
      inspectedProfile = await this.resources.inspectLocalFolder(required(input.resource.path, 'Folder path', 4_096));
      if (!inspectedProfile.readable) throw new Error('The selected folder is not readable');
      localFolder = {
        id: createLocalFolderResourceId(installation.id, inspectedProfile.canonicalPath),
        projectId: id,
        installationId: installation.id,
        canonicalPath: inspectedProfile.canonicalPath,
        fingerprint: inspectedProfile.fingerprint,
        availability: 'available' as const,
        firstSeenAt: now,
        lastSeenAt: now,
      };
    }

    await this.store.applyProjectConfiguration({
      project, repositories, checkoutBindings,
      runtimeAgentIds: input.resource.type === 'git-repository' ? this.runtimeAgentIds : [],
    });
    if (repositoryObservation) await this.store.recordRepositoryObservation(repositoryObservation);
    if (localFolder) await this.store.createLocalFolderResource(localFolder);
    const profile = buildProfile(id, input.resource.type, inspectedProfile, now);
    await this.store.saveProjectProfile(profile);
    return {
      project,
      repositories,
      localFolders: localFolder ? [localFolder] : [],
      profile,
    };
  }

  async getProject(projectId: string): Promise<ProjectOnboardingResult> {
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const repositories = (await Promise.all(
      (await this.store.listProjectRepositoryIds(projectId)).map(id => this.store.getRepository(id)),
    )).filter(value => value !== null);
    const localFolders = await this.store.listLocalFolderResources(projectId);
    const profile = await this.store.getProjectProfile(projectId);
    if (!profile) throw new Error(`Project Profile not found: ${projectId}`);
    return { project, repositories, localFolders, profile };
  }

  async listProjects(): Promise<readonly ProjectOnboardingResult[]> {
    return Promise.all((await this.store.listProjects()).map(project => this.getProject(project.id)));
  }
}

function buildProfile(
  projectId: string,
  resourceType: CreateProjectInput['resource']['type'],
  inspection: Awaited<ReturnType<ProjectResourceInspectionAdapter['inspectLocalFolder']>> | null,
  inspectedAt: string,
): DurableProjectProfile {
  const hasRepository = resourceType === 'git-repository';
  const hasFolder = resourceType !== 'none';
  const capabilities: ProjectCapabilityReadiness = {
    repositoryReadOnlyJobs: hasRepository ? 'available' : 'unavailable',
    isolatedCodeChangeJobs: hasRepository ? 'available' : 'unavailable',
    boundedFileInspection: hasFolder ? 'available' : 'unavailable',
    inputs: 'available',
    orchestratorConversation: 'available',
    build: inspection?.profile.buildCommandCandidates.length ? 'detected-unvalidated' : 'unknown',
    preview: inspection?.profile.previewCommandCandidates.length ? 'detected-unvalidated' : 'unknown',
    publish: inspection?.profile.deploymentClues.length ? 'detected-unvalidated' : 'unknown',
  };
  return {
    projectId,
    resourceSummary: resourceType === 'git-repository'
      ? 'Existing Git repository'
      : resourceType === 'local-folder' ? 'Existing local folder' : 'No resource attached',
    detectedStack: inspection?.profile.detectedStack ?? [],
    ...(inspection?.profile.packageManager ? { packageManager: inspection.profile.packageManager } : {}),
    buildCommandCandidates: inspection?.profile.buildCommandCandidates ?? [],
    testCommandCandidates: inspection?.profile.testCommandCandidates ?? [],
    previewCommandCandidates: inspection?.profile.previewCommandCandidates ?? [],
    deploymentClues: inspection?.profile.deploymentClues ?? [],
    documentation: inspection?.profile.documentation ?? [],
    capabilities,
    warnings: inspection?.profile.warnings ?? [],
    knownConstraints: inspection?.profile.knownConstraints ?? [],
    agentsFileSuggestion: inspection?.profile.agentsFileSuggestion ?? hasFolder,
    inspectedAt,
    revision: 0,
  };
}

function required(value: string, field: string, maximum: number): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required`);
  if (result.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return result;
}
