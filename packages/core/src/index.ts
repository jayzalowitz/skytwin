/**
 * @skytwin/core - Shared utilities and helpers for SkyTwin packages.
 */

import { randomUUID } from 'node:crypto';

/**
 * Generate a new UUID.
 */
export function generateId(): string {
  return randomUUID();
}

/**
 * Logger abstraction for SkyTwin services.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Simple console-based logger.
 */
export function createLogger(namespace: string): Logger {
  const format = (level: string, message: string, meta?: Record<string, unknown>): string => {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${namespace}] ${message}${metaStr}`;
  };

  return {
    debug(message: string, meta?: Record<string, unknown>) {
      console.debug(format('debug', message, meta));
    },
    info(message: string, meta?: Record<string, unknown>) {
      console.info(format('info', message, meta));
    },
    warn(message: string, meta?: Record<string, unknown>) {
      console.warn(format('warn', message, meta));
    },
    error(message: string, meta?: Record<string, unknown>) {
      console.error(format('error', message, meta));
    },
  };
}

/**
 * Numeric comparison of risk tiers for ordering.
 */
export const RISK_TIER_ORDER: Record<string, number> = {
  negligible: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

/**
 * Numeric comparison of trust tiers for ordering.
 */
export const TRUST_TIER_ORDER: Record<string, number> = {
  observer: 0,
  suggest: 1,
  low_autonomy: 2,
  moderate_autonomy: 3,
  high_autonomy: 4,
};

/**
 * Numeric comparison of confidence levels for ordering.
 */
export const CONFIDENCE_LEVEL_ORDER: Record<string, number> = {
  speculative: 0,
  low: 1,
  moderate: 2,
  high: 3,
  confirmed: 4,
};

/**
 * Compare two risk tiers. Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareRiskTiers(a: string, b: string): number {
  return (RISK_TIER_ORDER[a] ?? 0) - (RISK_TIER_ORDER[b] ?? 0);
}

/**
 * Check if a risk tier exceeds a threshold.
 */
export function riskExceeds(risk: string, threshold: string): boolean {
  return compareRiskTiers(risk, threshold) > 0;
}

/**
 * Check if trust tier meets or exceeds a required level.
 */
export function trustMeetsOrExceeds(actual: string, required: string): boolean {
  return (TRUST_TIER_ORDER[actual] ?? 0) >= (TRUST_TIER_ORDER[required] ?? 0);
}
