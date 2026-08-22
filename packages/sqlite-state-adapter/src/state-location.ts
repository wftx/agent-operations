import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const AGENT_OPERATIONS_STATE_DIRECTORY_ENV = 'AGENT_OPERATIONS_STATE_DIR';
export const AGENT_OPERATIONS_DATABASE_PATH_ENV = 'AGENT_OPERATIONS_DATABASE_PATH';

export interface AgentOperationsStateLocation {
  readonly stateDirectory: string;
  readonly databasePath: string;
}

export function resolveAgentOperationsStateLocation(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): AgentOperationsStateLocation {
  const databaseOverride = environment[AGENT_OPERATIONS_DATABASE_PATH_ENV]?.trim();
  if (databaseOverride) {
    const databasePath = resolve(databaseOverride);
    return { stateDirectory: dirname(databasePath), databasePath };
  }
  const directoryOverride = environment[AGENT_OPERATIONS_STATE_DIRECTORY_ENV]?.trim();
  const stateDirectory = resolve(directoryOverride || join(homeDirectory, '.agent-operations'));
  return {
    stateDirectory,
    databasePath: join(stateDirectory, 'state.db'),
  };
}
