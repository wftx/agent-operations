import { CortextOSRuntimeAdapter } from '../packages/cortextos-adapter/src/index.js';
import { CortextOSExecutionAdapter } from '../packages/cortextos-execution-adapter/src/index.js';
import { CortextOSExecutionObserver } from '../packages/cortextos-execution-observer/src/index.js';
import { GitRepositoryAdapter } from '../packages/git-adapter/src/index.js';
import { OrchestrationService } from '../packages/agent-operations-core/src/index.js';
import {
  OperatorApplicationService,
  type OperatorJobList,
} from '../packages/agent-operations-application/src/index.js';
import { SqliteAgentOperationsStateStore } from '../packages/sqlite-state-adapter/src/index.js';

async function main(): Promise<void> {
  const store = SqliteAgentOperationsStateStore.open();
  try {
    const runtime = new CortextOSRuntimeAdapter();
    const orchestration = new OrchestrationService(
      store,
      runtime,
      new GitRepositoryAdapter(),
      new CortextOSExecutionAdapter(),
      new CortextOSExecutionObserver(),
    );
    const application = new OperatorApplicationService(store, orchestration, { runtime });
    const [command = 'help', ...args] = process.argv.slice(2);
    if (command === 'projects') {
      const projects = await application.listProjects();
      for (const project of projects) {
        console.log(`${project.project.name} (${project.project.id})${project.runnable ? '' : ` — ${project.unavailableReason}`}`);
        for (const repository of project.repositories) console.log(`  ${repository.name} (${repository.id})`);
      }
      return;
    }
    if (['jobs', 'running', 'needs-me', 'done'].includes(command)) {
      const filter = command === 'jobs' ? optionalFlag(args, '--filter') ?? 'all'
        : command === 'running' ? 'running'
        : command === 'needs-me' ? 'needs-human' : 'done';
      if (!['all', 'running', 'needs-human', 'done'].includes(filter)) {
        throw new Error('--filter must be all, running, needs-human, or done');
      }
      const jobs = await application.listJobs(filter as OperatorJobList);
      for (const job of jobs) {
        console.log(`${job.currentStage.padEnd(24)} ${job.job.title} — ${job.projectName}/${job.repositoryName}`);
      }
      return;
    }
    if (command === 'show') {
      const jobId = args[0];
      if (!jobId || args.length !== 1) throw new Error('Usage: npm run ao -- show <job-id>');
      const detail = await application.getJobDetail(jobId);
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    if (command === 'run') {
      const values = parseFlags(args);
      const projects = await application.listProjects();
      const runnable = projects.filter(project => project.runnable);
      const project = values.project
        ? runnable.find(candidate => candidate.project.id === values.project)
        : runnable.length === 1 ? runnable[0] : undefined;
      if (!project) throw new Error('Select a runnable project with --project; use `npm run ao -- projects` to list choices');
      const repository = values.repository
        ? project.repositories.find(candidate => candidate.id === values.repository)
        : project.repositories.length === 1 ? project.repositories[0] : undefined;
      if (!repository) throw new Error('Select a configured repository with --repository');
      const input = {
        projectId: project.project.id,
        repositoryId: repository.id,
        task: values.task ?? '',
        acceptanceCriteria: values.acceptance ?? '',
      };
      const preview = await application.previewTask(input);
      console.log('OPERATOR JOB PREVIEW');
      console.log(`Project: ${preview.project.name}`);
      console.log(`Repository: ${preview.repository.name} (${preview.repository.id})`);
      console.log(`Runtime: ${preview.runtimeAgentId}`);
      console.log('Policy: read-only / deny / empty; repository reader only');
      console.log('Budget: 2 Worker Attempts; 1 Reviewer per Worker Attempt');
      console.log('Automatic read-only completion: enabled after Reviewer PASS');
      const executionAuthorized = values.execute && values.confirm === 'ORCHESTRATE';
      console.log(`Execution authorized: ${executionAuthorized ? 'true' : 'false'}`);
      if (!values.execute) {
        console.log('Jobs or Dispatches created: 0');
        return;
      }
      if (values.confirm !== 'ORCHESTRATE') {
        throw new Error('Live execution requires --execute --confirm ORCHESTRATE');
      }
      const session = await application.runOperatorJob(input);
      console.log(`Job accepted: ${session.jobId}`);
      console.log('The local runner is continuing through durable Agent Operations state.');
      const completed = await application.waitForRun(session.jobId);
      console.log(`Result: ${completed.status}${completed.message ? ` — ${completed.message}` : ''}`);
      return;
    }
    if (command === 'guide') {
      const escalationId = args[0];
      const instruction = optionalFlag(args.slice(1), '--instruction');
      if (!escalationId || !instruction) {
        throw new Error('Usage: npm run ao -- guide <escalation-id> --instruction <text>');
      }
      const session = await application.provideGuidanceAndContinue(escalationId, instruction);
      console.log(`Guidance persisted; fresh continuation accepted for Job ${session.jobId}`);
      const completed = await application.waitForRun(session.jobId);
      console.log(`Result: ${completed.status}${completed.message ? ` — ${completed.message}` : ''}`);
      return;
    }
    if (command === 'cancel') {
      const escalationId = args[0];
      if (!escalationId || args.length !== 1) {
        throw new Error('Usage: npm run ao -- cancel <escalation-id>');
      }
      const session = await application.cancelEscalatedJob(escalationId);
      console.log(`Cancelled Job ${session.jobId}`);
      return;
    }
    if (command === 'runtime') {
      console.log(JSON.stringify(await application.getRuntimeStatus(), null, 2));
      return;
    }
    printHelp();
  } finally {
    await store.close();
  }
}

interface Flags {
  project?: string;
  repository?: string;
  task?: string;
  acceptance?: string;
  execute: boolean;
  confirm?: string;
}

function parseFlags(args: readonly string[]): Flags {
  const result: Flags = { execute: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--execute') {
      result.execute = true;
      continue;
    }
    if (!['--project', '--repository', '--task', '--acceptance', '--confirm'].includes(flag)) {
      throw new Error(`Unsupported operator option: ${flag}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--project') result.project = value;
    if (flag === '--repository') result.repository = value;
    if (flag === '--task') result.task = value;
    if (flag === '--acceptance') result.acceptance = value;
    if (flag === '--confirm') result.confirm = value;
  }
  if (!result.execute && result.confirm) throw new Error('--confirm is valid only with --execute');
  return result;
}

function optionalFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    if (args.length) throw new Error(`Unsupported operator option: ${args[0]}`);
    return undefined;
  }
  if (args.length !== 2 || !args[index + 1]) throw new Error(`${name} requires exactly one value`);
  return args[index + 1];
}

function printHelp(): void {
  console.log(`Agent Operations operator CLI

  npm run ao -- projects
  npm run ao -- jobs [--filter all|running|needs-human|done]
  npm run ao -- running
  npm run ao -- needs-me
  npm run ao -- done
  npm run ao -- show <job-id>
  npm run ao -- runtime
  npm run ao -- run [--project <id>] [--repository <id>] --task <text> --acceptance <text>
  npm run ao -- guide <escalation-id> --instruction <text>
  npm run ao -- cancel <escalation-id>

Run is preview-only by default. Live execution additionally requires:
  --execute --confirm ORCHESTRATE`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
