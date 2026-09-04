import { describe, expect, it } from 'vitest';
import { InMemoryAgentOperationsStateStore } from '../../agent-operations-contracts/src/index.js';
import { OperatorRunnerControl, readRunnerStatus } from '../src/operator-runner-control.js';
import { TrustProfileApplicationService } from '../src/trust-profile-application-service.js';

describe('durable runner control', () => {
  it('expires scoped maintenance in Daily Driver but retains administrative pauses across restart', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    let time = Date.parse('2026-09-04T00:00:00Z');
    const now = () => new Date(time);
    await new TrustProfileApplicationService(store, { now }).save({ scope: 'global', preset: 'daily-driver' });
    const control = new OperatorRunnerControl(store, now);
    await control.attach(false);
    expect(await control.tick()).toBe(false);
    expect(await readRunnerStatus(store, now())).toMatchObject({ state: 'paused', pauseKind: 'maintenance' });
    time += 61_000;
    expect(await control.tick()).toBe(true);
    await control.setPaused(true, 'Human maintenance');
    time += 61_000;
    expect(await control.tick()).toBe(false);
    await control.close();
    const restarted = new OperatorRunnerControl(store, now);
    await restarted.attach(true);
    expect(await restarted.tick()).toBe(false);
    await restarted.setPaused(false, 'Human resume');
    expect(await restarted.tick()).toBe(true);
    await restarted.close();
    expect((await readRunnerStatus(store, now())).state).toBe('stopped');
  });

  it('does not resume maintenance automatically in Conservative and reports expired heartbeats', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    let time = Date.parse('2026-09-04T00:00:00Z');
    const now = () => new Date(time);
    const control = new OperatorRunnerControl(store, now);
    await control.attach(false);
    time += 61_000;
    expect(await control.tick()).toBe(false);
    await control.setPaused(false, 'Human resume');
    time += 16_000;
    expect((await readRunnerStatus(store, now())).state).toBe('stopped');
  });

  it('rejects another live owner and stale compare and swap writes', async () => {
    const store = new InMemoryAgentOperationsStateStore();
    const now = () => new Date('2026-09-04T00:00:00Z');
    await new OperatorRunnerControl(store, now).attach(true);
    await expect(new OperatorRunnerControl(store, now).attach(true)).rejects.toThrow('Another');
    const state = (await store.getOperatorRunnerState())!;
    await expect(store.saveOperatorRunnerState(state, state.revision)).rejects.toThrow('conflict');
  });
});
