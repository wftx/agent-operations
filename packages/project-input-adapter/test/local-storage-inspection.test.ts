import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileInputObjectStorage, LocalProjectResourceInspector } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe('local Project inspection and Input storage', () => {
  it('detects only bounded metadata and candidate commands without executing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ao-profile-')); roots.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'touch must-not-exist', dev: 'next dev' } }));
    await writeFile(join(root, 'package-lock.json'), '{}');
    await writeFile(join(root, 'CLAUDE.md'), 'supplementary');
    const result = await new LocalProjectResourceInspector().inspectLocalFolder(root);
    expect(result.profile).toMatchObject({
      packageManager: 'npm', buildCommandCandidates: ['npm run build'], previewCommandCandidates: ['npm run dev'],
      agentsFileSuggestion: true,
    });
    expect(result.profile.documentation).toContainEqual({ path: 'CLAUDE.md', kind: 'claude', providerSpecific: true });
    expect(await stat(join(root, 'must-not-exist')).catch(() => null)).toBeNull();
  });

  it('stores with generated paths, atomic finalization, restrictive files, and traversal rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ao-storage-')); roots.push(root);
    const storage = new FileInputObjectStorage(join(root, 'inputs'));
    const stored = await storage.store('input:abc-123', new Uint8Array([1, 2, 3]));
    expect(stored.storageReference).toBe(join(root, 'inputs', 'abc-123', 'content'));
    expect([...await readFile(stored.storageReference)]).toEqual([1, 2, 3]);
    expect((await stat(stored.storageReference)).mode & 0o777).toBe(0o600);
    await expect(storage.store('input:../escape', new Uint8Array([1]))).rejects.toThrow('Unsafe Input ID');
  });
});
