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
