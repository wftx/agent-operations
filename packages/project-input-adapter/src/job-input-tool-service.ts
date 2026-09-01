import { open, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { InputMetadata } from '../../agent-operations-contracts/src/index.js';

export interface JobInputResolver {
  getInput(inputId: string): Promise<InputMetadata>;
  readInput(inputId: string): Promise<Uint8Array>;
}

/** Exact execution scoped Input reader with an optional isolated worktree output boundary. */
export class JobInputToolService {
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly inputs: JobInputResolver,
    allowedInputIds: readonly string[],
    private readonly repositoryWriteRoot?: string,
  ) {
    if (!allowedInputIds.length || allowedInputIds.length > 20) throw new Error('Input allowlist is invalid');
    this.allowed = new Set(allowedInputIds);
    if (this.allowed.size !== allowedInputIds.length) throw new Error('Input allowlist contains duplicates');
  }

  async list(): Promise<readonly InputMetadata[]> {
    return Promise.all([...this.allowed].sort().map(id => this.inputs.getInput(id)));
  }

  async read(inputId: string, offset = 0, length = 65_536) {
    this.requireAllowed(inputId);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset is out of bounds');
    if (!Number.isInteger(length) || length < 1 || length > 65_536) throw new Error('length is out of bounds');
    const [metadata, bytes] = await Promise.all([this.inputs.getInput(inputId), this.inputs.readInput(inputId)]);
    const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + length));
    return {
      metadata, offset, length: chunk.byteLength, endOfInput: offset + chunk.byteLength >= bytes.byteLength,
      encoding: 'base64' as const, data: Buffer.from(chunk).toString('base64'),
    };
  }

  async copyToRepository(inputId: string, relativePath: string) {
    this.requireAllowed(inputId);
    if (!this.repositoryWriteRoot) throw new Error('Input copy requires an isolated repository write root');
    if (!relativePath.trim() || relativePath.startsWith('/') || relativePath.includes('\0')) {
      throw new Error('Repository output path must be a nonempty relative path');
    }
    const [metadata, bytes] = await Promise.all([this.inputs.getInput(inputId), this.inputs.readInput(inputId)]);
    const root = await realpath(this.repositoryWriteRoot);
    const target = resolve(root, relativePath);
    const parent = await realpath(dirname(target));
    if (parent !== root && !parent.startsWith(`${root}/`)) throw new Error('Repository output path escapes its worktree');
    if (await stat(target).catch(() => null)) throw new Error('Repository output path already exists');
    const handle = await open(target, 'wx', 0o644);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    return { inputId, path: relativePath, byteSize: metadata.byteSize, sha256: metadata.sha256 };
  }

  private requireAllowed(inputId: string): void {
    if (!this.allowed.has(inputId)) throw new Error('Input is not attached to this exact Job execution');
  }
}
