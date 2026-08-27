import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'path';

export const REPOSITORY_READ_MAX_PATH_LENGTH = 1_024;
export const REPOSITORY_READ_MAX_LIST_ENTRIES = 200;
export const REPOSITORY_READ_MAX_FILE_BYTES = 1_048_576;
export const REPOSITORY_READ_MAX_RESPONSE_BYTES = 65_536;
export const REPOSITORY_READ_MAX_LINES = 500;
export const REPOSITORY_READ_MAX_SEARCH_RESULTS = 100;
export const REPOSITORY_READ_MAX_SEARCH_FILES = 1_000;
export const REPOSITORY_READ_MAX_SEARCH_BYTES = 8_388_608;

export type RepositoryReadOperation = 'list' | 'read' | 'search';

export interface RepositoryReadAuditEvent {
  readonly operation: RepositoryReadOperation;
  readonly path: string;
  readonly query?: string;
  readonly success: boolean;
  readonly occurredAt: string;
  readonly errorCode?: string;
}

export interface RepositoryListResult {
  readonly path: string;
  readonly entries: readonly {
    readonly path: string;
    readonly type: 'file' | 'directory' | 'symlink-blocked';
    readonly size?: number;
  }[];
  readonly truncated: boolean;
  readonly omittedRestricted: number;
}

export interface RepositoryReadResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly text: string;
}

export interface RepositorySearchResult {
  readonly path: string;
  readonly query: string;
  readonly matches: readonly {
    readonly path: string;
    readonly line: number;
    readonly text: string;
  }[];
  readonly truncated: boolean;
  readonly scannedFiles: number;
  readonly skippedFiles: number;
}

export class RepositoryReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RepositoryReadError';
  }
}

