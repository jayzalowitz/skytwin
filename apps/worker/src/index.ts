import { loadConfig } from '@skytwin/config';
import type { SignalConnector, RawSignal } from '@skytwin/connectors';
import { MockEmailConnector, MockCalendarConnector } from '@skytwin/connectors';

const config = loadConfig();

/**
 * SkyTwin Worker Process
 *
 * This worker polls signal connectors for new data and forwards
 * signals to the API for processing through the decision pipeline.
 */

let running = true;
const connectors: SignalConnector[] = [];

/**
 * Forward a signal to the API for processing.
 */
async function forwardSignalToApi(signal: RawSignal): Promise<void> {
  const url = `${config.apiBaseUrl}/api/events/ingest`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...signal.data,
        source: signal.source,
        type: signal.type,
        signalId: signal.id,
        userId: 'default-user', // In production, this would come from auth context
      }),
    });

    if (!response.ok) {
      console.error(
        `[worker] Failed to forward signal ${signal.id}: HTTP ${response.status}`,
      );
    } else {
      console.info(
        `[worker] Forwarded signal ${signal.id} (${signal.source}/${signal.type})`,
      );
    }
  } catch (error) {
    console.error(
      `[worker] Error forwarding signal ${signal.id}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Poll all connectors once.
 */
async function pollAll(): Promise<void> {
  for (const connector of connectors) {
    try {
      const signals = await connector.poll();
      for (const signal of signals) {
        await forwardSignalToApi(signal);
      }
    } catch (error) {
      console.error(
        `[worker] Error polling ${connector.name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * Main worker loop.
 */
async function main(): Promise<void> {
  console.info('[worker] Starting SkyTwin worker...');
  console.info(`[worker] API base URL: ${config.apiBaseUrl}`);
  console.info(`[worker] Poll interval: ${config.workerPollIntervalMs}ms`);

  // Set up connectors
  const emailConnector = new MockEmailConnector();
  const calendarConnector = new MockCalendarConnector();

  connectors.push(emailConnector, calendarConnector);

  // Connect all
  for (const connector of connectors) {
    await connector.connect();
    console.info(`[worker] Connected: ${connector.name}`);
  }

  // Poll loop
  while (running) {
    await pollAll();
    await new Promise((resolve) => setTimeout(resolve, config.workerPollIntervalMs));
  }

  // Graceful shutdown
  console.info('[worker] Shutting down...');
  for (const connector of connectors) {
    await connector.disconnect();
    console.info(`[worker] Disconnected: ${connector.name}`);
  }
  console.info('[worker] Worker stopped.');
}

// Graceful shutdown handlers
process.on('SIGINT', () => {
  console.info('[worker] Received SIGINT, shutting down gracefully...');
  running = false;
});

process.on('SIGTERM', () => {
  console.info('[worker] Received SIGTERM, shutting down gracefully...');
  running = false;
});

// Start the worker
void main().catch((error) => {
  console.error('[worker] Fatal error:', error);
  process.exit(1);
});
