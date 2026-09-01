import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobInputToolService } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

const metadata = (id: string) => ({
  id, displayName: 'image.webp', mimeType: 'image/webp', byteSize: 4, sha256: 'a'.repeat(64),
  sourceType: 'uploaded-file' as const, createdAt: '2026-08-31T12:00:00.000Z',
});
const resolver = {
  async getInput(id: string) { return metadata(id); },
  async readInput() { return new Uint8Array([0, 1, 2, 255]); },
};

describe('JobInputToolService', () => {
  it('returns binary safe bounded chunks for only the exact allowlist', async () => {
    const service = new JobInputToolService(resolver, ['input:allowed']);
    expect(await service.read('input:allowed', 1, 2)).toMatchObject({ encoding: 'base64', data: 'AQI=', length: 2 });
    await expect(service.read('input:other')).rejects.toThrow('not attached');
  });

  it('copies an attached Input only to a new file inside the isolated write root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ao-input-tool-')); roots.push(root);
    await mkdir(join(root, 'public'));
    const service = new JobInputToolService(resolver, ['input:allowed'], root);
    expect(await service.copyToRepository('input:allowed', 'public/image.webp')).toMatchObject({
      path: 'public/image.webp', byteSize: 4, sha256: 'a'.repeat(64),
    });
    expect([...await readFile(join(root, 'public/image.webp'))]).toEqual([0, 1, 2, 255]);
    await expect(service.copyToRepository('input:allowed', '../escape.webp')).rejects.toThrow('escapes');
    await expect(service.copyToRepository('input:allowed', 'public/image.webp')).rejects.toThrow('already exists');
  });
});
