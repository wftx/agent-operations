import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REPOSITORY_READ_MAX_FILE_BYTES,
  REPOSITORY_READ_MAX_LIST_ENTRIES,
  REPOSITORY_READ_MAX_PATH_LENGTH,
  REPOSITORY_READ_MAX_SEARCH_RESULTS,
  RepositoryReadError,
  RootScopedRepositoryReader,
} from '../../../src/pty/repository-read-capability.js';

const temporaryRoots: string[] = [];

function fixture(): { root: string; outside: string; reader: RootScopedRepositoryReader } {
  const root = mkdtempSync(join(tmpdir(), 'ao-reader-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'ao-reader-outside-'));
  temporaryRoots.push(root, outside);
  mkdirSync(join(root, 'src', 'nested'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'alpha\nbeta\ngamma\n', 'utf8');
  writeFileSync(join(root, 'src', 'contract.ts'), 'filesystem\nnetwork\nenvironment\n', 'utf8');
  writeFileSync(join(root, 'src', 'nested', 'other.ts'), 'network\n', 'utf8');
  writeFileSync(join(outside, 'secret.txt'), 'outside secret\n', 'utf8');
  return { root: realpathSync(root), outside: realpathSync(outside), reader: new RootScopedRepositoryReader(realpathSync(root)) };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RootScopedRepositoryReader', () => {
  it('lists root and nested paths with deterministic bounds', () => {
    const { root, reader } = fixture();
    for (let index = 0; index < REPOSITORY_READ_MAX_LIST_ENTRIES + 5; index++) {
      writeFileSync(join(root, `entry-${String(index).padStart(3, '0')}.txt`), 'x', 'utf8');
    }
    const listed = reader.list();
    expect(listed.entries).toHaveLength(REPOSITORY_READ_MAX_LIST_ENTRIES);
    expect(listed.truncated).toBe(true);
    expect(reader.list('src').entries.map(entry => entry.path)).toEqual([
      'src/contract.ts',
      'src/nested',
    ]);
  });

  it('reads bounded UTF-8 line ranges', () => {
    const { reader } = fixture();
    expect(reader.read('README.md', 2, 1)).toEqual({
      path: 'README.md',
      startLine: 2,
      endLine: 2,
      totalLines: 4,
      truncated: true,
      text: 'beta',
    });
  });

  it('rejects oversized, binary, missing, and directory read targets', () => {
    const { root, reader } = fixture();
    writeFileSync(join(root, 'huge.txt'), Buffer.alloc(REPOSITORY_READ_MAX_FILE_BYTES + 1, 65));
    writeFileSync(join(root, 'binary.bin'), Buffer.from([65, 0, 66]));
    expectCode(() => reader.read('huge.txt'), 'FILE_TOO_LARGE');
    expectCode(() => reader.read('binary.bin'), 'BINARY_FILE');
    expectCode(() => reader.read('missing.txt'), 'NOT_FOUND');
    expectCode(() => reader.read('src'), 'NOT_A_FILE');
  });

  it('fails closed on traversal, absolute paths, and symlink chains', () => {
    const { root, outside, reader } = fixture();
    symlinkSync(join(outside, 'secret.txt'), join(root, 'outside-link'));
    symlinkSync('outside-link', join(root, 'chain-link'));
    expectCode(() => reader.read('../outside'), 'PATH_ESCAPE');
    expectCode(() => reader.list('../outside'), 'PATH_ESCAPE');
    expectCode(() => reader.search('secret', '../outside'), 'PATH_ESCAPE');
    expectCode(() => reader.read(join(outside, 'secret.txt')), 'INVALID_PATH');
    expectCode(() => reader.read('x'.repeat(REPOSITORY_READ_MAX_PATH_LENGTH + 1)), 'INVALID_INPUT');
    expectCode(() => reader.read('outside-link'), 'SYMLINK_NOT_ALLOWED');
    expectCode(() => reader.read('chain-link'), 'SYMLINK_NOT_ALLOWED');
  });

  it('searches nested text with bounded results and skips binary content', () => {
    const { root, reader } = fixture();
    for (let index = 0; index < REPOSITORY_READ_MAX_SEARCH_RESULTS + 5; index++) {
      writeFileSync(join(root, 'src', `match-${index}.txt`), 'network\n', 'utf8');
    }
    writeFileSync(join(root, 'src', 'binary.dat'), Buffer.from([110, 0, 120]));
    const result = reader.search('network', 'src');
    expect(result.matches).toHaveLength(REPOSITORY_READ_MAX_SEARCH_RESULTS);
    expect(result.truncated).toBe(true);
    expect(result.matches.every(match => match.path.startsWith('src/'))).toBe(true);
  });

  it('hides and rejects Git internals and obvious secret-bearing files', () => {
    const { root, reader } = fixture();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), 'secret', 'utf8');
    writeFileSync(join(root, '.env'), 'TOKEN=secret', 'utf8');
    writeFileSync(join(root, 'service-account.json'), '{"private_key":"secret"}', 'utf8');
    writeFileSync(join(root, 'src', 'roger-service-account.json'), '{"private_key":"secret"}', 'utf8');
    writeFileSync(join(root, 'src', 'application_default_credentials.json'), '{"token":"secret"}', 'utf8');
    writeFileSync(join(root, 'src', 'service-account-guide.md'), 'public documentation', 'utf8');
    const listed = reader.list();
    expect(listed.entries.map(entry => entry.path)).not.toContain('.git');
    expect(listed.entries.map(entry => entry.path)).not.toContain('.env');
    expect(listed.entries.map(entry => entry.path)).not.toContain('service-account.json');
    expect(listed.omittedRestricted).toBe(3);
    expect(reader.list('src').entries.map(entry => entry.path)).not.toContain('src/roger-service-account.json');
    expect(reader.list('src').entries.map(entry => entry.path)).not.toContain('src/application_default_credentials.json');
    expect(reader.read('src/service-account-guide.md').text).toBe('public documentation');
    expect(reader.search('secret').matches).toEqual([]);
    expectCode(() => reader.read('.git/config'), 'RESTRICTED_PATH');
    expectCode(() => reader.read('.env'), 'RESTRICTED_PATH');
    expectCode(() => reader.read('service-account.json'), 'RESTRICTED_PATH');
    expectCode(() => reader.read('src/roger-service-account.json'), 'RESTRICTED_PATH');
    expectCode(() => reader.read('src/application_default_credentials.json'), 'RESTRICTED_PATH');
  });
});

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryReadError);
    expect((error as RepositoryReadError).code).toBe(code);
  }
}
