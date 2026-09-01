import type {
  OperatorApplication,
  OperatorJobDetail,
  OperatorProjectOption,
  InputApplication,
  OrchestratorToolRequest,
  OrchestratorToolResult,
} from './types.js';

/** The complete mutable authority exposed to the conversational Orchestrator. */
export class OrchestratorToolApplicationService {
  constructor(
    private readonly operator: OperatorApplication,
    private readonly inputs?: InputApplication,
  ) {}

  async execute(request: OrchestratorToolRequest): Promise<OrchestratorToolResult> {
    try {
      switch (request.name) {
        case 'ao.projects.list':
          return success((await this.operator.listProjects()).slice(0, 100).map(projectView));
        case 'ao.projects.get': {
          const project = await this.requireProject(text(request.arguments, 'projectId'));
          return success(projectView(project));
        }
        case 'ao.inputs.list': {
          if (!this.inputs) throw new Error('Input tools are not configured');
          return success(await this.inputs.listInputs(optionalText(request.arguments, 'projectId')));
        }
        case 'ao.inputs.get': {
          if (!this.inputs) throw new Error('Input tools are not configured');
          return success(await this.inputs.getInput(text(request.arguments, 'inputId')));
        }
        case 'ao.jobs.create':
          return await this.createJob(request.arguments);
        case 'ao.jobs.get': {
          const detail = await this.operator.getJobDetail(text(request.arguments, 'jobId'));
          return success(jobView(detail), [detail.summary.job.id]);
        }
        case 'ao.jobs.list': {
          const projectId = optionalText(request.arguments, 'projectId');
          const jobs = (await this.operator.listJobs('all'))
            .filter(job => !projectId || job.job.projectId === projectId)
            .slice(0, 100)
            .map(job => ({
              jobId: job.job.id,
              projectId: job.job.projectId,
              title: job.job.title,
              state: job.orchestrationState,
              stage: job.currentStage,
              needsHuman: job.needsHuman,
            }));
          return success(jobs, jobs.map(job => job.jobId));
        }
        case 'ao.jobs.status': {
          const detail = await this.operator.getJobDetail(text(request.arguments, 'jobId'));
          return success({
            jobId: detail.summary.job.id,
            title: detail.summary.job.title,
            state: detail.summary.orchestrationState,
            stage: detail.summary.currentStage,
            needsHuman: detail.summary.needsHuman,
            latestReviewDecision: detail.summary.latestReviewDecision,
          }, [detail.summary.job.id]);
        }
      }
    } catch (error) {
      return {
        ok: false,
        error: { code: classify(error), message: error instanceof Error ? error.message : String(error) },
        relatedJobIds: [],
      };
    }
  }

  private async createJob(argumentsValue: Readonly<Record<string, unknown>>): Promise<OrchestratorToolResult> {
    const project = await this.requireProject(text(argumentsValue, 'projectId'));
    const repositoryId = optionalText(argumentsValue, 'repositoryId')
      ?? (project.repositories.length === 1 ? project.repositories[0]!.id : undefined);
    if (!repositoryId) throw new Error('repositoryId is required when a Project has multiple repositories');
    if (argumentsValue['reviewerRequired'] !== undefined && argumentsValue['reviewerRequired'] !== true) {
      throw new Error('reviewerRequired must remain true');
    }
    if (argumentsValue['maxWorkerAttempts'] !== undefined && argumentsValue['maxWorkerAttempts'] !== 2) {
      throw new Error('maxWorkerAttempts must remain 2');
    }
    const executionMode = optionalText(argumentsValue, 'executionMode') ?? 'repository-read-only';
    if (executionMode !== 'repository-read-only' && executionMode !== 'repository-write-isolated') {
      throw new Error('executionMode is not supported');
    }
    const session = await this.operator.runOperatorJob({
      projectId: project.project.id,
      repositoryId,
      title: text(argumentsValue, 'title'),
      task: text(argumentsValue, 'task'),
      acceptanceCriteria: text(argumentsValue, 'acceptanceCriteria'),
      executionMode,
      inputIds: stringArray(argumentsValue, 'inputIds'),
    });
    return success({
      jobId: session.jobId,
      status: session.status,
      link: `/jobs/${encodeURIComponent(session.jobId)}`,
    }, [session.jobId]);
  }

  private async requireProject(projectId: string): Promise<OperatorProjectOption> {
    const project = (await this.operator.listProjects()).find(candidate => candidate.project.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }
}

function projectView(option: OperatorProjectOption) {
  return {
    projectId: option.project.id,
    name: option.project.name,
    runnable: option.runnable,
    unavailableReason: option.unavailableReason,
    repositories: option.repositories.slice(0, 50).map(repository => ({
      repositoryId: repository.id,
      name: repository.name,
      identityKind: repository.identityKind,
      canonicalRemote: repository.canonicalRemote,
    })),
  };
}

function jobView(detail: OperatorJobDetail) {
  return {
    jobId: detail.summary.job.id,
    projectId: detail.summary.job.projectId,
    title: detail.summary.job.title,
    description: detail.summary.job.description,
    acceptanceCriteria: detail.acceptanceCriteria,
    executionMode: detail.summary.job.executionMode,
    state: detail.summary.orchestrationState,
    stage: detail.summary.currentStage,
    needsHuman: detail.summary.needsHuman,
    latestReviewDecision: detail.summary.latestReviewDecision,
    inputs: detail.inputs ?? [],
  };
}

function success(data: unknown, relatedJobIds: readonly string[] = []): OrchestratorToolResult {
  return { ok: true, data, relatedJobIds: [...new Set(relatedJobIds)] };
}

function text(value: Readonly<Record<string, unknown>>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${field} is required`);
  return candidate.trim();
}

function optionalText(value: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const candidate = value[field];
  if (candidate === undefined || candidate === null || candidate === '') return undefined;
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${field} must be text`);
  return candidate.trim();
}

function stringArray(value: Readonly<Record<string, unknown>>, field: string): readonly string[] {
  const candidate = value[field];
  if (candidate === undefined) return [];
  if (!Array.isArray(candidate) || candidate.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be an array of Input IDs`);
  }
  const values = candidate.map(item => (item as string).trim());
  if (new Set(values).size !== values.length) throw new Error(`${field} contains duplicate Input IDs`);
  if (values.length > 20) throw new Error(`${field} exceeds 20 Inputs`);
  return values;
}

function classify(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return 'NOT_FOUND';
  if (/required|supported|must remain|configured/i.test(message)) return 'INVALID_INPUT';
  if (/already running|already starting|workspace slot/i.test(message)) return 'CONFLICT';
  return 'AO_APPLICATION_ERROR';
}
