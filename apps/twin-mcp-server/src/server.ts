import http from 'node:http';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLogger } from '@skytwin/core';
import { tokenStore } from './auth/token-store.js';
import { scopeAllows, visibleTools } from './auth/scope-filter.js';
import { writeExternalAgentProvenance } from './audit/provenance-writer.js';
import { whoami } from './tools/whoami.js';
import { queryMemory } from './tools/query-memory.js';
import { getPreferences } from './tools/get-preferences.js';
import { proposeAction } from './tools/propose-action.js';
import { subscribeSignals } from './tools/subscribe-signals.js';
import type { ExternalAgentToken } from './auth/token-store.js';

const log = createLogger('twin-mcp-server');

/**
 * Extract and validate the Bearer token from an HTTP Authorization header.
 * Returns the raw token string or null.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

/**
 * Build a per-request McpServer instance with tools filtered to the token's scope.
 *
 * We create a fresh McpServer per request (stateless mode) so scope filtering
 * is applied at tool-registration time — no stale capabilities from prior requests.
 */
function buildMcpServer(tokenCtx: ExternalAgentToken): McpServer {
  const server = new McpServer(
    { name: 'skytwin-twin', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'SkyTwin Twin MCP server. Tools are filtered by your token scope. ' +
        'Call whoami to see your identity. All tool calls are logged for audit.',
    },
  );

  const { userId, scope, agentName } = tokenCtx;

  // ── whoami (no scope requirement — visible to all) ────────────────────
  server.tool(
    'whoami',
    'Return identity and trust tier information for the authenticated user.',
    async () => {
      const result = await whoami(userId);
      await writeExternalAgentProvenance({ userId, agentName, toolName: 'whoami', args: {} });
      return result;
    },
  );

  // ── query_memory (scope: read) ─────────────────────────────────────────
  if (scopeAllows(scope, 'query_memory')) {
    server.tool(
      'query_memory',
      'Semantically search the user\'s memory for relevant information.',
      {
        question: z.string().describe('The question or topic to search for.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results to return (1-50, default 10).'),
      },
      async (args) => {
        const result = await queryMemory(userId, {
          question: args.question,
          limit: args.limit ?? 10,
        });
        await writeExternalAgentProvenance({
          userId,
          agentName,
          toolName: 'query_memory',
          args: args as Record<string, unknown>,
        });
        return result;
      },
    );
  }

  // ── get_preferences (scope: read) ─────────────────────────────────────
  if (scopeAllows(scope, 'get_preferences')) {
    server.tool(
      'get_preferences',
      'Return preference vectors from the user\'s twin model.',
      {
        domain: z.string().optional().describe('Filter preferences by domain (e.g. "email", "calendar"). Optional.'),
      },
      async (args) => {
        const result = await getPreferences(userId, {
          domain: args.domain,
        });
        await writeExternalAgentProvenance({
          userId,
          agentName,
          toolName: 'get_preferences',
          args: args as Record<string, unknown>,
        });
        return result;
      },
    );
  }

  // ── propose_action (scope: propose) ───────────────────────────────────
  if (scopeAllows(scope, 'propose_action')) {
    server.tool(
      'propose_action',
      'Propose an action for the user to review and approve. NEVER auto-executes.',
      {
        action: z
          .object({
            type: z.string().describe('Action type identifier.'),
            parameters: z.record(z.unknown()).describe('Action parameters.'),
            reasoning: z.string().describe('Why this action is being proposed.'),
          })
          .describe('The action to propose.'),
        sourceAgent: z
          .string()
          .optional()
          .describe('Identifier of the agent proposing this action (e.g. "claude-desktop").'),
      },
      async (args) => {
        const result = await proposeAction(userId, {
          action: {
            type: args.action.type,
            parameters: args.action.parameters as Record<string, unknown>,
            reasoning: args.action.reasoning,
          },
          sourceAgent: args.sourceAgent ?? agentName,
        });
        await writeExternalAgentProvenance({
          userId,
          agentName,
          toolName: 'propose_action',
          args: args as Record<string, unknown>,
        });
        return result;
      },
    );
  }

  // ── subscribe_signals (scope: subscribe) ──────────────────────────────
  if (scopeAllows(scope, 'subscribe_signals')) {
    server.tool(
      'subscribe_signals',
      'Poll for recent signals. Returns matching signals; call again with since= for incremental updates.',
      {
        type: z.string().optional().describe('Filter by signal type (e.g. "email", "calendar"). Optional.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max signals to return (1-100, default 20).'),
        since: z.string().optional().describe('Only return signals after this ISO 8601 timestamp. Optional.'),
      },
      async (args) => {
        const result = await subscribeSignals(userId, {
          type: args.type,
          limit: args.limit ?? 20,
          since: args.since,
        });
        await writeExternalAgentProvenance({
          userId,
          agentName,
          toolName: 'subscribe_signals',
          args: args as Record<string, unknown>,
        });
        return result;
      },
    );
  }

  return server;
}

/**
 * Start the Twin MCP HTTP server on the given port.
 *
 * Uses StreamableHTTPServerTransport (stateless mode) so each POST /mcp
 * request is handled independently with a fresh server + scope check.
 *
 * Auth flow:
 *   1. Extract Bearer token from Authorization header.
 *   2. Look up token in the DB — returns userId + scope.
 *   3. Build a per-request McpServer with tools filtered to the scope.
 *   4. Connect to a stateless StreamableHTTPServerTransport and handle.
 */
export async function startMcpServer({ port }: { port: number }): Promise<http.Server> {
  const app = express();
  app.use(express.json());

  // Health check — no auth required
  app.get('/health', (_req: express.Request, res: express.Response) => {
    res.json({ status: 'ok', service: 'twin-mcp-server' });
  });

  // MCP endpoint — stateless, auth per request
  app.post('/mcp', async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const rawToken = extractBearerToken(req.headers['authorization']);
      if (!rawToken) {
        res.status(401).json({ error: 'Missing Authorization: Bearer <token> header' });
        return;
      }

      const tokenCtx = await tokenStore.lookup(rawToken);
      if (!tokenCtx) {
        res.status(401).json({ error: 'Invalid or revoked token' });
        return;
      }

      const mcpServer = buildMcpServer(tokenCtx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });

      await mcpServer.connect(transport);

      transport.onerror = (err) => {
        log.warn('MCP transport error', { error: err.message, userId: tokenCtx.userId });
      };

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  });

  // GET /mcp for SSE-style event streams (MCP GET channel)
  app.get('/mcp', async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const rawToken = extractBearerToken(req.headers['authorization']);
      if (!rawToken) {
        res.status(401).json({ error: 'Missing Authorization: Bearer <token> header' });
        return;
      }

      const tokenCtx = await tokenStore.lookup(rawToken);
      if (!tokenCtx) {
        res.status(401).json({ error: 'Invalid or revoked token' });
        return;
      }

      const mcpServer = buildMcpServer(tokenCtx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /mcp (session teardown — stateless, so this is a no-op but must 200)
  app.delete('/mcp', (_req: express.Request, res: express.Response) => {
    res.status(200).json({ ok: true });
  });

  // Error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      log.error('Unhandled error in twin-mcp-server', {
        error: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    },
  );

  return new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(port, () => {
      log.info(`Twin MCP server listening`, { port });
      resolve(server);
    });
    server.once('error', reject);
  });
}

/**
 * Exported for tests: build a McpServer for a given token context without
 * starting a real HTTP server.
 */
export { buildMcpServer };
export { visibleTools };
