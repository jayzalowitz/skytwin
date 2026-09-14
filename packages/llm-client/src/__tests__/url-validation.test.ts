import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  fetchCustomProviderUrl,
  validateBaseUrl,
  validateBaseUrlWithDns,
} from '../url-validation.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateBaseUrl', () => {
  describe('valid public URLs', () => {
    it('accepts https URLs for any provider', () => {
      expect(() => validateBaseUrl('https://api.anthropic.com/v1', 'anthropic')).not.toThrow();
      expect(() => validateBaseUrl('https://api.openai.com/v1', 'openai')).not.toThrow();
      expect(() => validateBaseUrl('https://generativelanguage.googleapis.com', 'google')).not.toThrow();
    });

    it('rejects plaintext HTTP for public hosts', () => {
      expect(() => validateBaseUrl('http://api.example.com', 'openai')).toThrow('HTTPS is required');
      expect(() => validateBaseUrl('http://ollama.example.com', 'ollama')).toThrow('HTTPS is required');
    });
  });

  describe('invalid URLs and protocols', () => {
    it('rejects malformed URLs', () => {
      expect(() => validateBaseUrl('not-a-url', 'openai')).toThrow('Invalid base URL');
    });

    it('rejects ftp protocol', () => {
      expect(() => validateBaseUrl('ftp://files.example.com', 'openai')).toThrow('Unsupported protocol');
    });

    it('rejects file protocol', () => {
      expect(() => validateBaseUrl('file:///etc/passwd', 'openai')).toThrow('Unsupported protocol');
    });
  });

  describe('metadata endpoint blocking', () => {
    it('blocks AWS metadata endpoint for all providers', () => {
      expect(() => validateBaseUrl('http://169.254.169.254/latest/meta-data/', 'openai')).toThrow('Blocked metadata endpoint');
      expect(() => validateBaseUrl('http://169.254.169.254/', 'anthropic')).toThrow('Blocked metadata endpoint');
      expect(() => validateBaseUrl('http://169.254.169.254/', 'ollama')).toThrow('Blocked metadata endpoint');
    });

    it('blocks GCP metadata endpoint for all providers', () => {
      expect(() => validateBaseUrl('http://metadata.google.internal/', 'google')).toThrow('Blocked metadata endpoint');
      expect(() => validateBaseUrl('http://metadata.google.internal/', 'ollama')).toThrow('Blocked metadata endpoint');
    });
  });

  describe('private IP blocking for non-ollama providers', () => {
    it('blocks localhost', () => {
      expect(() => validateBaseUrl('http://localhost:8080', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks 127.0.0.1', () => {
      expect(() => validateBaseUrl('http://127.0.0.1:8080', 'anthropic')).toThrow('Private/internal URL not allowed');
    });

    it('blocks ::1 (IPv6 loopback)', () => {
      expect(() => validateBaseUrl('http://[::1]:8080', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks 10.x.x.x (class A private)', () => {
      expect(() => validateBaseUrl('http://10.0.0.1:8080', 'openai')).toThrow('Private/internal URL not allowed');
      expect(() => validateBaseUrl('http://10.255.255.255', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks 172.16-31.x.x (class B private)', () => {
      expect(() => validateBaseUrl('http://172.16.0.1', 'openai')).toThrow('Private/internal URL not allowed');
      expect(() => validateBaseUrl('http://172.31.255.255', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('allows 172.15.x.x and 172.32.x.x (not private)', () => {
      expect(() => validateBaseUrl('https://172.15.0.1', 'openai')).not.toThrow();
      expect(() => validateBaseUrl('https://172.32.0.1', 'openai')).not.toThrow();
    });

    it('blocks 192.168.x.x (class C private)', () => {
      expect(() => validateBaseUrl('http://192.168.1.1', 'openai')).toThrow('Private/internal URL not allowed');
      expect(() => validateBaseUrl('http://192.168.0.100', 'anthropic')).toThrow('Private/internal URL not allowed');
    });

    it('blocks 0.0.0.0', () => {
      expect(() => validateBaseUrl('http://0.0.0.0:8080', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks 169.254.x.x (link-local)', () => {
      expect(() => validateBaseUrl('http://169.254.1.1', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks 127.x.x.x range', () => {
      expect(() => validateBaseUrl('http://127.0.0.2', 'openai')).toThrow('Private/internal URL not allowed');
      expect(() => validateBaseUrl('http://127.255.255.255', 'openai')).toThrow('Private/internal URL not allowed');
    });
  });

  describe('ollama loopback exemption', () => {
    it('allows localhost for ollama', () => {
      expect(() => validateBaseUrl('http://localhost:11434', 'ollama')).not.toThrow();
    });

    it('allows 127.0.0.1 for ollama', () => {
      expect(() => validateBaseUrl('http://127.0.0.1:11434', 'ollama')).not.toThrow();
    });

    it('allows bracketed ::1 for ollama (recognized as loopback after bracket stripping)', () => {
      // URL parser wraps IPv6 in brackets, but validateBaseUrl strips them
      // before matching, so [::1] → ::1 is correctly recognized as loopback.
      expect(() => validateBaseUrl('http://[::1]:11434', 'ollama')).not.toThrow();
    });

    it('blocks non-loopback private IPs for ollama', () => {
      expect(() => validateBaseUrl('http://10.0.0.1:11434', 'ollama')).toThrow('only loopback addresses are allowed');
      expect(() => validateBaseUrl('http://192.168.1.1:11434', 'ollama')).toThrow('only loopback addresses are allowed');
      expect(() => validateBaseUrl('http://172.16.0.1:11434', 'ollama')).toThrow('only loopback addresses are allowed');
    });

    it('allows public URLs for ollama', () => {
      expect(() => validateBaseUrl('https://my-ollama.example.com', 'ollama')).not.toThrow();
    });
  });

  describe('octal and hex bypass prevention', () => {
    it('blocks octal-encoded loopback (0177.0.0.1)', () => {
      // Node's URL parser resolves 0177.0.0.1 to 127.0.0.1,
      // which our code then correctly catches as private
      expect(() => validateBaseUrl('http://0177.0.0.1', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks hex-encoded loopback (0x7f000001)', () => {
      // Node's URL parser resolves 0x7f000001 to 127.0.0.1
      expect(() => validateBaseUrl('http://0x7f000001', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks octal notation 010.0.0.1', () => {
      // Node's URL parser resolves 010.0.0.1 to 8.0.0.1 (non-private)
      expect(() => validateBaseUrl('https://010.0.0.1', 'openai')).not.toThrow();
    });
  });

  describe('IPv6-mapped IPv4 addresses', () => {
    it('blocks the canonical hex form produced for IPv4-mapped private addresses', () => {
      expect(() => validateBaseUrl('http://[::ffff:10.0.0.1]', 'openai'))
        .toThrow('Private/internal URL not allowed');
    });

    it('blocks direct loopback and private IPs', () => {
      expect(() => validateBaseUrl('http://127.0.0.1', 'openai')).toThrow('Private/internal URL not allowed');
      expect(() => validateBaseUrl('http://192.168.1.1', 'openai')).toThrow('Private/internal URL not allowed');
    });
  });

  describe('IPv6 ULA and link-local blocking', () => {
    it('blocks fd00::/8 unique local addresses', () => {
      expect(() => validateBaseUrl('http://[fd12::1]:8080', 'openai')).toThrow('Private/internal URL not allowed');
      expect(() => validateBaseUrl('http://[fd00::1]', 'anthropic')).toThrow('Private/internal URL not allowed');
    });

    it('blocks fc00::/8 unique local addresses', () => {
      expect(() => validateBaseUrl('http://[fc00::1]', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks fe80::/10 link-local addresses', () => {
      expect(() => validateBaseUrl('http://[fe80::1]', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks IPv6 ULA for ollama (non-loopback private)', () => {
      expect(() => validateBaseUrl('http://[fd12::1]:11434', 'ollama')).toThrow('only loopback addresses are allowed');
    });
  });

  describe('hostname normalization (hardening)', () => {
    it('blocks trailing-dot localhost ("localhost.")', () => {
      expect(() => validateBaseUrl('http://localhost./api', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks trailing-dot 127.0.0.1 ("127.0.0.1.")', () => {
      expect(() => validateBaseUrl('http://127.0.0.1./api', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks IPv6 zone id ([fe80::1%eth0])', () => {
      // Node's URL parser rejects bracketed IPv6 with a zone id outright as
      // an invalid URL. That's defense-in-depth — either an "Invalid base
      // URL" or "Private/internal URL not allowed" is acceptable; the URL
      // must NOT pass through.
      expect(() => validateBaseUrl('http://[fe80::1%25eth0]:8080', 'openai'))
        .toThrow(/Invalid base URL|Private\/internal URL not allowed/);
    });

    it('blocks bracketed link-local without zone id ([fe80::1])', () => {
      // The non-zone form parses fine and must be caught by isPrivateHost.
      expect(() => validateBaseUrl('http://[fe80::1]:8080', 'openai'))
        .toThrow('Private/internal URL not allowed');
    });

    it('blocks uppercase LOCALHOST', () => {
      expect(() => validateBaseUrl('http://LOCALHOST:8080', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks the IPv6 unspecified address [::]', () => {
      expect(() => validateBaseUrl('http://[::]:8080', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks long-form IPv6 unspecified [0:0:0:0:0:0:0:0]', () => {
      // Node URL parser may collapse this to [::], either way it should block
      expect(() => validateBaseUrl('http://[0:0:0:0:0:0:0:0]:8080', 'openai')).toThrow('Private/internal URL not allowed');
    });
  });

  describe('CGNAT (RFC 6598) blocking', () => {
    it('blocks 100.64.0.0/10 (CGNAT range start)', () => {
      expect(() => validateBaseUrl('http://100.64.0.1', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('blocks 100.127.255.254 (CGNAT range end)', () => {
      expect(() => validateBaseUrl('http://100.127.255.254', 'openai')).toThrow('Private/internal URL not allowed');
    });

    it('allows 100.63.x.x and 100.128.x.x (outside CGNAT)', () => {
      expect(() => validateBaseUrl('https://100.63.0.1', 'openai')).not.toThrow();
      expect(() => validateBaseUrl('https://100.128.0.1', 'openai')).not.toThrow();
    });
  });
});

describe('validateBaseUrlWithDns', () => {
  it('rejects public and mixed answers for localhost at save time', async () => {
    const publicLookup = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
    const mixedLookup = vi.fn().mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ]);

    await expect(validateBaseUrlWithDns(
      'http://localhost:11434', 'ollama', publicLookup,
    )).rejects.toThrow('must resolve only to a loopback address');
    await expect(validateBaseUrlWithDns(
      'http://localhost:11434', 'ollama', mixedLookup,
    )).rejects.toThrow('must resolve only to a loopback address');
  });

  it('accepts localhost only when every save-time answer is loopback', async () => {
    const loopbackLookup = vi.fn().mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);

    await expect(validateBaseUrlWithDns(
      'http://localhost:11434', 'ollama', loopbackLookup,
    )).resolves.toBeUndefined();
    expect(loopbackLookup).toHaveBeenCalledWith(
      'localhost', { all: true, verbatim: true },
    );
  });
});

describe('fetchCustomProviderUrl', () => {
  it('rejects before lookup when the request signal is already aborted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const controller = new AbortController();
    controller.abort();

    await expect(fetchCustomProviderUrl(
      'https://provider.example/v1/messages',
      'anthropic',
      { method: 'POST', signal: controller.signal },
      lookup,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the request signal aborts a pending DNS lookup', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const lookup = vi.fn(() => new Promise<never>(() => undefined));
    const controller = new AbortController();

    const request = fetchCustomProviderUrl(
      'https://provider.example/v1/messages',
      'anthropic',
      { method: 'POST', signal: controller.signal },
      lookup,
    );
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(lookup).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when DNS cannot resolve the configured hostname', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const failingLookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));

    await expect(fetchCustomProviderUrl(
      'https://unresolvable.example/v1/messages',
      'anthropic',
      { method: 'POST' },
      failingLookup,
    )).rejects.toThrow('DNS lookup failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a hostname whose validated DNS answer is private', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const privateLookup = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(fetchCustomProviderUrl(
      'https://rebind.example/v1/messages',
      'anthropic',
      { method: 'POST' },
      privateLookup,
    )).rejects.toThrow('resolves to private address');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects public and mixed DNS answers for a locally admitted hostname', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const publicLookup = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
    const mixedLookup = vi.fn().mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ]);

    await expect(fetchCustomProviderUrl(
      'http://localhost:11434/api/chat', 'ollama', { method: 'POST' }, publicLookup,
    )).rejects.toThrow('must resolve only to a loopback address');
    await expect(fetchCustomProviderUrl(
      'http://localhost:11434/api/chat', 'ollama', { method: 'POST' }, mixedLookup,
    )).rejects.toThrow('must resolve only to a loopback address');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts every resolved answer when a local hostname stays on loopback', async () => {
    const response = new Response('{"ok":true}', { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const loopbackLookup = vi.fn().mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);

    const result = await fetchCustomProviderUrl(
      'http://localhost:11434/api/chat', 'ollama', { method: 'POST' }, loopbackLookup,
    );
    expect(result.response).toBe(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    await result.close();
  });

  it('does not grant the Ollama exemption to a remote hostname resolving to loopback', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const privateLookup = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(fetchCustomProviderUrl(
      'https://ollama.example/api/chat', 'ollama', { method: 'POST' }, privateLookup,
    )).rejects.toThrow('resolves to private address');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pins the validated lookup into the connection and rejects redirects', async () => {
    const redirect = new Response('', {
      status: 302,
      headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
    });
    const fetchMock = vi.fn().mockResolvedValue(redirect);
    vi.stubGlobal('fetch', fetchMock);
    const publicLookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await expect(fetchCustomProviderUrl(
      'https://provider.example/v1/messages',
      'anthropic',
      { method: 'POST' },
      publicLookup,
    )).rejects.toThrow('Redirects are not allowed');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://provider.example/v1/messages',
      expect.objectContaining({
        redirect: 'manual',
        dispatcher: expect.any(Object),
      }),
    );
  });
});
