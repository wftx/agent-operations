import type { AgentOperationsStateStore } from '../../agent-operations-contracts/src/index.js';
import { classifyEscalationResolution } from '../../agent-operations-contracts/src/index.js';
import type { DailyDriverMetrics, DailyDriverMetricsApplication } from './types.js';

export class DailyDriverMetricsService implements DailyDriverMetricsApplication {
  constructor(private readonly store: AgentOperationsStateStore) {}

  async read(): Promise<DailyDriverMetrics> {
    const jobs = await this.store.listJobs();
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let autonomousCompletions = 0;
    let humanInterventionJobs = 0;
    let humanInterventions = 0;
    let workerExecutions = 0;
    let reviewerRevisions = 0;
    let reviewerDecisions = 0;
    let recoveryCount = 0;
    let providerSubmissions = 0;
    let terminalDurationTotal = 0;
    let terminalDurationCount = 0;
    const needsMeCategories = { machineResolvable: 0, operatorResolvable: 0, terminal: 0 };
    for (const job of jobs) {
      const [attempts, reviews, escalations, guidance, extensions] = await Promise.all([
        this.store.listAttemptsForJob(job.id),
        this.store.listAttemptReviewsForJob(job.id),
        this.store.listEscalations(job.id),
        this.store.listHumanGuidance(job.id),
        this.store.listWorkerBudgetExtensions(job.id),
      ]);
      let jobSubmissions = 0;
      for (const attempt of attempts) {
        const plan = await this.store.getExecutionPlanForAttempt(attempt.id);
        const dispatch = plan ? await this.store.getExecutionDispatchForPlan(plan.id) : null;
        if (dispatch?.submittedAt) {
          jobSubmissions += 1;
          if (attempt.executionRole === 'worker') workerExecutions += 1;
        }
      }
      providerSubmissions += jobSubmissions;
      reviewerRevisions += reviews.filter(review => review.decision === 'REVISION_REQUIRED').length;
      reviewerDecisions += reviews.length;
      recoveryCount += escalations.filter(escalation => escalation.reason === 'observation_timeout'
        || /reconcil|stale|ephemeral|restart/i.test(escalation.resolutionSummary ?? '')).length;
      humanInterventions += guidance.length + extensions.length;
      if (guidance.length || extensions.length
        || escalations.some(escalation => classifyEscalationResolution(escalation) === 'operator-resolvable')) {
        humanInterventionJobs += 1;
      }
      for (const escalation of escalations) {
        const kind = classifyEscalationResolution(escalation);
        if (kind === 'machine-resolvable') needsMeCategories.machineResolvable += 1;
        else if (kind === 'operator-resolvable') needsMeCategories.operatorResolvable += 1;
        else needsMeCategories.terminal += 1;
      }
      if (job.status === 'completed') {
        completed += 1;
        if (!guidance.length && !extensions.length) autonomousCompletions += 1;
      }
      if (job.status === 'cancelled') cancelled += 1;
      if ((await this.store.getOperatorRunForJob(job.id))?.status === 'failed') failed += 1;
      if (job.status === 'completed' || job.status === 'cancelled') {
        terminalDurationTotal += Math.max(0, new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime());
        terminalDurationCount += 1;
      }
    }
    return {
      jobsCreated: jobs.length,
      jobsCompleted: completed,
      jobsFailed: failed,
      jobsCancelled: cancelled,
      jobsActiveOrNeedsHuman: jobs.length - completed - cancelled,
      autonomousCompletions,
      autonomousCompletionRate: completed ? autonomousCompletions / completed : null,
      jobsRequiringHumanIntervention: humanInterventionJobs,
      humanInterventionCount: humanInterventions,
      humanInterventionRate: jobs.length ? humanInterventionJobs / jobs.length : null,
      needsMeCategories,
      workerExecutions,
      averageWorkerExecutions: jobs.length ? workerExecutions / jobs.length : null,
      reviewerRevisionCount: reviewerRevisions,
      reviewerRevisionRate: reviewerDecisions ? reviewerRevisions / reviewerDecisions : null,
      recoveryCount,
      providerSubmissions,
      duplicateDispatchCount: 0,
      averageTimeToResultMs: terminalDurationCount ? terminalDurationTotal / terminalDurationCount : null,
    };
  }
}
