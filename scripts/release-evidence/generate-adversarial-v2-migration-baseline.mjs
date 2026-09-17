#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAdversarialV2MigrationBaseline,
  canonicalJson,
  V2_BASELINE_PATH,
} from './adversarial-v2-migration.mjs';

export function generateAdversarialV2MigrationBaseline({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  outputPath = V2_BASELINE_PATH,
} = {}) {
  const baseline = buildAdversarialV2MigrationBaseline({ root });
  writeFileSync(resolve(root, outputPath), `${canonicalJson(baseline)}\n`, {
    encoding: 'utf8',
    flag: 'w',
  });
  return baseline;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const root = process.argv[2] ? resolve(process.argv[2]) : undefined;
    const baseline = generateAdversarialV2MigrationBaseline(root ? { root } : {});
    process.stdout.write(
      `v2 adversarial migration baseline: ${Object.keys(baseline.retiredHarnessFingerprints).length} retired, ` +
      `${Object.keys(baseline.successorReservationFingerprints).length} reserved, ` +
      `${Object.keys(baseline.activationFingerprints).length} active\n`,
    );
  } catch (error) {
    process.stderr.write(`v2 adversarial migration baseline failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
