import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCortextOSSocketPath } from '../src/cortextos-state-location.js';

describe('CortextOS provider-adapter test IPC isolation', () => {
  it('uses only the explicit isolated test root', () => {
    expect(resolveCortextOSSocketPath('fixture', {
      environment: { VITEST: 'true', CTX_ROOT: '/tmp/cortextos-adapter-fixture' },
      homeDirectory: '/Users/example',
      platform: 'darwin',
    })).toBe(join('/tmp/cortextos-adapter-fixture', 'daemon.sock'));
  });

  it('fails closed when a test root is absent or points into user state', () => {
    expect(() => resolveCortextOSSocketPath('fixture', {
      environment: { VITEST: 'true' },
      homeDirectory: '/Users/example',
      platform: 'darwin',
    })).toThrow('explicit isolated CTX_ROOT');
    expect(() => resolveCortextOSSocketPath('fixture', {
      environment: { VITEST: 'true', CTX_ROOT: '/Users/example/.cortextos/default' },
      homeDirectory: '/Users/example',
      platform: 'darwin',
    })).toThrow('inside user home state');
  });

  it('preserves production socket semantics outside tests', () => {
    expect(resolveCortextOSSocketPath('development', {
      environment: {},
      homeDirectory: '/Users/example',
      platform: 'darwin',
    })).toBe('/Users/example/.cortextos/development/daemon.sock');
  });
});
