import type {
  AgentOperationsStateStore,
  AuthorizedUrlInputFetcher,
  DurableInput,
  InputMetadata,
  InputObjectStorageAdapter,
} from '../../agent-operations-contracts/src/index.js';
import { createInputId, toInputMetadata } from '../../agent-operations-contracts/src/index.js';
import type {
  CreateUploadedInputRequest,
  CreateUrlInputRequest,
  InputApplication,
} from './types.js';

export interface InputApplicationServiceOptions {
  readonly now?: () => Date;
  readonly inputIdFactory?: () => string;
  readonly maximumBytes?: number;
}

/** Immutable Input ingestion boundary. Metadata commits only after content storage succeeds. */
export class InputApplicationService implements InputApplication {
  private readonly now: () => Date;
  private readonly inputIdFactory: () => string;
  private readonly maximumBytes: number;

  constructor(
    private readonly store: AgentOperationsStateStore,
    private readonly storage: InputObjectStorageAdapter,
    private readonly urlFetcher: AuthorizedUrlInputFetcher,
    options: InputApplicationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.inputIdFactory = options.inputIdFactory ?? createInputId;
    this.maximumBytes = options.maximumBytes ?? 10 * 1024 * 1024;
  }

  async createUploadedInput(request: CreateUploadedInputRequest): Promise<InputMetadata> {
    const mimeType = validatedMime(request.mimeType, request.bytes);
    return this.ingest({
      displayName: safeName(request.displayName),
      mimeType,
      bytes: request.bytes,
      sourceType: 'uploaded-file',
      ...(request.projectId ? { projectId: request.projectId } : {}),
    });
  }

  async createUrlInput(request: CreateUrlInputRequest): Promise<InputMetadata> {
    const result = await this.urlFetcher.fetch(request.url);
    const mimeType = validatedMime(result.contentType, result.bytes);
    return this.ingest({
      displayName: safeName(result.displayName ?? nameFromUrl(result.finalUrl)),
      mimeType,
      bytes: result.bytes,
      sourceType: 'authorized-url',
      originalUrl: request.url,
      finalUrl: result.finalUrl,
      ...(request.projectId ? { projectId: request.projectId } : {}),
    });
  }

  async getInput(inputId: string): Promise<InputMetadata> {
    const input = await this.store.getInput(inputId);
    if (!input) throw new Error(`Input not found: ${inputId}`);
    return toInputMetadata(input);
  }

  async listInputs(projectId?: string): Promise<readonly InputMetadata[]> {
    return (await this.store.listInputs(projectId)).map(toInputMetadata);
  }

  async readInput(inputId: string): Promise<Uint8Array> {
    const input = await this.store.getInput(inputId);
    if (!input) throw new Error(`Input not found: ${inputId}`);
    const bytes = await this.storage.read(input.storageReference);
    if (bytes.byteLength !== input.byteSize) throw new Error(`Stored Input size does not match metadata: ${inputId}`);
    return bytes;
  }

  async associateWithConversation(conversationId: string, inputIds: readonly string[]): Promise<void> {
    for (const inputId of inputIds) await this.getInput(inputId);
    await this.store.associateInputsWithConversation(conversationId, inputIds);
  }

  private async ingest(
    value: Omit<DurableInput, 'id' | 'storageReference' | 'sha256' | 'byteSize' | 'createdAt' | 'ingestionState' | 'validationState'>
      & { readonly bytes: Uint8Array },
  ): Promise<InputMetadata> {
    if (value.bytes.byteLength === 0) throw new Error('Input content is empty');
    if (value.bytes.byteLength > this.maximumBytes) throw new Error(`Input exceeds ${this.maximumBytes} byte limit`);
    if (value.projectId && !await this.store.getProject(value.projectId)) throw new Error(`Project not found: ${value.projectId}`);
    const id = this.inputIdFactory();
    const stored = await this.storage.store(id, value.bytes);
    const { bytes: _bytes, ...metadata } = value;
    const input: DurableInput = {
      id,
      ...metadata,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      storageReference: stored.storageReference,
      ingestionState: 'complete',
      validationState: 'valid',
      createdAt: this.now().toISOString(),
    };
    try {
      await this.store.createInput(input);
    } catch (error) {
      await this.storage.remove(stored.storageReference).catch(() => undefined);
      throw error;
    }
    return toInputMetadata(input);
  }
}

function safeName(value: string): string {
  const name = value.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
  if (!name || name === '.' || name === '..') throw new Error('Input display name is required');
  if (name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Input display name is unsafe');
  return name;
}

function safeMime(value: string | undefined): string {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)
    ? mime : 'application/octet-stream';
}

function validatedMime(value: string | undefined, bytes: Uint8Array): string {
  const mime = safeMime(value);
  const starts = (...values: number[]) => values.every((byte, index) => bytes[index] === byte);
  if (mime === 'application/pdf' && !starts(0x25, 0x50, 0x44, 0x46)) throw new Error('Input content does not match application/pdf');
  if (mime === 'image/png' && !starts(0x89, 0x50, 0x4e, 0x47)) throw new Error('Input content does not match image/png');
  if (mime === 'image/jpeg' && !starts(0xff, 0xd8, 0xff)) throw new Error('Input content does not match image/jpeg');
  if (mime === 'image/webp' && !(starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP')) {
    throw new Error('Input content does not match image/webp');
  }
  if (['application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'].includes(mime)
    && !starts(0x50, 0x4b)) throw new Error('Input content does not match an Office document container');
  if (mime.startsWith('text/') && bytes.slice(0, 8_192).includes(0)) throw new Error('Text Input contains binary null bytes');
  return mime;
}

function nameFromUrl(value: string): string {
  const path = new URL(value).pathname;
  return decodeURIComponent(path.split('/').filter(Boolean).at(-1) ?? 'download');
}
