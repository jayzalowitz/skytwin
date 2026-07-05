import { createInterface } from 'node:readline';
import { parseRunnerConfig } from './config.js';
import { createIdleMinerRunner } from './runner.js';

/**
 * Managed idle-miner process. Spawned by the desktop `ServiceManager` (see
 * `docs/idle-miner-desktop-integration.md`); NOT run standalone in normal use.
 *
 * This is thin glue — the testable logic lives in `config.ts` (fail-closed
 * parse) and `runner.ts` (assembly + control protocol). It:
 *   1. refuses to start unless the config is valid (flag on, user resolved, …),
 *   2. reads idle/active/stop control words the parent writes to stdin (one per
 *      line — the parent owns OS idle detection; this child has no powerMonitor),
 *   3. shuts down cleanly on SIGTERM/SIGINT so the file index is flushed.
 */
function main(): void {
  const parsed = parseRunnerConfig(process.env);
  if (!parsed.ok) {
    console.error(`[idle-miner-runner] refusing to start: ${parsed.error}`);
    process.exit(1);
    return;
  }

  const runner = createIdleMinerRunner(parsed.config);

  const rl = createInterface({ input: process.stdin });

  let shuttingDown = false;
  const appShutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    await runner.shutdown(); // drains the in-flight batch + flushes before exit
    process.exit(0);
  };

  rl.on('line', (line) => {
    // `stop` is a request to terminate the whole process; idle/active go to the
    // runner. Exit is owned here, not in the runner.
    if (line.trim().toLowerCase() === 'stop') {
      void appShutdown();
      return;
    }
    runner.handleControlLine(line);
  });

  process.on('SIGTERM', () => void appShutdown());
  process.on('SIGINT', () => void appShutdown());
  // If the parent closes our stdin (it exited / detached), stop too.
  rl.on('close', () => void appShutdown());
}

main();
