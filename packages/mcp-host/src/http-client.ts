import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './types.js';

export interface HttpMcpClientHandle {
  client: Client;
  stop: () => Promise<void>;
}

/**
 * Creates an MCP Client pre-wired to an HTTP or SSE transport and returns
 * both the client (not yet connected) and a `stop` function.
 *
 * Callers must call `client.connect(transport)` before use. This helper
 * exists for cases where the transport needs to be created outside McpHost,
 * e.g. for testing or extension.
 *
 * - `transport: 'sse'`  — uses SSEClientTransport (EventSource-based, MCP pre-2025-03-26)
 * - `transport: 'http'` — uses StreamableHTTPClientTransport (MCP spec 2025-03-26+)
 */
export function buildHttpTransport(
  config: McpServerConfig,
): SSEClientTransport | StreamableHTTPClientTransport {
  if (!config.url) {
    throw new Error(
      `McpServerConfig for '${config.id}' has transport '${config.transport}' but no 'url'.`,
    );
  }

  const url = new URL(config.url);

  if (config.transport === 'sse') {
    return new SSEClientTransport(url);
  }

  return new StreamableHTTPClientTransport(url);
}

export function createHttpMcpClient(config: McpServerConfig): HttpMcpClientHandle {
  const client = new Client(
    { name: `skytwin-mcp-host/${config.id}`, version: '0.1.0' },
    { capabilities: {} },
  );

  const stop = async (): Promise<void> => {
    await client.close();
  };

  return { client, stop };
}
