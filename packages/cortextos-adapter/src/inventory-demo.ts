import { CortextOSRuntimeAdapter } from './index.js';

async function main(): Promise<void> {
  const adapter = new CortextOSRuntimeAdapter();
  const [health, agents] = await Promise.all([
    adapter.getHealth(),
    adapter.listAgents(),
  ]);

  console.log(JSON.stringify({
    title: 'Agent Operations Runtime Inventory',
    health,
    agents,
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
