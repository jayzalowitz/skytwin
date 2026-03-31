import type { ActionHandler } from '@skytwin/shared-types';

/**
 * Registry that maps action types to their handlers.
 * The real IronClaw adapter uses this to dispatch execution.
 */
export class ActionHandlerRegistry {
  private readonly handlers = new Map<string, ActionHandler>();

  /**
   * Register a handler. It will be used for all action types it can handle.
   */
  register(handler: ActionHandler): void {
    this.handlers.set(handler.actionType, handler);
  }

  /**
   * Find a handler that can execute the given action type.
   */
  getHandler(actionType: string): ActionHandler | null {
    // Check exact match first
    const exact = this.handlers.get(actionType);
    if (exact) return exact;

    // Check canHandle for broader matching
    for (const handler of this.handlers.values()) {
      if (handler.canHandle(actionType)) {
        return handler;
      }
    }

    return null;
  }

  /**
   * Get all registered handlers.
   */
  getAllHandlers(): ActionHandler[] {
    return Array.from(this.handlers.values());
  }

  /**
   * Check if any handler can handle the given action type.
   */
  hasHandler(actionType: string): boolean {
    return this.getHandler(actionType) !== null;
  }
}
