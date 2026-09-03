import { describe, expect, it } from 'vitest';
import {
  CONSERVATIVE_TRUST_POLICY,
  DAILY_DRIVER_TRUST_POLICY,
  InMemoryAgentOperationsStateStore,
  canAutonomouslyPerformRiskTier,
} from '../../agent-operations-contracts/src/index.js';
import { TrustProfileApplicationService } from '../src/index.js';

const now = '2026-09-02T12:00:00.000Z';
const projectId = 'project:trust';
const jobId = 'job:trust';

describe('TrustProfileApplicationService', () => {
  it('keeps existing Projects Conservative until an operator selects another preset', async () => {
    const { service } = await fixture();

    await expect(service.effectiveForProject(projectId)).resolves.toEqual({
      profile: null,
      policy: CONSERVATIVE_TRUST_POLICY,
      source: 'conservative-fallback',
    });
  });

  it('applies a global default and a Project override with bounded Daily Driver budgets', async () => {
    const { service } = await fixture();
    await service.save({ scope: 'global', preset: 'daily-driver' });
    expect(await service.effectiveForProject(projectId)).toMatchObject({
      source: 'global',
      policy: {
        readOnlyJobsAutoRun: true,
        isolatedWriteJobsAutoRun: true,
        maxGreenWorkerExecutions: 5,
        maxYellowWorkerExecutions: 3,
        redActionsRequireHumanApproval: true,
      },
    });

    await service.save({ scope: 'project', scopeId: projectId, preset: 'conservative' });
    expect(await service.effectiveForJob(jobId)).toMatchObject({
      source: 'project',
      policy: CONSERVATIVE_TRUST_POLICY,
    });
  });

  it('permits a Job restriction but forbids a Job from widening its Project ceiling', async () => {
    const { service } = await fixture();
    await service.save({ scope: 'project', scopeId: projectId, preset: 'conservative' });

    await expect(service.save({
      scope: 'job', scopeId: jobId, preset: 'daily-driver',
    })).rejects.toThrow('cannot expand');

    await service.save({ scope: 'project', scopeId: projectId, preset: 'daily-driver' });
    const restriction = await service.save({
      scope: 'job', scopeId: jobId, preset: 'custom',
      policy: {
        ...DAILY_DRIVER_TRUST_POLICY,
        maxGreenWorkerExecutions: 2,
        maxYellowWorkerExecutions: 2,
        readOnlyJobsAutoRun: false,
      },
    });
    expect(restriction.policy.maxGreenWorkerExecutions).toBe(2);
    expect((await service.effectiveForJob(jobId)).source).toBe('job');
  });

  it('never permits unlimited budgets or disabling the Red human gate', async () => {
    const { service } = await fixture();
    await expect(service.save({
      scope: 'global', preset: 'custom',
      policy: { ...DAILY_DRIVER_TRUST_POLICY, maxGreenWorkerExecutions: 11 },
    })).rejects.toThrow('integer from 1 through 10');
    await expect(service.save({
      scope: 'global', preset: 'custom',
      policy: { ...DAILY_DRIVER_TRUST_POLICY, redActionsRequireHumanApproval: false as true },
    })).rejects.toThrow('Red actions must always require human approval');
    expect(canAutonomouslyPerformRiskTier(DAILY_DRIVER_TRUST_POLICY, 'red')).toBe(false);
  });
});

async function fixture() {
  const store = new InMemoryAgentOperationsStateStore();
  await store.applyProjectConfiguration({
    project: { id: projectId, name: 'Trust Project', createdAt: now, updatedAt: now },
    repositories: [], checkoutBindings: [], runtimeAgentIds: [],
  });
  await store.createJob({
    id: jobId, projectId, title: 'Trust Job', status: 'draft', revision: 0,
    createdAt: now, updatedAt: now,
  });
  return { store, service: new TrustProfileApplicationService(store, { now: () => new Date(now) }) };
}
