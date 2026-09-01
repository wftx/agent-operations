import { randomUUID } from 'node:crypto';
import type {
  AgentOperationsStateStore,
  DurableProject,
  DurableProjectProfile,
  DurableRepositoryObservation,
  ProjectCapabilityReadiness,
  ProjectResourceInspectionAdapter,
  RepositoryInventoryAdapter,
  RepositorySummary,
} from '../../agent-operations-contracts/src/index.js';
import {
  createLocalFolderResourceId,
  createRepositoryCheckoutBindingId,
} from '../../agent-operations-contracts/src/index.js';
import type {
  CreateProjectInput,
  ProjectApplication,
  ProjectOnboardingResult,
  ProjectRepositoryReadiness,
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
    let repositoryObservation: DurableRepositoryObservation | null = null;
    let repositoryReadiness: ProjectRepositoryReadiness[] = [];
    let hasRepository = false;
    let repositoryCapabilitiesAvailable = false;

    if (input.resource.type !== 'none') {
      inspectedProfile = await this.resources.inspectLocalFolder(required(input.resource.path, 'Folder path', 4_096));
      if (!inspectedProfile.readable) throw new Error('The selected folder is not readable');
      const summary = await this.repositories.inspectRepository(inspectedProfile.canonicalPath);
      if (summary.availability === 'unavailable') {
        throw new Error(summary.reason ?? 'The selected folder became unavailable during Git detection');
      }
      if (summary.availability === 'degraded' && !summary.repositoryRoot) {
        throw new Error(summary.reason ?? 'AO could not determine whether the selected folder uses Git');
      }
      hasRepository = Boolean(summary.repositoryRoot && summary.availability !== 'not-a-repository');
      repositoryCapabilitiesAvailable = hasRepository && summary.availability === 'available';
      if (input.resource.type === 'git-repository' && !hasRepository) {
        throw new Error(summary.reason ?? 'The selected path is not an available Git repository');
      }
      await this.assertFolderIsNotBound(installation.id, inspectedProfile.canonicalPath);
      if (hasRepository) {
        const repositoryRoot = summary.repositoryRoot!;
        if (repositoryRoot !== inspectedProfile.canonicalPath) {
          await this.assertFolderIsNotBound(installation.id, repositoryRoot);
          inspectedProfile = await this.resources.inspectLocalFolder(repositoryRoot);
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
          id: createRepositoryCheckoutBindingId(installation.id, repositoryRoot),
          repositoryId: summary.id,
          installationId: installation.id,
          canonicalPath: repositoryRoot,
          availability: summary.availability,
          firstSeenAt: now,
          lastSeenAt: now,
        }];
        repositoryObservation = toRepositoryObservation(summary, checkoutBindings[0]!.id);
        repositoryReadiness = [toRepositoryReadiness(summary)];
      } else {
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
    }

    await this.store.applyProjectConfiguration({
      project, repositories, checkoutBindings,
      runtimeAgentIds: hasRepository ? this.runtimeAgentIds : [],
    });
    if (repositoryObservation) await this.store.recordRepositoryObservation(repositoryObservation);
    if (localFolder) await this.store.createLocalFolderResource(localFolder);
    const profile = buildProfile(
      id,
      hasRepository ? 'git-repository' : input.resource.type,
      inspectedProfile,
      now,
      repositoryCapabilitiesAvailable,
    );
    await this.store.saveProjectProfile(profile);
    return {
      project,
      repositories,
      localFolders: localFolder ? [localFolder] : [],
      repositoryReadiness,
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
    const installation = await this.store.getInstallation();
    const repositoryReadiness = await this.readRepositoryReadiness(repositories, installation.id);
    const profile = await this.store.getProjectProfile(projectId);
    if (!profile) throw new Error(`Project Profile not found: ${projectId}`);
    return { project, repositories, localFolders, repositoryReadiness, profile };
  }

  async listProjects(): Promise<readonly ProjectOnboardingResult[]> {
    return Promise.all((await this.store.listProjects()).map(project => this.getProject(project.id)));
  }

  private async assertFolderIsNotBound(installationId: string, canonicalPath: string): Promise<void> {
    const checkout = (await this.store.listCheckoutBindings()).find(binding =>
      binding.installationId === installationId && binding.canonicalPath === canonicalPath);
    if (checkout) throw new Error(`The selected folder is already bound to an Agent Operations Project: ${canonicalPath}`);
    const folder = (await this.store.listLocalFolderResources()).find(resource =>
      resource.installationId === installationId && resource.canonicalPath === canonicalPath);
    if (folder) throw new Error(`The selected folder is already bound to an Agent Operations Project: ${canonicalPath}`);
  }

  private async readRepositoryReadiness(
    repositories: ProjectOnboardingResult['repositories'],
    installationId: string,
  ): Promise<ProjectRepositoryReadiness[]> {
    const results: ProjectRepositoryReadiness[] = [];
    for (const repository of repositories) {
      const bindings = (await this.store.listCheckoutBindings(repository.id))
        .filter(binding => binding.installationId === installationId);
      for (const binding of bindings) {
        const observation = await this.store.getLatestRepositoryObservation(binding.id);
        results.push({
          repositoryId: repository.id,
          canonicalPath: binding.canonicalPath,
          ...(repository.canonicalRemote ? { canonicalRemote: repository.canonicalRemote } : {}),
          availability: observation?.availability ?? binding.availability,
          ...(observation?.branch ? { branch: observation.branch } : {}),
          detachedHead: observation?.detachedHead ?? false,
          ...(observation?.headCommit ? { headCommit: observation.headCommit } : {}),
          workingTree: observation?.workingTree ?? 'unknown',
        });
      }
    }
    return results;
  }
}

