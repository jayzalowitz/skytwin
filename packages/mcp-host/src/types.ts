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
}

export interface McpServerHandle {
  id: string;
  status: 'starting' | 'running' | 'failed' | 'stopped';
  startedAt?: Date;
  lastError?: string;
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
