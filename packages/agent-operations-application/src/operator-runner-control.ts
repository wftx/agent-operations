import type { AgentOperationsStateStore, DurableOperatorRunnerState } from '../../agent-operations-contracts/src/index.js';
import { createOperatorRunId } from '../../agent-operations-contracts/src/index.js';

export const RUNNER_HEARTBEAT_MAX_AGE_MS = 15_000;
export interface OperatorRunnerStatus {
  readonly state: 'running' | 'paused' | 'stopped';
  readonly pauseKind?: 'maintenance' | 'administrative';
  readonly reason: string;
  readonly resumeAt?: string;
}

export async function readRunnerStatus(store: AgentOperationsStateStore, now: Date): Promise<OperatorRunnerStatus> {
  const record = await store.getOperatorRunnerState();
  if (!record) return { state: 'stopped', reason: 'Waiting for runner. No runner heartbeat is recorded.' };
  if (record.pauseKind === 'administrative') return { state: 'paused', pauseKind: 'administrative', reason: record.reason ?? 'Explicit administrative pause.' };
  if (record.state === 'stopped' || now.getTime() - Date.parse(record.updatedAt) > RUNNER_HEARTBEAT_MAX_AGE_MS) {
    return { state: 'stopped', reason: 'Waiting for runner. Its heartbeat is absent or expired.' };
  }
  return { state: record.state, reason: record.reason ?? 'Background execution is running.',
    ...(record.pauseKind ? { pauseKind: record.pauseKind } : {}), ...(record.resumeAt ? { resumeAt: record.resumeAt } : {}) };
}

/** One Web owner publishes health. Tool compositions only read this control. */
export class OperatorRunnerControl {
  private readonly ownerId = `runner:${createOperatorRunId()}`;
  constructor(private readonly store: AgentOperationsStateStore, private readonly now: () => Date) {}

  async attach(enabled: boolean, pauseKind: 'maintenance' | 'administrative' = 'maintenance'): Promise<void> {
    const existing = await this.store.getOperatorRunnerState();
    if (existing && existing.ownerId !== this.ownerId && existing.state !== 'stopped'
      && this.now().getTime() - Date.parse(existing.updatedAt) < RUNNER_HEARTBEAT_MAX_AGE_MS) {
      throw new Error('Another AO Web runner owner has a current heartbeat');
    }
    const administrative = existing?.pauseKind === 'administrative' || (!enabled && pauseKind === 'administrative');
    await this.write(existing, {
      state: enabled && !administrative ? 'running' : 'paused',
      ...(administrative ? { pauseKind: 'administrative', reason: existing?.reason ?? 'Explicit administrative pause. Resume requires a human action.' }
        : !enabled ? { pauseKind: 'maintenance', reason: 'Scoped maintenance pause. Daily Driver resumes after one minute.', resumeAt: new Date(this.now().getTime() + 60_000).toISOString() } : {}),
    });
  }

  async tick(): Promise<boolean> {
    const record = await this.store.getOperatorRunnerState();
    if (!record || record.ownerId !== this.ownerId) return false;
    const dailyDriver = (await this.store.listTrustProfiles()).some(profile => profile.scope === 'global' && profile.preset === 'daily-driver');
    const resume = record.state === 'paused' && record.pauseKind === 'maintenance'
      && record.resumeAt && Date.parse(record.resumeAt) <= this.now().getTime() && dailyDriver;
    await this.write(record, resume ? { state: 'running' } : record);
    return Boolean(resume) || record.state === 'running';
  }

  async setPaused(paused: boolean, reason: string): Promise<void> {
    const record = await this.store.getOperatorRunnerState();
    if (!record || record.ownerId !== this.ownerId) throw new Error('This process does not own the Web runner');
    await this.write(record, paused ? { state: 'paused', pauseKind: 'administrative', reason } : { state: 'running' });
  }

  async close(): Promise<void> {
    const record = await this.store.getOperatorRunnerState();
    if (record?.ownerId === this.ownerId) await this.write(record, { ...record, state: 'stopped' });
  }

  private async write(previous: DurableOperatorRunnerState | null, value: Pick<DurableOperatorRunnerState, 'state' | 'pauseKind' | 'reason' | 'resumeAt'>): Promise<void> {
    await this.store.saveOperatorRunnerState({ ownerId: this.ownerId, ...value,
      updatedAt: this.now().toISOString(), revision: (previous?.revision ?? -1) + 1 }, previous?.revision ?? null);
  }
}
