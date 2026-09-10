import 'dotenv/config';
import { RelayAgent } from './relay-agent.js';

const agent = new RelayAgent();
let stopping = false;

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.error(`[agent] ${signal}: shutting down`);
  await agent.stop();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stop(signal).finally(() => process.exit(0));
  });
}

await agent.run();
