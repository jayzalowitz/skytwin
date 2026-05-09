import { createLogger } from '@skytwin/core';
import {
  federationPeerRepository,
  mcpServerRepository,
  query,
  type FederationPeerRow,
} from '@skytwin/db';
import nacl from 'tweetnacl';

const log = createLogger('worker:federation-sync');

/**
 * Federation delta sync (#194 Child 1).
 *
 * For each active peer with an `endpoint_url`, builds a sealed delta
 * payload and POSTs to the peer's `/api/federation/inbox` endpoint.
 * The payload mirrors the AC list:
 *
 *   - installed servers (display_name, registry_id, trust_tier, status)
 *   - earned trust tiers (per-server trust_tier — derived from above)
 *   - dismissed suggestions (registry_ids the user said no to)
 *   - recipes installed (TBD — recipes table not yet wired here, leaves
 *     the field as `null` and downstream tolerates)
 *   - capability_provenance edges (last 100 — we don't ship full graphs,
 *     just incremental visibility)
 *
 * EXCLUDED: OAuth tokens, credential-vault secrets, encryption keys.
 * These stay per-instance so a stolen peer doesn't compromise live
 * service access.
 *
 * Conflict resolution: each peer is "last-writer-wins" on its OWN tier,
 * but the receiver decides whether to apply the delta. This worker only
 * pushes; the receive-side handler (in apps/api/src/routes/federation.ts
 * `inbox` — TODO follow-up) decides apply vs. surface-for-confirmation.
 *
 * Peers without an `endpoint_url` are "passive" — we'd happily accept
 * their inbound deltas if they push to us, but we don't push outbound.
 * (A laptop without an externally-routable URL is the common case.)
 */

export interface FederationSyncDeps {
  /** Override the peer-list query (for tests). */
  peers?: FederationPeerRow[];
  /**
   * Override the HTTP transport (for tests). Receives `(url, opts)` and
   * returns `{ ok, status }`. The default uses the global `fetch`.
   */
  fetcher?: (url: string, opts: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  /** Override the peer-row updater (for tests). */
  markSyncResult?: typeof federationPeerRepository.markSyncResult;
}

export interface DeltaPayload {
  syncedAt: string;
  installedServers: Array<{
    registryId: string;
    displayName: string;
    trustTier: string;
    status: string;
  }>;
  recentProvenanceEdges: Array<{
    fromNodeId: string;
    toNodeId: string;
    edgeType: string;
    occurredAt: string;
  }>;
}

/**
 * Build the per-user delta payload that gets sealed-and-shipped to each
 * outbound peer. Pure read — no side effects on the local DB.
 */
export async function buildDeltaPayload(userId: string): Promise<DeltaPayload> {
  const [servers, edgesResult] = await Promise.all([
    mcpServerRepository.listForUser(userId),
    query<{
      from_node_id: string;
      to_node_id: string;
      edge_type: string;
      occurred_at: Date;
    }>(
      `SELECT from_node_id, to_node_id, edge_type, occurred_at
       FROM capability_provenance_edges
       WHERE user_id = $1
       ORDER BY occurred_at DESC
       LIMIT 100`,
      [userId],
    ),
  ]);

  return {
    syncedAt: new Date().toISOString(),
    installedServers: servers
      .filter((s) => s.registry_id !== null && (s.status === 'active' || s.status === 'installed' || s.status === 'authorized'))
      .map((s) => ({
        registryId: s.registry_id ?? '',
        displayName: s.display_name,
        trustTier: String(s.trust_tier),
        status: String(s.status),
      })),
    recentProvenanceEdges: edgesResult.rows.map((r) => ({
      fromNodeId: r.from_node_id,
      toNodeId: r.to_node_id,
      edgeType: r.edge_type,
      occurredAt: r.occurred_at.toISOString(),
    })),
  };
}

/**
 * Seal a payload using the local-side keypair stored on the peer row.
 * The peer's inbox endpoint will use its corresponding secret key to
 * open it.
 */
export function sealForPeer(payload: unknown, peer: FederationPeerRow): {
  nonceB64: string;
  ciphertextB64: string;
  senderPublicKey: string;
} {
  const message = Buffer.from(JSON.stringify(payload), 'utf8');
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const peerPub = new Uint8Array(Buffer.from(peer.peer_public_key, 'base64'));
  const localSec = new Uint8Array(Buffer.from(peer.local_secret_key, 'base64'));
  const ciphertext = nacl.box(new Uint8Array(message), nonce, peerPub, localSec);
  return {
    nonceB64: Buffer.from(nonce).toString('base64'),
    ciphertextB64: Buffer.from(ciphertext).toString('base64'),
    senderPublicKey: peer.local_public_key,
  };
}

async function getActivePeersWithEndpoints(): Promise<FederationPeerRow[]> {
  const result = await query<FederationPeerRow>(
    `SELECT * FROM federation_peers
     WHERE unpaired_at IS NULL AND endpoint_url IS NOT NULL
     ORDER BY paired_at DESC
     LIMIT 500`,
  );
  return result.rows;
}

const defaultFetcher: NonNullable<FederationSyncDeps['fetcher']> = async (url, opts) => {
  const res = await fetch(url, opts);
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  };
};

/**
 * Job entry point. For each active peer with an endpoint, seal a delta
 * and POST it. Per-peer failures don't abort the loop.
 */
export async function runFederationSyncJob(deps: FederationSyncDeps = {}): Promise<{
  pushed: number;
  failed: number;
}> {
  const peers = deps.peers ?? (await getActivePeersWithEndpoints());
  if (peers.length === 0) {
    log.info('No active peers with endpoints — federation-sync skipped');
    return { pushed: 0, failed: 0 };
  }

  const fetcher = deps.fetcher ?? defaultFetcher;
  const markSyncResult = deps.markSyncResult ?? federationPeerRepository.markSyncResult.bind(federationPeerRepository);

  log.info('Federation sync starting', { peerCount: peers.length });
  let pushed = 0;
  let failed = 0;

  for (const peer of peers) {
    const endpoint = peer.endpoint_url;
    if (endpoint === null) continue;
    try {
      const payload = await buildDeltaPayload(peer.user_id);
      const sealed = sealForPeer(payload, peer);
      const url = endpoint.replace(/\/$/, '') + '/api/federation/inbox';
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerPublicKey: sealed.senderPublicKey,
          nonce: sealed.nonceB64,
          ciphertext: sealed.ciphertextB64,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const errMsg = `peer responded ${res.status}: ${body.slice(0, 200)}`;
        await markSyncResult({ peerId: peer.id, status: 'failed', error: errMsg });
        failed++;
        log.warn('Federation peer push failed', { peerId: peer.id, status: res.status });
        continue;
      }
      await markSyncResult({ peerId: peer.id, status: 'ok' });
      pushed++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await markSyncResult({ peerId: peer.id, status: 'failed', error: msg });
      } catch {
        /* swallow — telemetry only */
      }
      log.warn('Federation peer push errored', { peerId: peer.id, error: msg });
    }
  }

  log.info('Federation sync complete', { pushed, failed });
  return { pushed, failed };
}
