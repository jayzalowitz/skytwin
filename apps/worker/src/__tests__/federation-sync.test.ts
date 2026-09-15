import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';

const { mockMcpServerRepository, mockQuery } = vi.hoisted(() => ({
  mockMcpServerRepository: {
    listForUser: vi.fn(),
    listSkillNamesForServer: vi.fn(),
  },
  mockQuery: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  federationPeerRepository: {
    markSyncResult: vi.fn(),
  },
  mcpServerRepository: mockMcpServerRepository,
  query: mockQuery,
}));

import {
  buildDeltaPayload,
  runFederationSyncJob,
  sealForPeer,
  type DeltaPayload,
} from '../jobs/federation-sync.js';

function makeKp() {
  const kp = nacl.box.keyPair();
  return {
    publicKeyB64: Buffer.from(kp.publicKey).toString('base64'),
    secretKeyB64: Buffer.from(kp.secretKey).toString('base64'),
  };
}

const localKp = makeKp();
const peerKp = makeKp();

const SAMPLE_PEER = {
  id: 'peer-1',
  user_id: 'user-1',
  label: 'Phone',
  peer_public_key: peerKp.publicKeyB64,
  local_secret_key: localKp.secretKeyB64,
  local_public_key: localKp.publicKeyB64,
  endpoint_url: 'https://phone.local:3001',
  paired_at: new Date(),
  last_sync_at: null,
  last_sync_status: 'never' as const,
  last_sync_error: null,
  unpaired_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockMcpServerRepository.listForUser.mockResolvedValue([]);
  mockMcpServerRepository.listSkillNamesForServer.mockResolvedValue([]);
  mockQuery.mockResolvedValue({ rows: [] });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('buildDeltaPayload', () => {
  it('includes only active/installed/authorized servers', async () => {
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { registry_id: '@a/b', display_name: 'A', trust_tier: 'observer', status: 'active' },
      { registry_id: '@c/d', display_name: 'C', trust_tier: 'observer', status: 'dormant' },
      { registry_id: '@e/f', display_name: 'E', trust_tier: 'observer', status: 'installed' },
    ]);
    const payload = await buildDeltaPayload('user-1', 'experimental');
    const ids = payload.installedServers.map((s) => s.registryId);
    expect(ids).toEqual(['@a/b', '@e/f']);
  });

  it('includes recent provenance edges in the payload', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { from_node_id: 'n1', to_node_id: 'n2', edge_type: 'installed', occurred_at: new Date() },
      ],
    });
    const payload = await buildDeltaPayload('user-1', 'experimental');
    expect(payload.recentProvenanceEdges).toHaveLength(1);
    expect(payload.recentProvenanceEdges[0]?.edgeType).toBe('installed');
  });

  it('skips servers with null registry_id', async () => {
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { registry_id: null, display_name: 'X', trust_tier: 'observer', status: 'active' },
    ]);
    const payload = await buildDeltaPayload('user-1', 'experimental');
    expect(payload.installedServers).toHaveLength(0);
  });

  it('omits account-backed rows in disabled mode using only local authoritative metadata', async () => {
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { id: 'drive', registry_id: '@modelcontextprotocol/server-google-drive', oauth_provider: null, display_name: 'Drive', trust_tier: 'observer', status: 'active' },
      { id: 'provider', registry_id: 'custom-provider', oauth_provider: 'google', display_name: 'Provider Alias', trust_tier: 'observer', status: 'active' },
      { id: 'skill', registry_id: 'custom-tools', oauth_provider: null, display_name: 'Custom', trust_tier: 'observer', status: 'active' },
      { id: 'notion', registry_id: 'notion-mcp', oauth_provider: 'notion', display_name: 'Notion', trust_tier: 'observer', status: 'active' },
    ]);
    mockMcpServerRepository.listSkillNamesForServer.mockImplementation(async (serverId: string) =>
      serverId === 'skill' ? ['read_email'] : ['notion.search']);
    const network = vi.spyOn(globalThis, 'fetch');

    const payload = await buildDeltaPayload('user-1', 'disabled');

    expect(payload.installedServers.map((server) => server.registryId)).toEqual(['notion-mcp']);
    expect(network).not.toHaveBeenCalled();
    expect(mockMcpServerRepository.listSkillNamesForServer).not.toHaveBeenCalledWith('drive');
    expect(mockMcpServerRepository.listSkillNamesForServer).not.toHaveBeenCalledWith('provider');
    network.mockRestore();
  });

  it('fails closed when cached-skill classification cannot be read', async () => {
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { id: 'unknown', registry_id: 'custom-tools', oauth_provider: null, display_name: 'Custom', trust_tier: 'observer', status: 'active' },
    ]);
    mockMcpServerRepository.listSkillNamesForServer.mockRejectedValue(new Error('DB unavailable'));

    const payload = await buildDeltaPayload('user-1', 'disabled');

    expect(payload.installedServers).toEqual([]);
  });

  it('preserves the exact experimental opt-in without classification reads', async () => {
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { id: 'gmail', registry_id: 'gmail-mcp', oauth_provider: 'google', display_name: 'Gmail', trust_tier: 'observer', status: 'active' },
    ]);

    const payload = await buildDeltaPayload('user-1', 'experimental');

    expect(payload.installedServers.map((server) => server.registryId)).toEqual(['gmail-mcp']);
    expect(mockMcpServerRepository.listSkillNamesForServer).not.toHaveBeenCalled();
  });
});

