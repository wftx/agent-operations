const PREFIX = 'cortextos:codex-turn:v1';
const CODEX_ID = /^[A-Za-z0-9_-]{1,200}$/;

export interface CodexExecutionReference {
  readonly provider: 'codex';
  readonly threadId: string;
  readonly turnId: string;
}

export function createCodexExecutionReference(threadId: string, turnId: string): string {
  if (!CODEX_ID.test(threadId) || !CODEX_ID.test(turnId)) {
    throw new Error('Cannot create a Codex execution reference from invalid provider IDs');
  }
  return `${PREFIX}:${threadId}:${turnId}`;
}

export function parseCodexExecutionReference(value: string): CodexExecutionReference | null {
  const parts = value.split(':');
  if (parts.length !== 5 || parts.slice(0, 3).join(':') !== PREFIX) return null;
  const [, , , threadId, turnId] = parts;
  if (!CODEX_ID.test(threadId) || !CODEX_ID.test(turnId)) return null;
  return { provider: 'codex', threadId, turnId };
}
