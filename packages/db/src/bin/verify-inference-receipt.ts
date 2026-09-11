#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  verifyInferenceReceiptExport,
  type InferenceReceiptExportV1,
  type ReceiptVerificationResult,
} from '@skytwin/shared-types';

async function main(): Promise<ReceiptVerificationResult> {
  const path = process.argv[2];
  if (!path) return { valid: false, trusted: false, code: 'INVALID_RECEIPT' };
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const keyIdIndex = process.argv.indexOf('--recorder-key-id');
    const keyPathIndex = process.argv.indexOf('--recorder-public-key');
    const keyId = keyIdIndex >= 0 ? process.argv[keyIdIndex + 1] : undefined;
    const keyPath = keyPathIndex >= 0 ? process.argv[keyPathIndex + 1] : undefined;
    const trustedRecorderKeys = keyId && keyPath
      ? new Map([[keyId, await readFile(keyPath, 'utf8')]])
      : undefined;
    return verifyInferenceReceiptExport(parsed as InferenceReceiptExportV1, {
      trustedRecorderKeys,
      integrityOnly: process.argv.includes('--integrity-only'),
    });
  } catch {
    return { valid: false, trusted: false, code: 'INVALID_RECEIPT' };
  }
}

const result = await main();
process.stdout.write(`${JSON.stringify(result)}\n`);
// With no caller-supplied roots the CLI deliberately proves integrity only.
// Do not let that outcome masquerade as trusted verification in automation.
if (!result.valid || (!result.trusted && !process.argv.includes('--integrity-only'))) process.exitCode = 1;
