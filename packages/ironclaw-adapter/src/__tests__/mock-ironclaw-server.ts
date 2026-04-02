import http from 'node:http';
import { createHmac } from 'node:crypto';

/**
 * Minimal Express-like HTTP server mimicking IronClaw's webhook API.
 *
 * Endpoints:
 * - POST /webhook — Accepts IronClaw messages, returns structured responses
 * - GET /health — Returns health status
 *
 * Used by contract tests to validate that the RealIronClawAdapter produces
 * correct requests and handles responses properly.
 */
export interface MockServerConfig {
  webhookSecret: string;
  port?: number;
}

export interface ReceivedMessage {
  channel: string;
  user_id: string;
  owner_id: string;
  content: string;
  thread_id?: string;
  attachments: unknown[];
  metadata: Record<string, unknown>;
}

export class MockIronClawServer {
  private server: http.Server | null = null;
  private healthy = true;
  readonly receivedMessages: ReceivedMessage[] = [];
  private nextResponse: Record<string, unknown> | null = null;
  private readonly webhookSecret: string;
  private assignedPort = 0;

  constructor(config: MockServerConfig) {
    this.webhookSecret = config.webhookSecret;
  }

  get port(): number {
    return this.assignedPort;
  }

  get url(): string {
    return `http://127.0.0.1:${this.assignedPort}`;
  }

  /**
   * Set the next response the server will return for /webhook.
   */
  setNextResponse(response: Record<string, unknown>): void {
    this.nextResponse = response;
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Listen on port 0 to get a random available port
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (typeof addr === 'object' && addr) {
          this.assignedPort = addr.port;
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  reset(): void {
    this.receivedMessages.length = 0;
    this.nextResponse = null;
    this.healthy = true;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'GET' && req.url === '/health') {
      if (this.healthy) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'unhealthy' }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/webhook') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        // Verify HMAC signature
        const signatureHeader = req.headers['x-signature-256'] as string | undefined;
        if (signatureHeader) {
          const expectedSig = createHmac('sha256', this.webhookSecret)
            .update(body)
            .digest('hex');
          const provided = signatureHeader.replace('sha256=', '');
          if (provided !== expectedSig) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid HMAC signature' }));
            return;
          }
        }

        let message: ReceivedMessage;
        try {
          message = JSON.parse(body) as ReceivedMessage;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        this.receivedMessages.push(message);

        // Determine response based on message type
        const messageType = message.metadata?.['message_type'] as string | undefined;

        if (this.nextResponse) {
          const response = this.nextResponse;
          this.nextResponse = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          return;
        }

        // Default response: success for execute, success for rollback
        if (messageType === 'rollback') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              content: 'Rollback completed successfully.',
              thread_id: message.thread_id,
              attachments: [],
              metadata: {
                status: 'completed',
                outputs: { rolledBack: true },
              },
            }),
          );
          return;
        }

        // Default: execution success
        const planId = message.metadata?.['plan_id'] as string | undefined;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            content: `Executed action: ${message.content.slice(0, 100)}`,
            thread_id: message.thread_id ?? `thread_${planId ?? 'unknown'}`,
            attachments: [],
            metadata: {
              status: 'completed',
              outputs: {
                stepsCompleted: 1,
                planId,
              },
            },
          }),
        );
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}
