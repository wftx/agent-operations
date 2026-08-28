import type {
  OperatorApplication,
  OperatorJobList,
  OperatorTaskInput,
} from '../../../packages/agent-operations-application/src/index.js';
import {
  renderDashboard,
  renderDone,
  renderError,
  renderJobDetail,
  renderJobList,
  renderNeedsMe,
} from './render.js';

export class OperatorWebApplication {
  constructor(private readonly application: OperatorApplication) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return html(renderDashboard(
          await this.application.listProjects(),
          await this.application.listJobs('all'),
          await this.application.getRuntimeStatus(),
        ));
      }
      if (request.method === 'GET' && url.pathname === '/running') {
        return this.listPage('Running', 'Worker and Reviewer turns currently managed by Agent Operations.', 'running');
      }
      if (request.method === 'GET' && url.pathname === '/done') {
        const jobs = await this.application.listJobs('done');
        return html(renderDone(await Promise.all(jobs.map(job => this.application.getJobDetail(job.job.id)))));
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
      const guidance = url.pathname.match(/^\/escalations\/([^/]+)\/guidance$/);
      if (request.method === 'POST' && guidance) {
        const form = await request.formData();
        const session = await this.application.provideGuidanceAndContinue(
          decodeURIComponent(guidance[1]),
          textValue(form, 'instruction'),
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
    };
    try {
      if (textValue(form, 'intent') === 'preview') {
        const preview = await this.application.previewTask(input);
        return html(renderDashboard(
          await this.application.listProjects(),
          await this.application.listJobs('all'),
          await this.application.getRuntimeStatus(),
          { preview, input },
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
        { error: message(error), input },
      ), 400);
    }
  }

  private async listPage(title: string, description: string, filter: OperatorJobList): Promise<Response> {
    const active = filter === 'needs-human' ? 'needs-me' : filter === 'all' ? 'jobs' : filter;
    return html(renderJobList(title, description, await this.application.listJobs(filter), active));
  }
}

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
