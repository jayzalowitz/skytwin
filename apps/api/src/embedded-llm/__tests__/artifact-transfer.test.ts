import { describe, expect, it, vi } from 'vitest';
import { MODEL_REGISTRY, type ModelEntry } from '@skytwin/embedded-llm';
import {
  ArtifactTransferError,
  DiskReservationLedger,
  assertAvailableDisk,
  fetchApprovedArtifact,
  requiredAvailableBytes,
  type ArtifactFetchDependencies,
} from '../artifact-transfer.js';

function model(exactBytes = 4): ModelEntry {
  const base = MODEL_REGISTRY[0]!;
  return { ...base, exactBytes, approxBytes: exactBytes, minimumRamBytes: exactBytes };
}
function response(status: number, headers: Record<string, string>, body: string | null = null): Response {
  return new Response(body, { status, headers });
}
function deps(fetchMock: typeof fetch, addresses: readonly string[] = ['8.8.8.8']): ArtifactFetchDependencies {
  return {
    request: vi.fn(async (url, init, approvedAddresses) => ({
      response: await fetchMock(url, init),
      release: vi.fn().mockResolvedValue(undefined),
      approvedAddresses,
    })),
    resolve: vi.fn().mockResolvedValue(addresses),
  };
}

describe('artifact transfer validation', () => {
  it('accounts for all remaining bytes plus activation headroom', () => {
    expect(requiredAvailableBytes(100, 40)).toBe(160 + 64 * 1024 * 1024);
    expect(() => requiredAvailableBytes(100, 101)).toThrow(ArtifactTransferError);
    expect(() => assertAvailableDisk(1_000, 1_000)).toThrow(expect.objectContaining({
      code: 'insufficient_disk',
      details: { requiredBytes: 2_000 + 64 * 1024 * 1024, availableBytes: 1_000 },
    }));
  });

  it('accounts for concurrent process-wide disk reservations', () => {
    const ledger = new DiskReservationLedger();
    ledger.reserve('first', 700);
    ledger.reserve('second', 300);
    expect(ledger.totalBytes).toBe(1_000);
    ledger.release('first');
    expect(ledger.totalBytes).toBe(300);
  });

  it('follows only an approved redirect and validates exact response metadata', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(302, {
        location: 'https://us.aws.cdn.hf.co/object',
        'x-repo-commit': model().source.revision,
        'x-linked-size': '4',
        'x-linked-etag': `"${model().sha256}"`,
      }))
      .mockResolvedValueOnce(response(200, { 'content-length': '4', 'content-type': 'application/octet-stream', etag: '"fixed"' }, 'data')) as unknown as typeof fetch;
    const result = await fetchApprovedArtifact(model(), 0, null, new AbortController().signal, deps(fetchMock));
    expect(result.finalUrl).toBe('https://us.aws.cdn.hf.co/object');
    expect(result.validator.etag).toBe('"fixed"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects canonical and redirect URLs with non-default ports', async () => {
    const base = model();
    const initialWithPort: ModelEntry = {
      ...base,
      source: {
        ...base.source,
        downloadUrl: base.source.downloadUrl.replace('huggingface.co/', 'huggingface.co:8443/'),
      },
    };
    await expect(fetchApprovedArtifact(
      initialWithPort, 0, null, new AbortController().signal,
      deps(vi.fn() as unknown as typeof fetch),
    )).rejects.toMatchObject({ code: 'unapproved_redirect' });

    const fetchMock = vi.fn().mockResolvedValueOnce(response(302, {
      location: 'https://us.aws.cdn.hf.co:8443/blob',
      'x-repo-commit': base.source.revision,
      'x-linked-size': String(base.exactBytes),
      'x-linked-etag': base.sha256,
    }));
    await expect(fetchApprovedArtifact(
      base, 0, null, new AbortController().signal,
      deps(fetchMock as unknown as typeof fetch),
    )).rejects.toMatchObject({ code: 'unapproved_redirect' });
  });

  it('rejects redirects outside the artifact allowlist before fetching them', async () => {
    const artifact = model();
    const fetchMock = vi.fn().mockResolvedValue(response(302, {
      location: 'https://example.com/model',
      'x-repo-commit': artifact.source.revision,
      'x-linked-size': '4',
      'x-linked-etag': `"${artifact.sha256}"`,
    })) as unknown as typeof fetch;
    await expect(fetchApprovedArtifact(model(), 0, null, new AbortController().signal, deps(fetchMock)))
      .rejects.toMatchObject({ code: 'unapproved_redirect' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects canonical metadata that disagrees with the pinned registry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(302, {
      location: 'https://us.aws.cdn.hf.co/object',
      'x-repo-commit': '0'.repeat(40),
      'x-linked-size': '4',
      'x-linked-etag': `"${model().sha256}"`,
    })) as unknown as typeof fetch;
    await expect(fetchApprovedArtifact(model(), 0, null, new AbortController().signal, deps(fetchMock)))
      .rejects.toMatchObject({ code: 'source_metadata_mismatch' });
  });

  it('rejects a source or redirect resolving to a private address', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    await expect(fetchApprovedArtifact(model(), 0, null, new AbortController().signal, deps(fetchMock, ['127.0.0.1'])))
      .rejects.toMatchObject({ code: 'private_source_address' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes only the vetted DNS answers to the connection-bound request', async () => {
    const artifact = model();
    const fetchMock = vi.fn().mockResolvedValue(response(200, {
      'content-length': '4',
      'content-type': 'application/octet-stream',
      etag: '"fixed"',
    }, 'data')) as unknown as typeof fetch;
    const dependencies = deps(fetchMock, ['8.8.8.8', '1.1.1.1']);
    const result = await fetchApprovedArtifact(
      artifact, 0, null, new AbortController().signal, dependencies,
    );
    expect(dependencies.request).toHaveBeenCalledWith(
      new URL(artifact.source.downloadUrl),
      expect.objectContaining({ redirect: 'manual' }),
      ['8.8.8.8', '1.1.1.1'],
    );
    await result.response.body?.cancel();
    await result.release();
  });

  it.each(['::ffff:127.0.0.1', '::ffff:7f00:1'])('rejects IPv4-mapped private IPv6 %s', async (address) => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    await expect(fetchApprovedArtifact(model(), 0, null, new AbortController().signal, deps(fetchMock, [address])))
      .rejects.toMatchObject({ code: 'private_source_address' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['64:ff9b::7f00:1', '198.18.0.1', '192.0.2.1', '2001:2::1'])(
    'rejects non-global or translated address %s',
    async (address) => {
      const request = vi.fn() as unknown as typeof fetch;
      await expect(fetchApprovedArtifact(model(), 0, null, new AbortController().signal, deps(request, [address])))
        .rejects.toMatchObject({ code: 'private_source_address' });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('rejects unexpected length and content type', async () => {
    const wrongLength = vi.fn().mockResolvedValue(response(200, { 'content-length': '5', 'content-type': 'application/octet-stream' }, 'data')) as unknown as typeof fetch;
    await expect(fetchApprovedArtifact(model(), 0, null, new AbortController().signal, deps(wrongLength)))
      .rejects.toMatchObject({ code: 'unexpected_length' });
    const wrongType = vi.fn().mockResolvedValue(response(200, { 'content-length': '4', 'content-type': 'text/html' }, 'data')) as unknown as typeof fetch;
    await expect(fetchApprovedArtifact(model(), 0, null, new AbortController().signal, deps(wrongType)))
      .rejects.toMatchObject({ code: 'unexpected_content_type' });
  });

  it('requires a stable validator so interrupted transfers remain resumable', async () => {
    const unvalidated = vi.fn().mockResolvedValue(response(200, {
      'content-length': '4',
      'content-type': 'application/octet-stream',
    }, 'data')) as unknown as typeof fetch;
    await expect(fetchApprovedArtifact(
      model(), 0, null, new AbortController().signal, deps(unvalidated),
    )).rejects.toMatchObject({ code: 'source_metadata_mismatch' });
  });

  it('uses typed failures for removed sources, network errors and cancellation', async () => {
    const unavailable = vi.fn().mockResolvedValue(response(404, { 'content-length': '0' })) as unknown as typeof fetch;
    await expect(fetchApprovedArtifact(model(), 0, null, new AbortController().signal, deps(unavailable)))
      .rejects.toMatchObject({ code: 'source_unavailable' });

    const network = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(fetchApprovedArtifact(model(), 0, null, new AbortController().signal, deps(network)))
      .rejects.toMatchObject({ code: 'network_error' });

    const controller = new AbortController();
    controller.abort();
    await expect(fetchApprovedArtifact(model(), 0, null, controller.signal, deps(network)))
      .rejects.toMatchObject({ code: 'cancelled' });
  });

  it('resumes only when range and validator agree exactly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(206, {
      'content-length': '2', 'content-type': 'binary/octet-stream',
      'content-range': 'bytes 2-3/4', etag: '"fixed"',
    }, 'ta')) as unknown as typeof fetch;
    await expect(fetchApprovedArtifact(model(), 2, { etag: '"fixed"' }, new AbortController().signal, deps(fetchMock)))
      .resolves.toMatchObject({ validator: { etag: '"fixed"' } });
    const request = vi.mocked(fetchMock).mock.calls[0]![1] as RequestInit;
    expect(request.headers).toMatchObject({ Range: 'bytes=2-', 'If-Range': '"fixed"' });

    await expect(fetchApprovedArtifact(model(), 2, null, new AbortController().signal, deps(fetchMock)))
      .rejects.toMatchObject({ code: 'resume_state_mismatch' });
  });
});
