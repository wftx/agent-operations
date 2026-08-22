import { describe, expect, it } from 'vitest';
import {
  FakeRepositoryInventoryAdapter,
  createRepositoryInventoryFixtures,
} from '../src/index.js';

describe('FakeRepositoryInventoryAdapter', () => {
  it('provides deterministic clean, dirty, detached, and unavailable fixtures', async () => {
    const adapter = new FakeRepositoryInventoryAdapter();
    const clean = await adapter.inspectRepository('/fixtures/clean');
    const dirty = await adapter.inspectRepository('/fixtures/dirty');
    const detached = await adapter.inspectRepository('/fixtures/detached');
    const unavailable = await adapter.inspectRepository('/fixtures/unavailable');

    expect(clean).toMatchObject({ branch: 'main', workingTree: 'clean', availability: 'available' });
    expect(dirty).toMatchObject({ branch: 'feature/inventory', workingTree: 'dirty' });
    expect(detached.detachedHead).toBe(true);
    expect(detached.branch).toBeUndefined();
    expect(unavailable).toMatchObject({ availability: 'unavailable', workingTree: 'unknown' });
  });

  it('returns defensive copies and a contract-shaped unavailable result for unknown paths', async () => {
    const adapter = new FakeRepositoryInventoryAdapter(createRepositoryInventoryFixtures());
    const first = await adapter.inspectRepository('/fixtures/clean');
    (first.remotes[0] as unknown as { name: string }).name = 'changed';
    expect((await adapter.inspectRepository('/fixtures/clean')).remotes[0].name).toBe('origin');
    expect(await adapter.inspectRepository('/fixtures/missing')).toMatchObject({
      availability: 'unavailable',
      checkoutPath: '/fixtures/missing',
      identityKind: 'local',
    });
  });
});
