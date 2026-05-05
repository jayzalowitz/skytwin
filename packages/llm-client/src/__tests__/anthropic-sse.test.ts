import { describe, it, expect } from 'vitest';
import { parseAnthropicSseStream } from '../providers/anthropic.js';

// Issue #146 (phase 2a) — Anthropic SSE parser. Pure parsing of the
// byte stream returned by the messages-stream endpoint into text-delta
// strings. Tested in isolation so we don't have to mock fetch + Response
// for every behavior we want to verify.

/**
 * Build a ReadableStream<Uint8Array> from arbitrary string chunks. Lets
 * tests simulate boundary cases (split across chunk boundaries, empty
 * chunks, trailing partial events).
 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]!));
      i += 1;
    },
  });
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('parseAnthropicSseStream', () => {
  it('parses a clean stream of content_block_delta events', async () => {
    const wire = [
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
    ].join('');
    const chunks = await collect(parseAnthropicSseStream(streamOf([wire])));
    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('handles events split across multiple read() chunks', async () => {
    // The boundary `\n\n` lands inside the second read — the parser
    // must buffer the partial first event until the rest arrives.
    const part1 = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"He';
    const part2 = 'llo"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}\n\n';
    const chunks = await collect(parseAnthropicSseStream(streamOf([part1, part2])));
    expect(chunks).toEqual(['Hello', '!']);
  });

  it('ignores benign non-text events (message_start, ping, message_stop)', async () => {
    const wire = [
      'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const chunks = await collect(parseAnthropicSseStream(streamOf([wire])));
    expect(chunks).toEqual(['Hi']);
  });

  it('ignores comment lines (heartbeats start with `:`) — defensive', async () => {
    // Anthropic doesn't emit colon-prefixed heartbeats in its message
    // stream, but the SSE spec allows them; the parser should not crash
    // or yield bogus text when one shows up.
    const wire = [
      ': heartbeat\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
    ].join('');
    const chunks = await collect(parseAnthropicSseStream(streamOf([wire])));
    expect(chunks).toEqual(['x']);
  });

  it('survives a malformed JSON line (logs warning, keeps streaming)', async () => {
    const wire = [
      'event: content_block_delta\ndata: {bad-json\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"good"}}\n\n',
    ].join('');
    const chunks = await collect(parseAnthropicSseStream(streamOf([wire])));
    expect(chunks).toEqual(['good']);
  });

  it('handles an empty stream gracefully', async () => {
    const chunks = await collect(parseAnthropicSseStream(streamOf([])));
    expect(chunks).toEqual([]);
  });

  it('flushes a trailing partial event without a final blank-line boundary', async () => {
    // Defensive: well-behaved Anthropic responses always end with
    // \n\n, but a server that cuts off mid-event shouldn't strand text.
    const wire = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"end"}}';
    const chunks = await collect(parseAnthropicSseStream(streamOf([wire])));
    expect(chunks).toEqual(['end']);
  });
});
