import { loadConfig } from '@skytwin/config';
import type { SignalConnector, RawSignal } from '@skytwin/connectors';
import {
  GmailConnector,
  GoogleCalendarConnector,
  DbTokenStore,
  OAuthRefreshError,
} from '@skytwin/connectors';
import { oauthRepository, approvalRepository } from '@skytwin/db';
import { withRetry, RetryableHttpError, CircuitBreaker, createLogger } from '@skytwin/core';

const config = loadConfig();
const log = createLogger('worker');

/** Per-user circuit breakers to skip users with persistent failures. */
const userCircuitBreakers = new Map<string, CircuitBreaker>();

function getCircuitBreaker(userId: string): CircuitBreaker {
  let breaker = userCircuitBreakers.get(userId);
  if (!breaker) {
    breaker = new CircuitBreaker(`user:${userId}`, {
      failureThreshold: 3,
      resetTimeoutMs: 300_000,   // 5 minutes
      backoffMultiplier: 2,
      maxResetTimeoutMs: 1_200_000, // 20 minutes
    });
    userCircuitBreakers.set(userId, breaker);
  }
  return breaker;
}

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
 * Forward a signal to the API for processing, with retry on transient failures.
 */
async function forwardSignalToApi(signal: RawSignal, userId: string): Promise<void> {
  const url = `${config.apiBaseUrl}/api/events/ingest`;
  const body = JSON.stringify({
    ...signal.data,
    source: signal.source,
    type: signal.type,
    signalId: signal.id,
    userId,
  });

  await withRetry(async () => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!resp.ok) {
      if ([429, 500, 502, 503].includes(resp.status)) {
        throw new RetryableHttpError(resp.status, `API ingest failed: ${resp.status}`, null);
      }
      throw new Error(`API ingest failed: ${resp.status}`);
    }

    return resp;
  }, { maxRetries: 2, baseDelayMs: 500 });

  log.info(`Forwarded signal ${signal.id} (${signal.source}/${signal.type}) for user ${userId}`);
}

/**
 * Poll connectors for a single user, guarded by per-user circuit breaker.
 */
async function pollUser(userConnectors: UserConnectors): Promise<void> {
  const breaker = getCircuitBreaker(userConnectors.userId);

  if (!breaker.canExecute()) {
    log.warn(`Skipping user ${userConnectors.userId} — circuit open, retry in ${Math.round(breaker.getTimeUntilRetryMs() / 1000)}s`, {
      retryInMs: breaker.getTimeUntilRetryMs(),
    });
    return;
  }

  let hadFailure = false;

  for (const connector of userConnectors.connectors) {
    try {
      const signals = await connector.poll();
      for (const signal of signals) {
        await forwardSignalToApi(signal, userConnectors.userId);
      }
    } catch (error) {
      hadFailure = true;

      if (error instanceof OAuthRefreshError && error.permanent) {
        log.error(`Permanent OAuth failure for user ${userConnectors.userId} on ${connector.name} — user must re-authorize`, {
          error: error.message,
          statusCode: error.statusCode,
        });
        // Force-open circuit immediately — no point retrying a revoked token
        breaker.recordFailure();
        breaker.recordFailure();
        breaker.recordFailure();
        return;
      }

      log.error(`Error polling ${connector.name} for user ${userConnectors.userId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (hadFailure) {
    breaker.recordFailure();
  } else {
    breaker.recordSuccess();
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
    log.error('Error discovering users', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Main worker loop.
 */
async function main(): Promise<void> {
  log.info('Starting SkyTwin worker...');
  log.info(`API base URL: ${config.apiBaseUrl}`);
  log.info(`Poll interval: ${config.workerPollIntervalMs}ms`);

  // Detect startup hangs (discoverUsers or connect hanging on a broken DB/network)
  const startupTimer = setTimeout(() => {
    log.error('Worker startup timed out after 30s — possible hang in discoverUsers() or connect()');
    process.exit(1);
  }, 30_000);
  startupTimer.unref();

  // Discover users and set up connectors
  let userConnectors = await discoverUsers();
  if (userConnectors.length === 0) {
    log.info('No users with connected accounts yet — waiting for first connection');
  } else {
    log.info(`Tracking ${userConnectors.length} user(s)`);
  }

  // Connect all
  for (const uc of userConnectors) {
    for (const connector of uc.connectors) {
      await connector.connect();
      log.info(`Connected: ${connector.name} for user ${uc.userId}`);
    }
  }

  clearTimeout(startupTimer);
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
      // Clean up expired escalations — separate try/catch so expiry failures
      // don't block cleanup and vice versa
      for (const uc of userConnectors) {
        try {
          const cleaned = await approvalRepository.deleteStaleEscalations(uc.userId);
          if (cleaned > 0) {
            console.info(`[worker] Cleaned ${cleaned} stale escalation(s) for user ${uc.userId}`);
          }
        } catch (error) {
          console.error(
            `[worker] Error cleaning stale escalations for user ${uc.userId}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }

    // Re-discover users every 10 poll cycles to pick up new connections.
    // When no users are tracked yet, check every cycle so first-time
    // connections are picked up within one poll interval (~10s).
    if (userConnectors.length === 0 || pollCount % 10 === 0) {
      const newUserConnectors = await discoverUsers();
      const oldUserIds = new Set(userConnectors.map((uc) => uc.userId));
      const newUserIds = new Set(newUserConnectors.map((uc) => uc.userId));
      const usersChanged = oldUserIds.size !== newUserIds.size
        || [...oldUserIds].some((id) => !newUserIds.has(id));
      if (usersChanged) {
        log.info(`User set changed: ${[...oldUserIds].join(',')} → ${[...newUserIds].join(',')}`);
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

        // Prune circuit breakers for users no longer tracked
        for (const userId of userCircuitBreakers.keys()) {
          if (!newUserIds.has(userId)) {
            userCircuitBreakers.delete(userId);
          }
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, config.workerPollIntervalMs));
  }

  // Graceful shutdown
  log.info('Shutting down...');
  for (const uc of userConnectors) {
    for (const connector of uc.connectors) {
      await connector.disconnect();
      log.info(`Disconnected: ${connector.name} for user ${uc.userId}`);
    }
  }
  log.info('Worker stopped.');
}

// Graceful shutdown handlers
process.on('SIGINT', () => {
  log.info('Received SIGINT, shutting down gracefully...');
  running = false;
});

process.on('SIGTERM', () => {
  log.info('Received SIGTERM, shutting down gracefully...');
  running = false;
});

// Start the worker
void main().catch((error) => {
  log.error('Fatal error', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
