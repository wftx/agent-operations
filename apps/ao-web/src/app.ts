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
      return html(renderError('Page not found', 404), 404);
    } catch (error) {
      return html(renderError(message(error)), 500);
    }
  }

  private async submit(request: Request): Promise<Response> {
    const form = await request.formData();
    const input: OperatorTaskInput = {
      projectId: textValue(form, 'projectId'),
      repositoryId: textValue(form, 'repositoryId'),
      task: textValue(form, 'task'),
      acceptanceCriteria: textValue(form, 'acceptanceCriteria'),
    };
    try {
      if (textValue(form, 'intent') === 'preview') {
        const preview = await this.application.previewTask(input);
        return html(renderDashboard(
          await this.application.listProjects(),
          await this.application.listJobs('all'),
          { preview, input },
        ));
      }
      const session = await this.application.runOperatorJob(input);
      return new Response(null, {
        status: 303,
        headers: { location: `/jobs/${encodeURIComponent(session.jobId)}` },
      });
    } catch (error) {
      return html(renderDashboard(
        await this.application.listProjects(),
        await this.application.listJobs('all'),
        { error: message(error), input },
      ), 400);
    }
  }

  private async listPage(title: string, description: string, filter: OperatorJobList): Promise<Response> {
    const active = filter === 'needs-human' ? 'needs-me' : filter === 'all' ? 'jobs' : filter;
    return html(renderJobList(title, description, await this.application.listJobs(filter), active));
  }
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
