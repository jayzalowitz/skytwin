import { describe, expect, it } from 'vitest';
import {
  hasSameProviderCredentialEndpoint,
  parseReasoningMode,
  providerCredentialEndpointAuthority,
  REASONING_MODES,
} from '../reasoning-mode.js';

describe('reasoning modes', () => {
  it('accepts only canonical persisted values', () => {
    for (const mode of REASONING_MODES) expect(parseReasoningMode(mode)).toBe(mode);
  });

  it('fails closed for unknown, case-shifted, and non-string values', () => {
    for (const value of ['local', 'ON_DEVICE', 'confidential', '', null, 1]) {
      expect(parseReasoningMode(value)).toBeNull();
    }
  });
});

describe('provider credential endpoint authority', () => {
  it('compares the scheme, host, and effective port rather than URL paths', () => {
    expect(hasSameProviderCredentialEndpoint(
      'openai',
      'https://gateway.example/v1',
      'https://gateway.example:443/another/path',
    )).toBe(true);
    expect(hasSameProviderCredentialEndpoint(
      'openai',
      'https://gateway.example/v1',
      'https://other.example/v1',
    )).toBe(false);
    expect(hasSameProviderCredentialEndpoint(
      'openai',
      'https://gateway.example/v1',
      'http://gateway.example/v1',
    )).toBe(false);
  });

  it('treats an omitted Ollama URL as its fixed loopback default', () => {
    expect(providerCredentialEndpointAuthority('ollama', undefined))
      .toBe('http://localhost:11434');
    expect(hasSameProviderCredentialEndpoint(
      'ollama', null, 'http://localhost:11434/api/chat',
    )).toBe(true);
  });

  it('fails closed for malformed or credential-bearing endpoints', () => {
    expect(hasSameProviderCredentialEndpoint('openai', null, 'not a URL')).toBe(false);
    expect(() => providerCredentialEndpointAuthority(
      'openai', 'https://user:secret@gateway.example/v1',
    )).toThrow('without embedded credentials');
  });
});
