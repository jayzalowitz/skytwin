import type { TokenScope } from './token-store.js';

/**
 * Returns the list of MCP tool names visible to a token with the given scope.
 *
 * Scope ordering (weakest → strongest):
 *   read < propose < subscribe
 *
 * A read token can only use the read-tier tools.
 * A propose token adds propose_action on top of the read set.
 * A subscribe token adds subscribe_signals on top of the read set.
 *
 * propose and subscribe are separate leaf permissions — neither implies the other.
 */
export function visibleTools(scope: TokenScope): string[] {
  switch (scope) {
    case 'read':
      return ['whoami', 'query_memory', 'get_preferences'];
    case 'propose':
      return ['whoami', 'query_memory', 'get_preferences', 'propose_action'];
    case 'subscribe':
      return ['whoami', 'query_memory', 'get_preferences', 'subscribe_signals'];
  }
}

/**
 * Check whether a given scope allows calling a specific tool.
 */
export function scopeAllows(scope: TokenScope, toolName: string): boolean {
  return visibleTools(scope).includes(toolName);
}
