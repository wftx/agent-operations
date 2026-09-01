import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { InputObjectStorageAdapter, StoredInputObject } from '../../agent-operations-contracts/src/index.js';

export class FileInputObjectStorage implements InputObjectStorageAdapter {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async store(inputId: string, bytes: Uint8Array): Promise<StoredInputObject> {
    if (!/^input:[a-zA-Z0-9-]+$/.test(inputId)) throw new Error('Unsafe Input ID');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = join(this.root, inputId.slice('input:'.length));
    await mkdir(directory, { mode: 0o700 });
    const target = join(directory, 'content');
    const temporary = join(directory, 'content.tmp');
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      storageReference: target,
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  async read(storageReference: string): Promise<Uint8Array> {
    const target = await this.requireOwnedPath(storageReference);
    return readFile(target);
  }

  async remove(storageReference: string): Promise<void> {
    const target = await this.requireOwnedPath(storageReference);
    if (basename(target) !== 'content') throw new Error('Input storage reference is invalid');
    await rm(dirname(target), { recursive: true });
  }

  private async requireOwnedPath(storageReference: string): Promise<string> {
    const target = resolve(storageReference);
    const root = await realpath(this.root).catch(() => this.root);
    const canonical = await realpath(target);
    if (canonical !== root && !canonical.startsWith(`${root}/`)) throw new Error('Input storage reference escapes its AO root');
    return canonical;
  }
}
