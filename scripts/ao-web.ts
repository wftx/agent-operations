import { startOperatorWebServer } from '../apps/ao-web/src/server.js';
import { createAgentOperationsComposition } from '../packages/agent-operations-composition/src/index.js';

startOperatorWebServer(createAgentOperationsComposition({ startRunner: true }));
