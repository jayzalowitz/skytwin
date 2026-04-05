import { loadConfig } from '@skytwin/config';
import type { SignalConnector, RawSignal } from '@skytwin/connectors';
import {
  GmailConnector,
  GoogleCalendarConnector,
  DbTokenStore,
} from '@skytwin/connectors';
import { oauthRepository, approvalRepository } from '@skytwin/db';

const config = loadConfig();

/**
 * SkyTwin Worker Process
 *
 * Polls signal connectors for new data and forwards signals to the
 * API for processing through the decision pipeline.
 *
 * Supports multiple users: for each user with active OAuth tokens,
 * the worker polls their connected services.
 */

let running = true;

interface UserConnectors {
  userId: string;
  connectors: SignalConnector[];
}

/**
 * Forward a signal to the API for processing.
 */
async function forwardSignalToApi(signal: RawSignal, userId: string): Promise<void> {
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
        userId,
      }),
    });

    if (!response.ok) {
      console.error(
        `[worker] Failed to forward signal ${signal.id} for user ${userId}: HTTP ${response.status}`,
      );
    } else {
      console.info(
        `[worker] Forwarded signal ${signal.id} (${signal.source}/${signal.type}) for user ${userId}`,
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
 * Poll connectors for a single user.
 */
async function pollUser(userConnectors: UserConnectors): Promise<void> {
  for (const connector of userConnectors.connectors) {
    try {
      const signals = await connector.poll();
      for (const signal of signals) {
        await forwardSignalToApi(signal, userConnectors.userId);
      }
    } catch (error) {
      console.error(
        `[worker] Error polling ${connector.name} for user ${userConnectors.userId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * Discover users with active OAuth tokens and build their connectors.
 * Returns empty array if no users have connected accounts yet.
 */
async function discoverUsers(): Promise<UserConnectors[]> {
  try {
    const tokens = await oauthRepository.getUsersWithActiveTokens();
    if (tokens.length === 0) {
      return [];
    }

    // Group tokens by user
    const userTokens = new Map<string, typeof tokens>();
    for (const token of tokens) {
      const existing = userTokens.get(token.user_id) ?? [];
      existing.push(token);
      userTokens.set(token.user_id, existing);
    }

    const result: UserConnectors[] = [];
    for (const [userId, userTokenList] of userTokens) {
      const connectors: SignalConnector[] = [];
      const hasGoogle = userTokenList.some((t) => t.provider === 'google');

      if (hasGoogle) {
        const tokenStore = new DbTokenStore(oauthRepository, {
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
          redirectUri: config.googleRedirectUri,
        });
        connectors.push(new GmailConnector(userId, tokenStore));
        connectors.push(new GoogleCalendarConnector(userId, tokenStore));
      }

      if (connectors.length > 0) {
        result.push({ userId, connectors });
      }
    }

    return result;
  } catch (error) {
    console.error(
      '[worker] Error discovering users:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Main worker loop.
 */
async function main(): Promise<void> {
  console.info('[worker] Starting SkyTwin worker...');
  console.info(`[worker] API base URL: ${config.apiBaseUrl}`);
  console.info(`[worker] Poll interval: ${config.workerPollIntervalMs}ms`);

  // Discover users and set up connectors
  let userConnectors = await discoverUsers();
  if (userConnectors.length === 0) {
    console.info('[worker] No users with connected accounts yet — waiting for first connection');
  } else {
    console.info(`[worker] Tracking ${userConnectors.length} user(s)`);
  }

  // Connect all
  for (const uc of userConnectors) {
    for (const connector of uc.connectors) {
      await connector.connect();
      console.info(`[worker] Connected: ${connector.name} for user ${uc.userId}`);
    }
  }

  let pollCount = 0;

  // Poll loop
  while (running) {
    for (const uc of userConnectors) {
      await pollUser(uc);
    }

    pollCount++;

    // Expire stale approval requests every 10 poll cycles
    if (pollCount % 10 === 0) {
      try {
        const expired = await approvalRepository.expirePending();
        if (expired > 0) {
          console.info(`[worker] Expired ${expired} stale approval request(s)`);
        }
      } catch (error) {
        console.error(
          '[worker] Error expiring approvals:',
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Re-discover users every 10 poll cycles to pick up new connections
    if (pollCount % 10 === 0) {
      const newUserConnectors = await discoverUsers();
      if (newUserConnectors.length !== userConnectors.length) {
        console.info(`[worker] User count changed: ${userConnectors.length} → ${newUserConnectors.length}`);
        // Disconnect old connectors
        for (const uc of userConnectors) {
          for (const connector of uc.connectors) {
            await connector.disconnect();
          }
        }
        // Connect new ones
        for (const uc of newUserConnectors) {
          for (const connector of uc.connectors) {
            await connector.connect();
          }
        }
        userConnectors = newUserConnectors;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, config.workerPollIntervalMs));
  }

  // Graceful shutdown
  console.info('[worker] Shutting down...');
  for (const uc of userConnectors) {
    for (const connector of uc.connectors) {
      await connector.disconnect();
      console.info(`[worker] Disconnected: ${connector.name} for user ${uc.userId}`);
    }
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