/** Root-scoped, shell-free repository reader used only by approved dynamic tools. */
export class RootScopedRepositoryReader {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root) || root.includes('\0') || resolve(root) !== root) {
      throw new RepositoryReadError('INVALID_ROOT', 'Repository reader root must be canonical and absolute');
    }
    const canonical = realpathSync(root);
    if (canonical !== root || !statSync(canonical).isDirectory()) {
      throw new RepositoryReadError('INVALID_ROOT', 'Repository reader root must name its canonical directory');
    }
    this.root = canonical;
  }

  list(path = '.'): RepositoryListResult {
    const target = this.resolveExisting(path, 'directory');
    const entries = readdirSync(target.absolute, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    const visible: RepositoryListResult['entries'][number][] = [];
    let omittedRestricted = 0;
    for (const entry of entries) {
      const relativePath = joinRelative(target.relative, entry.name);
      if (isRestrictedRelativePath(relativePath)) {
        omittedRestricted++;
        continue;
      }
      if (visible.length >= REPOSITORY_READ_MAX_LIST_ENTRIES) break;
      const absolute = resolve(this.root, relativePath);
      const metadata = lstatSync(absolute);
      visible.push({
        path: relativePath,
        type: metadata.isSymbolicLink()
          ? 'symlink-blocked'
          : metadata.isDirectory() ? 'directory' : 'file',
        ...(!metadata.isDirectory() && !metadata.isSymbolicLink()
          ? { size: metadata.size }
          : {}),
      });
    }
    return {
      path: target.relative,
      entries: visible,
      truncated: entries.length - omittedRestricted > visible.length,
      omittedRestricted,
    };
  }

  read(path: string, startLine = 1, maxLines = 200): RepositoryReadResult {
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new RepositoryReadError('INVALID_RANGE', 'startLine must be a positive integer');
    }
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > REPOSITORY_READ_MAX_LINES) {
      throw new RepositoryReadError(
        'INVALID_RANGE',
        `maxLines must be between 1 and ${REPOSITORY_READ_MAX_LINES}`,
      );
    }
    const target = this.resolveExisting(path, 'file');
    const metadata = statSync(target.absolute);
    if (metadata.size > REPOSITORY_READ_MAX_FILE_BYTES) {
      throw new RepositoryReadError(
        'FILE_TOO_LARGE',
        `Repository file exceeds ${REPOSITORY_READ_MAX_FILE_BYTES} bytes`,
      );
    }
    const text = decodeText(readFileSync(target.absolute));
    const lines = text.split(/\r?\n/);
    const selected: string[] = [];
    let bytes = 0;
    const startIndex = Math.min(startLine - 1, lines.length);
    for (let index = startIndex; index < lines.length && selected.length < maxLines; index++) {
      const next = lines[index];
      const nextBytes = Buffer.byteLength(`${next}${selected.length ? '\n' : ''}`, 'utf8');
      if (bytes + nextBytes > REPOSITORY_READ_MAX_RESPONSE_BYTES) break;
      selected.push(next);
      bytes += nextBytes;
    }
    const endLine = selected.length ? startIndex + selected.length : startIndex;
    return {
      path: target.relative,
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: endLine < lines.length,
      text: selected.join('\n'),
    };
  }

  search(query: string, path = '.'): RepositorySearchResult {
    const cleanQuery = requireString(query, 'query', 200);
    const target = this.resolveExisting(path, 'either');
    const candidates = this.collectFiles(target.absolute, target.relative);
    const matches: RepositorySearchResult['matches'][number][] = [];
    let scannedFiles = 0;
    let skippedFiles = 0;
    let scannedBytes = 0;
    let truncated = candidates.truncated;

    for (const candidate of candidates.files) {
      if (matches.length >= REPOSITORY_READ_MAX_SEARCH_RESULTS
        || scannedFiles >= REPOSITORY_READ_MAX_SEARCH_FILES) {
        truncated = true;
        break;
      }
      const metadata = statSync(candidate.absolute);
      if (metadata.size > REPOSITORY_READ_MAX_FILE_BYTES
        || scannedBytes + metadata.size > REPOSITORY_READ_MAX_SEARCH_BYTES) {
        skippedFiles++;
        truncated = true;
        continue;
      }
      let text: string;
      try {
        text = decodeText(readFileSync(candidate.absolute));
      } catch (error) {
        if (error instanceof RepositoryReadError && error.code === 'BINARY_FILE') {
          skippedFiles++;
          continue;
        }
        throw error;
      }
      scannedFiles++;
      scannedBytes += metadata.size;
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.includes(cleanQuery)) continue;
        matches.push({
          path: candidate.relative,
          line: index + 1,
          text: line.slice(0, 300),
        });
        if (matches.length >= REPOSITORY_READ_MAX_SEARCH_RESULTS) {
          truncated = true;
          break;
        }
      }
    }
    return {
      path: target.relative,
      query: cleanQuery,
      matches,
      truncated,
      scannedFiles,
      skippedFiles,
    };
  }

  private collectFiles(
    absolute: string,
    relativePath: string,
  ): { files: Array<{ absolute: string; relative: string }>; truncated: boolean } {
    const initial = lstatSync(absolute);
    if (initial.isFile()) return { files: [{ absolute, relative: relativePath }], truncated: false };
    const files: Array<{ absolute: string; relative: string }> = [];
    const pending = [{ absolute, relative: relativePath }];
    let truncated = false;
    while (pending.length) {
      const directory = pending.pop()!;
      const entries = readdirSync(directory.absolute, { withFileTypes: true })
        .sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of entries) {
        const childRelative = joinRelative(directory.relative, entry.name);
        if (isRestrictedRelativePath(childRelative)) continue;
        const childAbsolute = resolve(this.root, childRelative);
        const metadata = lstatSync(childAbsolute);
        if (metadata.isSymbolicLink()) continue;
        if (metadata.isDirectory()) pending.push({ absolute: childAbsolute, relative: childRelative });
        else if (metadata.isFile()) files.push({ absolute: childAbsolute, relative: childRelative });
        if (files.length >= REPOSITORY_READ_MAX_SEARCH_FILES) {
          truncated = true;
          return { files, truncated };
        }
      }
    }
    return { files, truncated };
  }

  private resolveExisting(
    requestedPath: string,
    kind: 'file' | 'directory' | 'either',
  ): { absolute: string; relative: string } {
    const clean = normalizeRelativePath(requestedPath);
    if (isRestrictedRelativePath(clean)) {
      throw new RepositoryReadError('RESTRICTED_PATH', 'Repository path is restricted');
    }
    const candidate = resolve(this.root, clean);
    if (!isWithinRoot(this.root, candidate)) {
      throw new RepositoryReadError('PATH_ESCAPE', 'Repository path escapes the authorized root');
    }
    const segments = clean === '.' ? [] : clean.split('/');
    let cursor = this.root;
    for (const segment of segments) {
      cursor = resolve(cursor, segment);
      let metadata;
      try {
        metadata = lstatSync(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new RepositoryReadError('NOT_FOUND', `Repository path does not exist: ${clean}`);
        }
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        throw new RepositoryReadError('SYMLINK_NOT_ALLOWED', 'Repository reader does not follow symlinks');
      }
    }
    const canonical = realpathSync(candidate);
    if (!isWithinRoot(this.root, canonical)) {
      throw new RepositoryReadError('PATH_ESCAPE', 'Repository path resolves outside the authorized root');
    }
    const metadata = statSync(canonical);
    if (kind === 'file' && !metadata.isFile()) {
      throw new RepositoryReadError('NOT_A_FILE', 'Repository read target is not a regular file');
    }
    if (kind === 'directory' && !metadata.isDirectory()) {
      throw new RepositoryReadError('NOT_A_DIRECTORY', 'Repository list target is not a directory');
    }
    if (kind === 'either' && !metadata.isFile() && !metadata.isDirectory()) {
      throw new RepositoryReadError('UNSUPPORTED_TYPE', 'Repository search target is not a file or directory');
    }
    return { absolute: canonical, relative: clean };
  }
}

