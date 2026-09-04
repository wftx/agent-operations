import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DurableJob, ExternalActionApproval, ExternalActionPlan, ExternalActionReceipt, ProjectAction } from '../../agent-operations-contracts/src/index.js';
import { validateExternalActionPlan, validateProjectAction, validateExternalApproval, validateExternalReceipt } from '../../agent-operations-contracts/src/index.js';

/** Synchronous transactions keep authorization, claims, receipts and Job state indivisible. */
export class ExternalActionPersistence {
  constructor(private readonly db: Database.Database) {}
  register(action: ProjectAction): void {
    validateProjectAction(action);
    const existing = this.db.prepare('SELECT definition_json AS json FROM project_actions WHERE id = ?').get(action.id) as {json: string} | undefined;
    if (existing) {
      if (existing.json !== JSON.stringify(action)) throw new Error('Action definitions are immutable; register a new version');
      return;
    }
    this.db.prepare('INSERT INTO project_actions VALUES (?, ?, ?)').run(action.id, action.projectId, JSON.stringify(action));
  }
  list(projectId: string): readonly ProjectAction[] {
    return (this.db.prepare('SELECT definition_json AS json FROM project_actions WHERE project_id = ? ORDER BY id').all(projectId) as {json:string}[]).map(row => JSON.parse(row.json));
  }
  plan(jobId: string): ExternalActionPlan | null {
    const row = this.db.prepare('SELECT plan_json AS json FROM external_action_plans WHERE job_id = ?').get(jobId) as {json:string} | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  request(key: string): ExternalActionPlan | null {
    const row = this.db.prepare('SELECT plan_json AS json FROM external_action_plans WHERE request_key = ?').get(key) as {json:string} | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  create(job: DurableJob, plan: ExternalActionPlan): void {
    this.db.transaction(() => {
      validateExternalActionPlan(job, plan);
      const action = this.list(job.projectId).find(value => value.id === plan.action.id);
      if (JSON.stringify(action) !== JSON.stringify(plan.action)) throw new Error('Configured Project action does not match plan');
      if (this.db.prepare("SELECT 1 FROM operator_runs WHERE status IN ('pending','running')").get()) throw new Error('Operator orchestration is already running');
      if (plan.predecessorJobId) {
        const old = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(plan.predecessorJobId) as {project_id:string;status:string;execution_mode:string} | undefined;
        if (!old || old.project_id !== job.projectId || !['draft','ready'].includes(old.status) || old.execution_mode === 'external-action'
          || this.db.prepare('SELECT 1 FROM job_attempts WHERE job_id = ?').get(plan.predecessorJobId)
          || this.db.prepare('SELECT 1 FROM repository_workspaces WHERE job_id = ?').get(plan.predecessorJobId)
          || this.db.prepare('SELECT 1 FROM job_retirements WHERE job_id = ?').get(plan.predecessorJobId)) throw new Error('Predecessor is not an unexecuted misclassified Job');
        this.db.prepare("UPDATE jobs SET status = 'cancelled', revision = revision + 1, updated_at = ? WHERE id = ?").run(plan.createdAt, plan.predecessorJobId);
        this.db.prepare("UPDATE operator_runs SET status = 'cancelled', started_at = COALESCE(started_at, ?), finished_at = ?, updated_at = ?, revision = revision + 1, failure_message = ? WHERE job_id = ?")
          .run(plan.createdAt, plan.createdAt, plan.createdAt, `Superseded due to execution mode misclassification by ${job.id}`, plan.predecessorJobId);
        this.db.prepare('UPDATE escalations SET resolved_at = ? WHERE job_id = ? AND resolved_at IS NULL').run(plan.createdAt, plan.predecessorJobId);
        this.db.prepare('INSERT INTO job_retirements VALUES (?, ?, ?, ?, ?, ?)').run(plan.predecessorJobId, 'retired', 'Superseded due to execution mode misclassification', 'AO application', job.id, plan.createdAt);
      }
      this.db.prepare(`INSERT INTO jobs (id, project_id, title, description, status, revision, created_at, updated_at, acceptance_criteria, automatic_read_only_completion, execution_mode)
        VALUES (?, ?, ?, ?, 'ready', 1, ?, ?, ?, 0, 'external-action')`).run(job.id, job.projectId, job.title, job.description ?? null, job.createdAt, job.updatedAt, job.acceptanceCriteria ?? null);
      this.db.prepare('INSERT INTO external_action_plans VALUES (?, ?, ?, ?, ?, ?)').run(job.id, plan.id, plan.requestKey, plan.predecessorJobId ?? null, plan.state, JSON.stringify(plan));
      this.db.prepare("INSERT INTO operator_runs (id, job_id, status, revision, created_at, updated_at, started_at, finished_at) VALUES (?, ?, 'needs_human', 0, ?, ?, ?, ?)")
        .run(`operator-run:${plan.id}`, job.id, plan.createdAt, plan.createdAt, plan.createdAt, plan.createdAt);
      this.escalate(job.id, plan.createdAt, 'External action requires exact human approval.');
    })();
  }
  approve(jobId: string, approval: ExternalActionApproval): void {
    this.db.transaction(() => {
      const plan = this.plan(jobId);
      if (!plan) throw new Error('External action plan not found');
      validateExternalApproval(plan, approval);
      if (plan.approval) {
        if (JSON.stringify(plan.approval) !== JSON.stringify(approval)) throw new Error('External approval already recorded');
        return;
      }
      if (plan.state !== 'awaiting-approval' || this.db.prepare('SELECT 1 FROM job_retirements WHERE job_id = ?').get(jobId)) throw new Error('External action is not awaiting approval');
      this.save({ ...plan, approval, state: 'approved', revision: plan.revision + 1 });
      // Approval does not itself schedule or execute a side effect.
    })();
  }
  claim(jobId: string, timestamp: string): boolean {
    return this.db.transaction(() => {
      const plan = this.plan(jobId);
      if (!plan?.approval || plan.state !== 'approved' || this.db.prepare('SELECT 1 FROM job_retirements WHERE job_id = ?').get(jobId)) return false;
      const job = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as {status:string};
      if (job.status !== 'ready') return false;
      this.save({ ...plan, state: 'executing', claimedAt: timestamp, revision: plan.revision + 1 });
      this.db.prepare("UPDATE operator_runs SET status = 'running', started_at = ?, finished_at = NULL, updated_at = ?, revision = revision + 1 WHERE job_id = ?").run(timestamp, timestamp, jobId);
      this.db.prepare('UPDATE escalations SET resolved_at = ? WHERE job_id = ? AND resolved_at IS NULL').run(timestamp, jobId);
      return true;
    })();
  }
  finish(receipt: ExternalActionReceipt): void {
    this.db.transaction(() => {
      const prior = this.receipt(receipt.jobId);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(receipt)) throw new Error('External receipt is immutable');
        return;
      }
      const plan = this.plan(receipt.jobId);
      if (!plan) throw new Error('External action plan not found');
      validateExternalReceipt(plan, receipt);
      this.db.prepare('INSERT INTO external_action_receipts VALUES (?, ?)').run(receipt.jobId, JSON.stringify(receipt));
      this.save({ ...plan, state: receipt.status, revision: plan.revision + 1 });
      const success = receipt.status === 'completed';
      if (success) this.db.prepare("UPDATE jobs SET status = 'completed', revision = revision + 1, updated_at = ? WHERE id = ?").run(receipt.recordedAt, receipt.jobId);
      this.db.prepare('UPDATE operator_runs SET status = ?, finished_at = ?, updated_at = ?, revision = revision + 1 WHERE job_id = ?').run(success ? 'completed' : 'needs_human', receipt.recordedAt, receipt.recordedAt, receipt.jobId);
      if (!success) this.escalate(receipt.jobId, receipt.recordedAt, `External action ${receipt.status}: ${receipt.errorCode ?? 'verification-failed'}. No automatic retry. Inspect the immutable receipt.`);
    })();
  }
  receipt(jobId: string): ExternalActionReceipt | null {
    const row = this.db.prepare('SELECT receipt_json AS json FROM external_action_receipts WHERE job_id = ?').get(jobId) as {json:string} | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  private save(plan: ExternalActionPlan): void {
    this.db.prepare('UPDATE external_action_plans SET state = ?, plan_json = ? WHERE job_id = ?').run(plan.state, JSON.stringify(plan), plan.jobId);
  }
  private escalate(jobId: string, time: string, summary: string): void {
    this.db.prepare('INSERT INTO escalations (id, job_id, reason, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(`escalation:${randomUUID()}`, jobId, 'human_judgment_required', summary, time);
  }
}
