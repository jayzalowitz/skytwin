import { describe, it, expect } from 'vitest';
import { ActionHandlerRegistry } from '../handler-registry.js';
import { GenericActionHandler } from '../handlers/generic-action-handler.js';
import { EmailActionHandler } from '../handlers/email-action-handler.js';

describe('ActionHandlerRegistry', () => {
  it('registers and retrieves handlers', () => {
    const registry = new ActionHandlerRegistry();
    const email = new EmailActionHandler();
    registry.register(email);

    expect(registry.hasHandler('archive_email')).toBe(true);
    expect(registry.getHandler('archive_email')).toBe(email);
  });

  it('returns null for unregistered action types without generic handler', () => {
    const registry = new ActionHandlerRegistry();
    expect(registry.getHandler('unknown_action')).toBeNull();
    expect(registry.hasHandler('unknown_action')).toBe(false);
  });

  it('falls back to generic handler for unmatched types', () => {
    const registry = new ActionHandlerRegistry();
    const generic = new GenericActionHandler();
    registry.register(generic);

    // Generic handler canHandle returns true for everything
    expect(registry.hasHandler('any_action')).toBe(true);
    expect(registry.getHandler('any_action')).toBe(generic);
  });

  it('lists all registered handlers', () => {
    const registry = new ActionHandlerRegistry();
    registry.register(new EmailActionHandler());
    registry.register(new GenericActionHandler());

    expect(registry.getAllHandlers()).toHaveLength(2);
  });
});
