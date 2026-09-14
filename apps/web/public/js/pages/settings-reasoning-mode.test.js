import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./settings.js', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-client.js', import.meta.url), 'utf8');

describe('reasoning-location settings boundary', () => {
  it('renders local, explicit-provider, unavailable-private, confirmation, and error states', () => {
    expect(source).toContain('Where reasoning runs');
    expect(source).toContain('On this device');
    expect(source).toContain('My configured provider');
    expect(source).toContain('Verified private cloud — unavailable');
    expect(source).toContain('Your earlier provider chain was ambiguous');
    expect(source).toContain('Could not load the reasoning-location boundary');
  });

  it('sends the explicit mode with provider saves and connection tests', () => {
    expect(apiSource).toMatch(/JSON\.stringify\(\{ providers, reasoningMode \}\)/);
    expect(source).toMatch(/reasoningMode: _reasoningMode/);
    expect(source).toMatch(/\}\)\), _reasoningMode\)/);
  });

  it('uses delegated actions rather than inline event handlers', () => {
    const start = source.indexOf('function renderReasoningLocation');
    const end = source.indexOf('function renderModeToggle');
    const locationRenderer = source.slice(start, end);
    expect(locationRenderer).toContain('data-action="ai-reasoning-mode"');
    expect(locationRenderer).not.toMatch(/on(?:click|change|input|keydown)\s*=/i);
  });
});
