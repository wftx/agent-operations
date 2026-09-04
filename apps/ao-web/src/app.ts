import type {
  OperatorApplication,
  OperatorJobList,
  OperatorTaskInput,
  OrchestratorConversationService,
  ProjectApplication,
  InputApplication,
  PreviewApplication,
  TrustProfileApplication,
  DailyDriverMetricsApplication,
  RuntimeFreshnessApplication,
} from '../../../packages/agent-operations-application/src/index.js';
import {
  renderDashboard,
  renderDone,
  renderError,
  renderJobDetail,
  renderJobList,
  renderNeedsMe,
  renderOrchestrator,
  renderProjects,
  renderNewProject,
  renderTrustProfiles,
  renderApprovals,
  renderRepositoryRestoreDetail,
} from './render.js';

export class OperatorWebApplication {
  private readonly conversation: OrchestratorConversationService;
  private readonly options: { readonly telegramConfigured?: boolean };

  constructor(
    private readonly application: OperatorApplication,
    conversationOrOptions: OrchestratorConversationService | { readonly telegramConfigured?: boolean } = {},
    options: { readonly telegramConfigured?: boolean } = {},
    private readonly projects?: ProjectApplication,
    private readonly inputs?: InputApplication,
    private readonly preview?: PreviewApplication,
    private readonly trustProfiles?: TrustProfileApplication,
    private readonly metrics?: DailyDriverMetricsApplication,
    private readonly runtimeFreshness?: RuntimeFreshnessApplication,
  ) {
    if ('sendTurn' in conversationOrOptions) {
      this.conversation = conversationOrOptions;
      this.options = options;
    } else {
      this.conversation = offlineConversation;
      this.options = conversationOrOptions;
    }
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return html(renderDashboard(
          await this.application.listProjects(),
          await this.application.listJobs('all'),
          await this.application.getRuntimeStatus(),
          { telegramConfigured: this.options.telegramConfigured ?? false, runnerStatus: await this.application.getRunnerStatus?.() },
          this.metrics ? await this.metrics.read() : undefined,
          this.runtimeFreshness ? await this.runtimeFreshness.inspect() : undefined,
        ));
      }
      if (request.method === 'GET' && url.pathname === '/trust') {
        if (!this.trustProfiles) throw new Error('Trust Profiles are not configured.');
        const projects = await this.application.listProjects();
        return html(renderTrustProfiles(
          await this.trustProfiles.list(),
          await Promise.all(projects.map(async project => ({
            projectId: project.project.id,
            projectName: project.project.name,
            effective: await this.trustProfiles!.effectiveForProject(project.project.id),
          }))),
        ));
      }
      if (request.method === 'POST' && url.pathname === '/trust') {
        if (!this.trustProfiles) throw new Error('Trust Profiles are not configured.');
        const form = await request.formData();
        const scope = textValue(form, 'scope');
        if (scope !== 'global' && scope !== 'project') throw new Error('Trust Profile scope is invalid');
        const preset = textValue(form, 'preset');
        if (preset !== 'conservative' && preset !== 'daily-driver') {
          throw new Error('Use the application API for an advanced Custom Trust Profile');
        }
        await this.trustProfiles.save({
          scope,
          ...(scope === 'project' ? { scopeId: textValue(form, 'scopeId') } : {}),
          preset,
        });
        return redirect('/trust');
      }
      if (request.method === 'POST' && url.pathname === '/runner') {
        if (!this.application.setRunnerPaused) throw new Error('Runner control is unavailable');
        const form = await request.formData();
        const action = textValue(form, 'action');
        if (action !== 'pause' && action !== 'resume') throw new Error('Invalid runner action');
        await this.application.setRunnerPaused(action === 'pause', 'Explicit human administrative pause from AO Web.');
        return redirect('/');
      }
      if (request.method === 'GET' && url.pathname === '/orchestrator') {
        return this.orchestratorPage();
      }
      if (request.method === 'POST' && url.pathname === '/orchestrator/turn') {
        const form = await request.formData();
        const projectId = textValue(form, 'projectId');
        try {
          const inputIds: string[] = [];
          const upload = form.get('attachment');
          if (upload instanceof File && upload.size > 0) {
            if (!this.inputs) throw new Error('Input uploads are not configured.');
            inputIds.push((await this.inputs.createUploadedInput({
              displayName: upload.name,
              mimeType: upload.type,
              bytes: new Uint8Array(await upload.arrayBuffer()),
              ...(projectId ? { projectId } : {}),
            })).id);
          }
          const inputUrl = textValue(form, 'inputUrl');
          if (inputUrl) {
            if (!this.inputs) throw new Error('URL Inputs are not configured.');
            inputIds.push((await this.inputs.createUrlInput({ url: inputUrl, ...(projectId ? { projectId } : {}) })).id);
          }
          await this.conversation.sendTurn({
            message: textValue(form, 'message'),
            ...(projectId ? { projectId } : {}),
            ...(inputIds.length ? { inputIds } : {}),
          });
          return redirect('/orchestrator');
        } catch (error) {
          return this.orchestratorPage(message(error), 400);
        }
      }
      if (request.method === 'GET' && url.pathname === '/projects') {
        if (!this.projects) throw new Error('Project onboarding is not configured.');
        return html(renderProjects(await this.projects.listProjects()));
      }
      if (request.method === 'GET' && url.pathname === '/projects/new') {
        return html(renderNewProject());
      }
      if (request.method === 'POST' && url.pathname === '/projects') {
        if (!this.projects) throw new Error('Project onboarding is not configured.');
        const form = await request.formData();
        const resourceType = textValue(form, 'resourceType');
        if (!['local-folder', 'none'].includes(resourceType)) throw new Error('Invalid Project Resource type');
        const result = await this.projects.createProject({
          name: textValue(form, 'name'),
          description: textValue(form, 'description'),
          resource: resourceType === 'none'
            ? { type: 'none' }
            : { type: 'local-folder', path: textValue(form, 'path') },
        });
        return redirect(`/projects#${encodeURIComponent(result.project.id)}`);
      }
      if (request.method === 'POST' && url.pathname === '/runtime/start') {
        const runtimeStart = await this.application.startRuntime();
        return html(renderDashboard(
          await this.application.listProjects(),
          await this.application.listJobs('all'),
          await this.application.getRuntimeStatus(),
          {
            telegramConfigured: this.options.telegramConfigured ?? false,
            runtimeStart,
          },
        ), runtimeStart.status === 'failed' ? 409 : 200);
      }
      if (request.method === 'GET' && url.pathname === '/running') {
        return this.listPage('Running', 'Worker and Reviewer turns currently managed by Agent Operations.', 'running');
      }
      if (request.method === 'GET' && url.pathname === '/done') {
        const jobs = await this.application.listJobs('done');
        return html(renderDone(await Promise.all(jobs.map(job => this.application.getJobDetail(job.job.id)))));
      }
      if (request.method === 'GET' && url.pathname === '/archived') {
        return this.listPage('Archived', 'Historical Jobs with preserved evidence and no active ownership.', 'retired');
      }
      if (request.method === 'GET' && url.pathname === '/approvals') {
        return html(renderApprovals(this.application.listRepositoryRestoreActions
          ? await this.application.listRepositoryRestoreActions() : []));
      }
      const restoreDetail = url.pathname.match(/^\/repository-restores\/([^/]+)$/);
      if (request.method === 'GET' && restoreDetail) {
        const id = decodeURIComponent(restoreDetail[1]);
        const action = (await (this.application.listRepositoryRestoreActions?.() ?? Promise.resolve([])))
          .find(candidate => candidate.id === id);
        if (!action) return html(renderError('Repository Restore action not found', 404), 404);
        const receipt = this.application.getRepositoryRestoreExecutionReceipt
          ? await this.application.getRepositoryRestoreExecutionReceipt(id) : null;
        return html(renderRepositoryRestoreDetail(action, receipt));
      }
      if (request.method === 'GET' && url.pathname === '/needs-me') {
        const jobs = await this.application.listJobs('needs-human');
        return html(renderNeedsMe(await Promise.all(jobs.map(job => this.application.getJobDetail(job.job.id)))));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/jobs/')) {
        const jobId = decodeURIComponent(url.pathname.slice('/jobs/'.length));
        return html(renderJobDetail(await this.application.getJobDetail(jobId)));
      }
      if (request.method === 'POST' && url.pathname === '/jobs') {
        return this.submit(request);
      }
      const retireJob = url.pathname.match(/^\/jobs\/([^/]+)\/retire$/);
      if (request.method === 'POST' && retireJob) {
        const form = await request.formData();
        const disposition = textValue(form, 'disposition');
        if (disposition !== 'retired' && disposition !== 'externally-published') {
          throw new Error('Invalid Job retirement disposition');
        }
        const jobId = decodeURIComponent(retireJob[1]);
        if (!this.application.retireJob) throw new Error('Job retirement is not configured');
        await this.application.retireJob(jobId, {
          disposition,
          reason: textValue(form, 'reason'),
          actor: textValue(form, 'actor') || 'human-operator',
          ...(textValue(form, 'evidenceReference')
            ? { evidenceReference: textValue(form, 'evidenceReference') }
            : {}),
        });
        return redirect(`/jobs/${encodeURIComponent(jobId)}`);
      }
      const approveRestore = url.pathname.match(/^\/repository-restores\/([^/]+)\/approve$/);
      if (request.method === 'POST' && approveRestore) {
        const form = await request.formData();
        if (!this.application.approveAndExecuteRepositoryRestore) {
          throw new Error('Repository Restore is not configured');
        }
        await this.application.approveAndExecuteRepositoryRestore(
          decodeURIComponent(approveRestore[1]),
          textValue(form, 'approvedBy') || 'human-operator',
        );
        return redirect('/approvals');
      }
      const evidenceRequirement = url.pathname.match(/^\/jobs\/([^/]+)\/preview\/requirement$/);
      if (request.method === 'POST' && evidenceRequirement) {
        if (!this.preview) throw new Error('Browser Evidence is not configured.');
        const form = await request.formData();
        const jobId = decodeURIComponent(evidenceRequirement[1]);
        await this.preview.setJobEvidenceRequirement(jobId, {
          kind: 'browser-render',
          route: textValue(form, 'route') || '/',
          viewport: { width: 1440, height: 900 },
        });
        return redirect(`/jobs/${encodeURIComponent(jobId)}`);
      }
      const previewProfile = url.pathname.match(/^\/jobs\/([^/]+)\/preview\/profile$/);
      if (request.method === 'POST' && previewProfile) {
        if (!this.preview) throw new Error('Job Preview is not configured.');
        const form = await request.formData();
        const jobId = decodeURIComponent(previewProfile[1]);
        await this.preview.setJobPreviewProfile(
          jobId,
          textValue(form, 'command'),
          textValue(form, 'authenticationRequired') === 'yes',
        );
        return redirect(`/jobs/${encodeURIComponent(jobId)}`);
      }
      const previewStart = url.pathname.match(/^\/jobs\/([^/]+)\/preview\/start$/);
      if (request.method === 'POST' && previewStart) {
        if (!this.preview) throw new Error('Job Preview is not configured.');
        const jobId = decodeURIComponent(previewStart[1]);
        await this.preview.startJobPreview(jobId);
        return redirect(`/jobs/${encodeURIComponent(jobId)}`);
      }
      const evidenceRefresh = url.pathname.match(/^\/jobs\/([^/]+)\/preview\/evidence$/);
      if (request.method === 'POST' && evidenceRefresh) {
        if (!this.preview) throw new Error('Browser Evidence is not configured.');
        const jobId = decodeURIComponent(evidenceRefresh[1]);
        await this.preview.refreshJobEvidence(jobId);
        return redirect(`/jobs/${encodeURIComponent(jobId)}`);
      }
      const authenticationBegin = url.pathname.match(/^\/jobs\/([^/]+)\/preview\/authentication\/begin$/);
      if (request.method === 'POST' && authenticationBegin) {
        if (!this.preview) throw new Error('Preview authentication is not configured.');
        const jobId = decodeURIComponent(authenticationBegin[1]);
        await this.preview.beginPreviewAuthentication(jobId);
        return redirect(`/jobs/${encodeURIComponent(jobId)}`);
      }
      const authenticationVerify = url.pathname.match(/^\/jobs\/([^/]+)\/preview\/authentication\/verify$/);
      if (request.method === 'POST' && authenticationVerify) {
        if (!this.preview) throw new Error('Preview authentication is not configured.');
        const jobId = decodeURIComponent(authenticationVerify[1]);
        await this.preview.verifyPreviewAuthentication(jobId);
        return redirect(`/jobs/${encodeURIComponent(jobId)}`);
      }
      const authenticationRevoke = url.pathname.match(/^\/jobs\/([^/]+)\/preview\/authentication\/revoke$/);
      if (request.method === 'POST' && authenticationRevoke) {
        if (!this.preview) throw new Error('Preview authentication is not configured.');
        const jobId = decodeURIComponent(authenticationRevoke[1]);
        await this.preview.revokePreviewAuthentication(jobId);
        return redirect(`/jobs/${encodeURIComponent(jobId)}`);
      }
      const guidance = url.pathname.match(/^\/escalations\/([^/]+)\/guidance$/);
      if (request.method === 'POST' && guidance) {
        const form = await request.formData();
        const session = await this.application.provideGuidanceAndContinue(
          decodeURIComponent(guidance[1]),
          textValue(form, 'instruction'),
        );
        return redirect(`/jobs/${encodeURIComponent(session.jobId)}`);
      }
      const extendWorkerBudget = url.pathname.match(/^\/escalations\/([^/]+)\/extend-worker-budget$/);
      if (request.method === 'POST' && extendWorkerBudget) {
        const form = await request.formData();
        const instruction = textValue(form, 'instruction');
        const session = await this.application.authorizeOneMoreWorkerAttempt(
          decodeURIComponent(extendWorkerBudget[1]),
          instruction || undefined,
        );
        return redirect(`/jobs/${encodeURIComponent(session.jobId)}`);
      }
      const cancel = url.pathname.match(/^\/escalations\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && cancel) {
        const session = await this.application.cancelEscalatedJob(decodeURIComponent(cancel[1]));
        return redirect(`/jobs/${encodeURIComponent(session.jobId)}`);
      }
      const reconcile = url.pathname.match(/^\/escalations\/([^/]+)\/reconcile$/);
      if (request.method === 'POST' && reconcile) {
        const session = await this.application.reconcileTimedOutExecution(
          decodeURIComponent(reconcile[1]),
        );
        return redirect(`/jobs/${encodeURIComponent(session.jobId)}`);
      }
      return html(renderError('Page not found', 404), 404);
    } catch (error) {
      const status = request.method === 'POST' ? 400 : 500;
      return html(renderError(message(error), status), status);
    }
  }

  private async submit(request: Request): Promise<Response> {
    const form = await request.formData();
    const selection = parseSelection(textValue(form, 'selection'));
    const input: OperatorTaskInput = {
      projectId: selection?.projectId ?? textValue(form, 'projectId'),
      repositoryId: selection?.repositoryId ?? textValue(form, 'repositoryId'),
      task: textValue(form, 'task'),
      acceptanceCriteria: textValue(form, 'acceptanceCriteria'),
      executionMode: textValue(form, 'executionMode') === 'repository-write-isolated'
        ? 'repository-write-isolated'
        : 'repository-read-only',
      ...(textValue(form, 'browserEvidence') === 'browser-render'
        ? { browserEvidenceRequirement: {
            kind: 'browser-render' as const,
            route: textValue(form, 'browserRoute') || '/',
            viewport: { width: 1440, height: 900 },
          } }
        : {}),
    };
    try {
      if (textValue(form, 'intent') === 'preview') {
        const preview = await this.application.previewTask(input);
        return html(renderDashboard(
          await this.application.listProjects(),
          await this.application.listJobs('all'),
          await this.application.getRuntimeStatus(),
          { preview, input, telegramConfigured: this.options.telegramConfigured ?? false },
        ));
      }
      if (textValue(form, 'intent') !== 'run') throw new Error('Unsupported Job submission intent');
      const session = await this.application.runOperatorJob(input);
      return redirect(`/jobs/${encodeURIComponent(session.jobId)}`);
    } catch (error) {
      return html(renderDashboard(
        await this.application.listProjects(),
        await this.application.listJobs('all'),
        await this.application.getRuntimeStatus(),
        { error: message(error), input, telegramConfigured: this.options.telegramConfigured ?? false },
      ), 400);
    }
  }

  private async listPage(title: string, description: string, filter: OperatorJobList): Promise<Response> {
    const active = filter === 'needs-human' ? 'needs-me' : filter === 'retired' ? 'archived' : filter === 'all' ? 'jobs' : filter;
    return html(renderJobList(title, description, await this.application.listJobs(filter), active));
  }

  private async orchestratorPage(error?: string, status = 200): Promise<Response> {
    const state = await this.conversation.getConversationState();
    const relatedIds = [...new Set(state.turns.flatMap(turn => turn.relatedJobIds))];
    const relatedJobs = (await Promise.all(relatedIds.map(async jobId => {
      try { return (await this.application.getJobDetail(jobId)).summary; }
      catch { return null; }
    }))).filter(job => job !== null);
    return html(renderOrchestrator(
      state,
      await this.application.listProjects(),
      relatedJobs,
      { ...(error ? { error } : {}) },
    ), status);
  }
}

const offlineConversation: OrchestratorConversationService = {
  async sendTurn() { throw new Error('The AO Orchestrator conversation service is not configured.'); },
  async getConversationState() {
    return {
      agentId: 'ao-orchestrator',
      sessionId: 'cortextos:default:ao-orchestrator',
      runtimeState: 'offline' as const,
      runtimeReason: 'The AO Orchestrator conversation service is not configured.',
      turns: [],
    };
  },
};

function parseSelection(value: string): { projectId: string; repositoryId: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Record<string, unknown>;
    return typeof candidate.projectId === 'string' && typeof candidate.repositoryId === 'string'
      ? { projectId: candidate.projectId, repositoryId: candidate.repositoryId }
      : null;
  } catch {
    return null;
  }
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function textValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
