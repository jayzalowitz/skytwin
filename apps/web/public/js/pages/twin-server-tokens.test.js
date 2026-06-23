// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./twin-server-tokens.js', import.meta.url), 'utf8');

describe('twin server tokens page event handling', () => {
  it('does not render inline event-handler attributes', () => {
    expect(source).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('handles token generation through the delegated submit listener', () => {
    expect(source).toContain("document.addEventListener('submit'");
    expect(source).toContain('<form id="generate-token-form">');
    expect(source).toContain('type="submit"');
  });

  it('keeps native select labels short enough for mobile widths', () => {
    expect(source).toContain('<option value="read">Read</option>');
    expect(source).toContain('<option value="propose">Propose</option>');
    expect(source).toContain('<option value="subscribe">Subscribe</option>');
    expect(source).not.toContain('Read — query memory + preferences');
  });
});
