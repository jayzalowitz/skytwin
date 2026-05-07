import type { Response } from 'express';

/**
 * Manages Server-Sent Events connections per user.
 * Supports fan-out (multiple tabs) and heartbeat keepalive.
 */
class SseConnectionManager {
  private connections = new Map<string, Response[]>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Send heartbeat every 30s to keep connections alive
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 30000);
  }

  addConnection(userId: string, res: Response): void {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

    const userConns = this.connections.get(userId) ?? [];
    userConns.push(res);
    this.connections.set(userId, userConns);
  }

  removeConnection(userId: string, res: Response): void {
    const userConns = this.connections.get(userId);
    if (!userConns) return;

    const filtered = userConns.filter((r) => r !== res);
    if (filtered.length === 0) {
      this.connections.delete(userId);
    } else {
      this.connections.set(userId, filtered);
    }
  }

  /**
   * Emit an event to all connections for a specific user.
   */
  emit(userId: string, event: string, data: unknown): void {
    const userConns = this.connections.get(userId);
    if (!userConns || userConns.length === 0) return;

    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const dead: Response[] = [];

    for (const res of userConns) {
      try {
        res.write(message);
      } catch {
        dead.push(res);
      }
    }

    // Clean up dead connections
    if (dead.length > 0) {
      const alive = userConns.filter((r) => !dead.includes(r));
      if (alive.length === 0) {
        this.connections.delete(userId);
      } else {
        this.connections.set(userId, alive);
      }
    }
  }

  /**
   * Broadcast an event to all connected users.
   */
  emitAll(event: string, data: unknown): void {
    for (const userId of this.connections.keys()) {
      this.emit(userId, event, data);
    }
  }

  private heartbeat(): void {
    const message = `:heartbeat\n\n`;
    for (const [userId, conns] of this.connections.entries()) {
      const dead: Response[] = [];
      for (const res of conns) {
        try {
          res.write(message);
        } catch {
          dead.push(res);
        }
      }
      if (dead.length > 0) {
        const alive = conns.filter((r) => !dead.includes(r));
        if (alive.length === 0) {
          this.connections.delete(userId);
        } else {
          this.connections.set(userId, alive);
        }
      }
    }
  }

  getConnectionCount(userId?: string): number {
    if (userId) {
      return this.connections.get(userId)?.length ?? 0;
    }
    let total = 0;
    for (const conns of this.connections.values()) {
      total += conns.length;
    }
    return total;
  }

  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.connections.clear();
  }
}

/** Singleton SSE connection manager */
export const sseManager = new SseConnectionManager();

// ─────────────────────────────────────────────────────────────────────────────
// Capability-lifecycle event type declarations (issue #176).
//
// These event type strings are declared here so the frontend SSE listener
// can subscribe to them consistently. Emitters are wired downstream once
// the install pipeline and health-check polling are plumbed in.
//
// Event types:
//   capability:suggested — a new AppSuggestion has been created for the user
//   capability:installed — an mcp_server has transitioned to status='active'
//   capability:health    — an mcp_server's health_status has changed
//
// Usage (when wiring emitters, call sseManager.emit(userId, EVENT_TYPE, data)):
//   sseManager.emit(userId, SSE_CAPABILITY_SUGGESTED, { suggestionId, registryId, displayName });
//   sseManager.emit(userId, SSE_CAPABILITY_INSTALLED, { serverId, registryId, displayName });
//   sseManager.emit(userId, SSE_CAPABILITY_HEALTH,    { serverId, healthStatus });
// ─────────────────────────────────────────────────────────────────────────────
export const SSE_CAPABILITY_SUGGESTED  = 'capability:suggested'         as const;
export const SSE_CAPABILITY_INSTALLED  = 'capability:installed'         as const;
export const SSE_CAPABILITY_HEALTH     = 'capability:health'            as const;
// issue #177 — tier promotion ceremony hook point.
// Emitted when PROMOTION_THRESHOLDS is met for an active server that has not
// yet been promoted. The web client subscribes to this and renders the
// TierPromotionModal component.
// Usage: sseManager.emit(userId, SSE_CAPABILITY_PROMOTION_OFFERED, {
//   serverId, serverName, currentTier, proposedTier,
//   decisionsObservedCount, approvedCount,
// });
// The actual emission is wired in the hourly promotion-eligibility-check
// worker job (apps/worker/src/jobs/promotion-eligibility-check.ts).
export const SSE_CAPABILITY_PROMOTION_OFFERED = 'capability:promotion-offered' as const;
