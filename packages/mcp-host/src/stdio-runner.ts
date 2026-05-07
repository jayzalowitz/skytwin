import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from './types.js';

export interface StdioTransportResult {
  transport: StdioClientTransport;
}

/**
 * Creates a StdioClientTransport for the given server config.
 *
 * The MCP SDK's StdioClientTransport manages the child process spawn
 * internally — callers must not spawn separately.
 *
 * Resource limits:
 * - `memoryMb`: prepended as `--max-old-space-size` when the command is
 *   `node` or `node.js`. Defaults to 256 MB. Other runtimes: container-level
 *   enforcement — see #180 desktop child process.
 * - `cpuPercent` / `noEgress`: container-level only — see #183 zero-trust.
 *   Documented here so callers know these are not silently dropped; they simply
 *   require an outer container/sandbox to enforce.
 *
 * Crash detection: the transport exposes `transport.onclose` which the
 * McpHost wires to a CircuitBreaker failure recorder.
 */
export function createStdioTransport(config: McpServerConfig): StdioTransportResult {
  if (!config.command) {
    throw new Error(`McpServerConfig for '${config.id}' has transport 'stdio' but no 'command'.`);
  }

  const memoryMb = config.resourceLimits?.memoryMb ?? 256;

  const command = config.command;
  const args =
    command === 'node' || command === 'node.js'
      ? [`--max-old-space-size=${memoryMb}`, ...(config.args ?? [])]
      : [...(config.args ?? [])];

  const transport = new StdioClientTransport({
    command,
    args,
    env: config.env,
  });

  return { transport };
}
