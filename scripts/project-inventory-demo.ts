import { join } from 'node:path';
import { ProjectInventoryService, loadAgentOperationsConfiguration } from '../packages/agent-operations-core/src/index.js';
import { CortextOSRuntimeAdapter } from '../packages/cortextos-adapter/src/index.js';
import { GitRepositoryAdapter } from '../packages/git-adapter/src/index.js';

async function main(): Promise<void> {
  const requestedConfig = process.env.AGENT_OPERATIONS_CONFIG
    ?? join(process.cwd(), 'agent-operations.config.json');
  const loaded = await loadAgentOperationsConfiguration(requestedConfig);
  const service = new ProjectInventoryService(
    new GitRepositoryAdapter(),
    new CortextOSRuntimeAdapter(),
  );
  const projects = await service.listProjects(loaded.configuration, loaded.baseDirectory);
  console.log(JSON.stringify({
    title: 'Agent Operations Project Inventory',
    configPath: loaded.configPath,
    projects,
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
