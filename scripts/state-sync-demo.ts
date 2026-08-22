import { join } from 'node:path';
import {
  AgentOperationsStateSyncService,
  loadAgentOperationsConfiguration,
} from '../packages/agent-operations-core/src/index.js';
import { CortextOSRuntimeAdapter } from '../packages/cortextos-adapter/src/index.js';
import { GitRepositoryAdapter } from '../packages/git-adapter/src/index.js';
import {
  SqliteAgentOperationsStateStore,
  resolveAgentOperationsStateLocation,
} from '../packages/sqlite-state-adapter/src/index.js';

async function main(): Promise<void> {
  const requestedConfig = process.env.AGENT_OPERATIONS_CONFIG
    ?? join(process.cwd(), 'agent-operations.config.json');
  const loaded = await loadAgentOperationsConfiguration(requestedConfig);
  const location = resolveAgentOperationsStateLocation();
  const store = SqliteAgentOperationsStateStore.open({
    databasePath: location.databasePath,
    installationLabel: process.env.AGENT_OPERATIONS_INSTALLATION_LABEL,
  });
  const service = new AgentOperationsStateSyncService(
    new GitRepositoryAdapter(),
    new CortextOSRuntimeAdapter(),
    store,
  );
  await service.sync(loaded.configuration, loaded.baseDirectory);
  await store.close();

  const reopened = SqliteAgentOperationsStateStore.open({ databasePath: location.databasePath });
  try {
    const installation = await reopened.getInstallation();
    const projects = await reopened.listProjects();
    const durableProjects = await Promise.all(projects.map(async project => {
      const repositoryIds = await reopened.listProjectRepositoryIds(project.id);
      const repositories = await Promise.all(repositoryIds.map(async repositoryId => {
        const repository = await reopened.getRepository(repositoryId);
        const checkouts = await reopened.listCheckoutBindings(repositoryId);
        return {
          repository,
          checkouts: await Promise.all(checkouts.map(async checkout => ({
            ...checkout,
            latestObservation: await reopened.getLatestRepositoryObservation(checkout.id),
          }))),
        };
      }));
      const runtimeAgentIds = await reopened.listProjectRuntimeAgentIds(project.id);
      const runtimes = await Promise.all(runtimeAgentIds.map(async agentId => ({
        agentId,
        latestObservation: await reopened.getLatestRuntimeObservation(project.id, agentId),
      })));
      return { project, repositories, runtimes };
    }));

    console.log(JSON.stringify({
      title: 'Agent Operations Durable State',
      databasePath: reopened.databasePath,
      installation,
      projects: durableProjects,
    }, null, 2));
  } finally {
    await reopened.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
