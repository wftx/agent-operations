import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  AgentOperationsConfiguration,
  ProjectDefinition,
} from '../../agent-operations-contracts/src/index.js';

export interface LoadedAgentOperationsConfiguration {
  readonly configuration: AgentOperationsConfiguration;
  readonly configPath: string;
  readonly baseDirectory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function parseProject(value: unknown, index: number): ProjectDefinition {
  if (!isRecord(value)) throw new Error(`projects[${index}] must be an object`);
  const id = nonEmptyString(value.id, `projects[${index}].id`);
  const name = nonEmptyString(value.name, `projects[${index}].name`);
  const repositoriesValue = value.repositories ?? [];
  const runtimesValue = value.runtimeAgentIds ?? [];
  if (!Array.isArray(repositoriesValue)) throw new Error(`projects[${index}].repositories must be an array`);
  if (!Array.isArray(runtimesValue)) throw new Error(`projects[${index}].runtimeAgentIds must be an array`);

  const repositories = repositoriesValue.map((repository, repositoryIndex) => {
    if (!isRecord(repository)) {
      throw new Error(`projects[${index}].repositories[${repositoryIndex}] must be an object`);
    }
    return {
      path: nonEmptyString(repository.path, `projects[${index}].repositories[${repositoryIndex}].path`),
    };
  });
  const runtimeAgentIds = runtimesValue.map((agentId, runtimeIndex) =>
    nonEmptyString(agentId, `projects[${index}].runtimeAgentIds[${runtimeIndex}]`));

  return {
    id,
    name,
    repositories,
    runtimeAgentIds: [...new Set(runtimeAgentIds)],
  };
}

export function parseAgentOperationsConfiguration(value: unknown): AgentOperationsConfiguration {
  if (!isRecord(value)) throw new Error('Agent Operations configuration must be an object');
  if (value.version !== 1) throw new Error('Agent Operations configuration version must be 1');
  if (!Array.isArray(value.projects)) throw new Error('Agent Operations configuration projects must be an array');
  const projects = value.projects.map(parseProject);
  const ids = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.id)) throw new Error(`Duplicate Agent Operations project ID: ${project.id}`);
    ids.add(project.id);
  }
  return { version: 1, projects };
}

export async function loadAgentOperationsConfiguration(
  requestedPath: string,
): Promise<LoadedAgentOperationsConfiguration> {
  const configPath = resolve(requestedPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not load Agent Operations configuration at ${configPath}: ${(error as Error).message}`);
  }
  return {
    configuration: parseAgentOperationsConfiguration(parsed),
    configPath,
    baseDirectory: dirname(configPath),
  };
}
