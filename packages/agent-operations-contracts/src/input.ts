import { createHash, randomUUID } from 'node:crypto';

export type InputSourceType = 'uploaded-file' | 'authorized-url';
export type InputIngestionState = 'complete';
export type InputValidationState = 'valid';

/** Immutable operator-provided material stored outside source repositories. */
export interface DurableInput {
  readonly id: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly sourceType: InputSourceType;
  readonly originalUrl?: string;
  readonly finalUrl?: string;
  readonly projectId?: string;
  /** Opaque AO-owned storage reference. Never expose this to a provider. */
  readonly storageReference: string;
  readonly ingestionState: InputIngestionState;
  readonly validationState: InputValidationState;
  readonly createdAt: string;
}

/** Provider-safe metadata. It deliberately omits AO storage paths. */
export interface InputMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly sourceType: InputSourceType;
  readonly originalUrl?: string;
  readonly finalUrl?: string;
  readonly projectId?: string;
  readonly createdAt: string;
}

export interface StoredInputObject {
  readonly storageReference: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface InputObjectStorageAdapter {
  store(inputId: string, bytes: Uint8Array): Promise<StoredInputObject>;
  read(storageReference: string): Promise<Uint8Array>;
  remove(storageReference: string): Promise<void>;
}

export interface AuthorizedUrlFetchResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly displayName?: string;
}

/** HTTP retrieval port. Production implementations must enforce SSRF and response bounds. */
export interface AuthorizedUrlInputFetcher {
  fetch(url: string): Promise<AuthorizedUrlFetchResult>;
}

export function createInputId(): string {
  return `input:${randomUUID()}`;
}

export function createLocalFolderResourceId(installationId: string, canonicalPath: string): string {
  const digest = createHash('sha256')
    .update(installationId.trim())
    .update('\0')
    .update(canonicalPath.trim())
    .digest('hex');
  return `resource:folder:${digest}`;
}

export function toInputMetadata(input: DurableInput): InputMetadata {
  const { storageReference: _storageReference, ingestionState: _ingestionState,
    validationState: _validationState, ...metadata } = input;
  return metadata;
}
