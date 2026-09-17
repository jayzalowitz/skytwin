const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_LABEL_IDS = 128;
const MAX_LABEL_ID_LENGTH = 256;

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors).sort();
    const expected = [...keys].sort();
    if (names.length !== expected.length ||
        names.some((name, index) => name !== expected[index])) return null;
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function snapshotLabels(value: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0 || value.length > MAX_LABEL_IDS) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors);
    if (names.length !== value.length + 1 || !names.includes('length')) return null;
    const labels: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true || typeof descriptor.value !== 'string' ||
          descriptor.value.length > MAX_LABEL_ID_LENGTH) return null;
      labels.push(descriptor.value);
    }
    return Object.freeze(labels);
  } catch {
    return null;
  }
}

export async function cancelGmailResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort and never changes the secret-free result.
  }
}

async function readBoundedBody(response: Response): Promise<string | null> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
      'application/json') {
    await cancelGmailResponseBody(response);
    return null;
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 ||
        parsedLength > MAX_RESPONSE_BYTES) {
      await cancelGmailResponseBody(response);
      return null;
    }
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Parse one exact, bounded Gmail message-state representation. */
export async function parseExactGmailMessageState(
  response: Response,
  expectedProviderMessageId: string,
): Promise<boolean | null> {
  const body = await readBoundedBody(response);
  if (body === null) return null;
  try {
    const value = JSON.parse(body) as unknown;
    const object = ownData(value, ['id', 'labelIds']);
    if (!object || object['id'] !== expectedProviderMessageId) return null;
    const labels = snapshotLabels(object['labelIds']);
    return labels ? labels.includes('INBOX') : null;
  } catch {
    return null;
  }
}

export const gmailMessageStateResponseLimits = Object.freeze({
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxLabelIds: MAX_LABEL_IDS,
  maxLabelIdLength: MAX_LABEL_ID_LENGTH,
});