describe('sealForPeer', () => {
  it('produces a ciphertext that the peer can open', () => {
    const payload = { ok: true };
    const sealed = sealForPeer(payload, SAMPLE_PEER);

    const opened = nacl.box.open(
      new Uint8Array(Buffer.from(sealed.ciphertextB64, 'base64')),
      new Uint8Array(Buffer.from(sealed.nonceB64, 'base64')),
      new Uint8Array(Buffer.from(localKp.publicKeyB64, 'base64')),
      new Uint8Array(Buffer.from(peerKp.secretKeyB64, 'base64')),
    );
    expect(opened).not.toBeNull();
    expect(JSON.parse(Buffer.from(opened!).toString('utf8'))).toEqual(payload);
  });

  it('exposes the local public key as senderPublicKey', () => {
    const sealed = sealForPeer({}, SAMPLE_PEER);
    expect(sealed.senderPublicKey).toBe(localKp.publicKeyB64);
  });
});

describe('runFederationSyncJob', () => {
  it('skips when there are no peers', async () => {
    const fetcher = vi.fn();
    const result = await runFederationSyncJob({ peers: [], fetcher });
    expect(result).toEqual({ pushed: 0, failed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('POSTs sealed deltas to each peer endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const markSyncResult = vi.fn();
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { registry_id: '@a/b', display_name: 'A', trust_tier: 'observer', status: 'active' },
    ]);
    const result = await runFederationSyncJob({
      peers: [SAMPLE_PEER],
      fetcher,
      markSyncResult,
      googleConnectionMode: 'experimental',
    });
    expect(result.pushed).toBe(1);
    expect(result.failed).toBe(0);
    expect(fetcher).toHaveBeenCalledWith(
      'https://phone.local:3001/api/federation/inbox',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(markSyncResult).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: 'peer-1', status: 'ok' }),
    );
  });

  it('never sends disabled account-backed capability rows to a peer', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    mockMcpServerRepository.listForUser.mockResolvedValue([
      { id: 'gmail', registry_id: 'gmail-mcp', oauth_provider: 'google', display_name: 'Gmail', trust_tier: 'observer', status: 'active' },
      { id: 'notion', registry_id: 'notion-mcp', oauth_provider: 'notion', display_name: 'Notion', trust_tier: 'observer', status: 'active' },
    ]);

    await runFederationSyncJob({
      peers: [SAMPLE_PEER],
      fetcher,
      markSyncResult: vi.fn(),
      googleConnectionMode: 'disabled',
    });

    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    const envelope = JSON.parse(String(request.body)) as {
      nonce: string;
      ciphertext: string;
      peerPublicKey: string;
    };
    const opened = nacl.box.open(
      new Uint8Array(Buffer.from(envelope.ciphertext, 'base64')),
      new Uint8Array(Buffer.from(envelope.nonce, 'base64')),
      new Uint8Array(Buffer.from(envelope.peerPublicKey, 'base64')),
      new Uint8Array(Buffer.from(peerKp.secretKeyB64, 'base64')),
    );
    expect(opened).not.toBeNull();
    const payload = JSON.parse(Buffer.from(opened!).toString('utf8')) as DeltaPayload;
    expect(payload.installedServers.map((server) => server.registryId)).toEqual(['notion-mcp']);
    expect(JSON.stringify(payload)).not.toContain('gmail-mcp');
  });

  it('marks failed when peer returns non-2xx', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });
    const markSyncResult = vi.fn();
    const result = await runFederationSyncJob({
      peers: [SAMPLE_PEER],
      fetcher,
      markSyncResult,
    });
    expect(result.pushed).toBe(0);
    expect(result.failed).toBe(1);
    expect(markSyncResult).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: 'peer-1', status: 'failed' }),
    );
  });

  it('absorbs network errors and continues with the next peer', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    const markSyncResult = vi.fn();

    const peer2 = { ...SAMPLE_PEER, id: 'peer-2', label: 'Laptop' };
    const result = await runFederationSyncJob({
      peers: [SAMPLE_PEER, peer2],
      fetcher,
      markSyncResult,
    });
    expect(result.pushed).toBe(1);
    expect(result.failed).toBe(1);
    const calls = markSyncResult.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.peerId === 'peer-1' && c.status === 'failed')).toBe(true);
    expect(calls.some((c) => c.peerId === 'peer-2' && c.status === 'ok')).toBe(true);
  });

  it('skips peers without an endpoint_url', async () => {
    const passive = { ...SAMPLE_PEER, endpoint_url: null };
    const fetcher = vi.fn();
    const result = await runFederationSyncJob({
      peers: [passive],
      fetcher,
    });
    expect(result.pushed).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('strips trailing slash on endpoint URL', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const peerWithSlash = { ...SAMPLE_PEER, endpoint_url: 'https://phone.local:3001/' };
    await runFederationSyncJob({
      peers: [peerWithSlash],
      fetcher,
      markSyncResult: vi.fn(),
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://phone.local:3001/api/federation/inbox',
      expect.anything(),
    );
  });
});
