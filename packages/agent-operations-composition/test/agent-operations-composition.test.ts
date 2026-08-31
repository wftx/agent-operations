import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentOperationsComposition } from '../src/index.js';

const roots: string[] = [];
const previousStateDirectory = process.env.AGENT_OPERATIONS_STATE_DIR;

afterEach(() => {
  if (previousStateDirectory === undefined) delete process.env.AGENT_OPERATIONS_STATE_DIR;
  else process.env.AGENT_OPERATIONS_STATE_DIR = previousStateDirectory;
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('Agent Operations composition root', () => {
  it('assembles application facing services without starting a provider or runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-composition-'));
    roots.push(root);
    process.env.AGENT_OPERATIONS_STATE_DIR = root;

    const composition = createAgentOperationsComposition();
    try {
      expect(composition.operator).toEqual(expect.objectContaining({
        listProjects: expect.any(Function),
        runOperatorJob: expect.any(Function),
      }));
      expect(composition.conversation).toEqual(expect.objectContaining({
        sendTurn: expect.any(Function),
        getConversationState: expect.any(Function),
      }));
      expect(composition.tools).toEqual(expect.objectContaining({ execute: expect.any(Function) }));
    } finally {
      await composition.close();
    }
  });
});
