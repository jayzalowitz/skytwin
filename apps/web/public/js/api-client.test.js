// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./api-client.js', import.meta.url), 'utf8');

describe('api client', () => {
  it('treats 204 No Content as a successful empty response', () => {
    expect(source).toContain('if (res.status === 204) return null;');
  });

  it('generates a UUID request key for sync and streaming assistant messages', () => {
    expect(source).toContain(
      'sendAssistantMessage(userId, content, threadId = null, requestId = createClientRequestId())',
    );
    expect(source).toContain('requestId = createClientRequestId()');
    expect(source.match(/body: JSON\.stringify\(\{ userId, content, threadId, requestId \}\)/g))
      .toHaveLength(2);
  });
});
