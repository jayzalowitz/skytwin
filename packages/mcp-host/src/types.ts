export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  id: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  resourceLimits?: {
    memoryMb?: number;
    cpuPercent?: number;
    noEgress?: boolean;
  };
  /**
   * When true, stdio transport servers are spawned inside a Docker container
   * with --network=none for zero network access. Has no effect for http/sse
   * transports (those are remote servers; network isolation would sever the
   * connection entirely). Requires Docker to be running on the host.
   *
   * If Docker is unavailable and zeroTrustMode is true, the server will still
   * start but McpServerHandle.failedToIsolate will be set to true.
   */
  zeroTrustMode?: boolean;
}

export interface McpServerHandle {
  id: string;
  status: 'starting' | 'running' | 'failed' | 'stopped';
  startedAt?: Date;
  lastError?: string;
  /**
   * Set to true when zeroTrustMode was requested but Docker was not available
   * at install time. The server is running without isolation. The UI should
   * surface "isolation requested but Docker not available" when this is true.
   */
  failedToIsolate?: boolean;
}

export interface McpSkill {
  name: string;
  description?: string;
  inputSchema?: unknown;
  isDestructive?: boolean;
  isIrreversible?: boolean;
}

export interface McpExecutionLog {
  planId: string;
  serverId: string;
  toolName: string;
  startedAt: Date;
  completedAt?: Date;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  output?: Record<string, unknown>;
}