function normalizeRelativePath(value: string): string {
  const clean = requireString(value || '.', 'path', REPOSITORY_READ_MAX_PATH_LENGTH);
  if (clean.includes('\0') || isAbsolute(clean)) {
    throw new RepositoryReadError('INVALID_PATH', 'Repository paths must be relative');
  }
  const absolute = resolve('/', clean);
  const normalized = relative('/', absolute).split(sep).join('/') || '.';
  if (clean.split('/').includes('..') || normalized === '..' || normalized.startsWith('../')) {
    throw new RepositoryReadError('PATH_ESCAPE', 'Repository path traversal is not allowed');
  }
  return normalized;
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function joinRelative(parent: string, child: string): string {
  return parent === '.' ? child : `${parent}/${child}`;
}

function isRestrictedRelativePath(path: string): boolean {
  return path.split('/').some(segment => {
    const lower = segment.toLowerCase();
    return lower === '.git'
      || lower === '.ssh'
      || lower === '.env'
      || lower.startsWith('.env.')
      || lower === 'credentials'
      || lower.startsWith('credentials.')
      || lower === 'secrets'
      || lower.startsWith('secrets.')
      || lower === 'id_rsa'
      || lower === 'id_ed25519'
      || lower.endsWith('.pem')
      || lower.endsWith('.key');
  });
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RepositoryReadError('INVALID_INPUT', `${field} is required`);
  }
  const clean = value.trim();
  if (clean.length > maxLength) {
    throw new RepositoryReadError('INVALID_INPUT', `${field} exceeds ${maxLength} characters`);
  }
  return clean;
}

function decodeText(buffer: Buffer): string {
  if (buffer.includes(0)) throw new RepositoryReadError('BINARY_FILE', 'Binary repository files are not readable');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new RepositoryReadError('BINARY_FILE', 'Repository file is not valid UTF-8 text');
  }
}