function toRepositoryObservation(
  summary: RepositorySummary,
  checkoutBindingId: string,
): DurableRepositoryObservation {
  return {
    repositoryId: summary.id,
    checkoutBindingId,
    availability: summary.availability,
    ...(summary.branch ? { branch: summary.branch } : {}),
    detachedHead: summary.detachedHead,
    ...(summary.headCommit ? { headCommit: summary.headCommit } : {}),
    workingTree: summary.workingTree,
    ...(summary.reason ? { reason: summary.reason } : {}),
    observedAt: summary.observedAt,
  };
}

function toRepositoryReadiness(summary: RepositorySummary): ProjectRepositoryReadiness {
  if (!summary.repositoryRoot) throw new Error('Git repository root is unavailable');
  return {
    repositoryId: summary.id,
    canonicalPath: summary.repositoryRoot,
    ...(summary.primaryRemote?.identity
      ? { canonicalRemote: summary.primaryRemote.identity.canonical }
      : {}),
    availability: summary.availability,
    ...(summary.branch ? { branch: summary.branch } : {}),
    detachedHead: summary.detachedHead,
    ...(summary.headCommit ? { headCommit: summary.headCommit } : {}),
    workingTree: summary.workingTree,
  };
}

function buildProfile(
  projectId: string,
  resourceType: CreateProjectInput['resource']['type'],
  inspection: Awaited<ReturnType<ProjectResourceInspectionAdapter['inspectLocalFolder']>> | null,
  inspectedAt: string,
  repositoryCapabilitiesAvailable = false,
): DurableProjectProfile {
  const hasRepository = resourceType === 'git-repository';
  const hasFolder = resourceType !== 'none';
  const capabilities: ProjectCapabilityReadiness = {
    repositoryReadOnlyJobs: hasRepository && repositoryCapabilitiesAvailable ? 'available' : 'unavailable',
    isolatedCodeChangeJobs: hasRepository && repositoryCapabilitiesAvailable ? 'available' : 'unavailable',
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
      ? 'Git repository detected'
      : resourceType === 'local-folder' ? 'Local folder' : 'No resource attached',
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
