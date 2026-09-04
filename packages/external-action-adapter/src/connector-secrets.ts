import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Private node adapter. Never handed to a model, state store, or Web renderer. */
export interface ConnectorSecrets {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  stateHash?: string;
  browserHash?: string;
  stateExpiresAt?: number;
}
export class NodeConnectorSecretStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  private root(): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, {recursive: true, mode: 0o700});
    const s = lstatSync(this.directory);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700 || s.uid !== process.getuid?.()) throw new Error('Protected connector storage unavailable');
  }
  private path(ref: string): string {
    if (!/^secret:[a-f0-9]{64}$/.test(ref)) throw new Error('Invalid protected credential reference');
    return join(this.directory, ref.slice(7) + '.json');
  }
  read(ref: string): ConnectorSecrets | null {
    this.root(); const path = this.path(ref);
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Protected connector storage unavailable'); }
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid?.() || s.size > 32768) throw new Error();
      return JSON.parse(readFileSync(fd, 'utf8')) as ConnectorSecrets;
    } catch { throw new Error('Protected connector storage unavailable'); }
    finally { closeSync(fd); }
  }
  write(ref: string, secret: ConnectorSecrets): void {
    this.root(); const path = this.path(ref); const temp = path + '.' + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify(secret), {flag:'wx', mode:0o600});
      renameSync(temp, path);
    } catch { if (existsSync(temp)) unlinkSync(temp); throw new Error('Protected connector storage unavailable'); }
  }
  remove(ref: string): void { this.root(); const path = this.path(ref); if (existsSync(path)) unlinkSync(path); }
  async exclusive<T>(ref: string, work: () => Promise<T>): Promise<T> {
    this.root(); const path = this.path(ref) + '.lock'; let fd: number;
    try { fd = openSync(path, 'wx', 0o600); } catch { throw new Error('Connection is busy. No operation was retried.'); }
    try { return await work(); } finally { closeSync(fd); unlinkSync(path); }
  }
}
