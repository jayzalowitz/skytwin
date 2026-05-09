/**
 * sign-and-notarize.ts — Electron-builder invocation wrapper with signing validation.
 *
 * When SKYTWIN_SIGN_RELEASE=true all required signing credentials are validated
 * before calling electron-builder. If any are missing the process exits with a
 * clear error listing the absent variable(s).
 *
 * When SKYTWIN_SIGN_RELEASE is unset or any other value the build proceeds in
 * unsigned mode (current CI default). The installer is functional but will
 * trigger OS warnings about unverified publishers on macOS/Windows.
 *
 * Usage:
 *   npx ts-node scripts/sign-and-notarize.ts [-- <extra electron-builder args>]
 *   SKYTWIN_SIGN_RELEASE=true npx ts-node scripts/sign-and-notarize.ts
 *
 * Extra arguments after '--' are forwarded verbatim to electron-builder, e.g.:
 *   npx ts-node scripts/sign-and-notarize.ts -- --mac --win
 *
 * TODO(#188 follow-up — ops): Real certificates come from the ops environment.
 *   - macOS: Obtain a Developer ID Application certificate; set MAC_SIGNING_IDENTITY.
 *   - macOS notarization: Enroll with Apple; set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
 *     APPLE_TEAM_ID.
 *   - Windows: Obtain a code-signing certificate (.pfx); set WIN_CERT_FILE + WIN_CERT_PASSWORD.
 *   - Linux: Obtain a GPG key; set GPG_KEY_ID.
 *   Never commit certificates or private keys — pass them through CI secret storage only.
 */

import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnvRequirement {
  name: string;
  description: string;
}

interface Platform {
  name: string;
  requirements: EnvRequirement[];
}

// ---------------------------------------------------------------------------
// Required signing credentials, grouped by platform
// ---------------------------------------------------------------------------

const SIGNING_PLATFORMS: Platform[] = [
  {
    name: 'macOS',
    requirements: [
      { name: 'MAC_SIGNING_IDENTITY', description: 'Developer ID Application certificate identity string (e.g. "Developer ID Application: Acme Corp (TEAM123)")' },
      { name: 'APPLE_ID', description: 'Apple ID email used for notarization' },
      { name: 'APPLE_APP_SPECIFIC_PASSWORD', description: 'App-specific password for the Apple ID' },
      { name: 'APPLE_TEAM_ID', description: 'Apple Developer Team ID (10-character string)' },
    ],
  },
  {
    name: 'Windows',
    requirements: [
      { name: 'WIN_CERT_FILE', description: 'Path to the .pfx code-signing certificate file' },
      { name: 'WIN_CERT_PASSWORD', description: 'Password for the .pfx certificate file' },
    ],
  },
  {
    name: 'Linux',
    requirements: [
      { name: 'GPG_KEY_ID', description: 'GPG key ID used to sign .deb/.rpm packages' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSigningEnv(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const platform of SIGNING_PLATFORMS) {
    for (const req of platform.requirements) {
      const value = process.env[req.name];
      if (!value || value.trim().length === 0) {
        missing.push(req.name);
      }
    }
  }

  return { valid: missing.length === 0, missing };
}

function printMissingVars(missing: string[]): void {
  console.error('');
  console.error('[sign-and-notarize] ERROR: SKYTWIN_SIGN_RELEASE=true but the following');
  console.error('  required signing environment variables are absent or empty:');
  console.error('');

  for (const name of missing) {
    const platformMatch = SIGNING_PLATFORMS.flatMap((p) =>
      p.requirements.filter((r) => r.name === name).map((r) => ({ platform: p.name, ...r }))
    )[0];

    if (platformMatch) {
      console.error(`  ${name}`);
      console.error(`    Platform:    ${platformMatch.platform}`);
      console.error(`    Description: ${platformMatch.description}`);
    } else {
      console.error(`  ${name}`);
    }
    console.error('');
  }

  console.error('  Obtain real credentials from the ops environment (never commit them).');
  console.error('  See apps/desktop/scripts/sign-and-notarize.ts for platform-specific details.');
  console.error('');
}

// ---------------------------------------------------------------------------
// electron-builder invocation
// ---------------------------------------------------------------------------

function runElectronBuilder(extraArgs: string[]): Promise<number> {
  // electron-builder is a dev dependency; prefer the local bin
  const ebPath = require.resolve('electron-builder/out/cli/cli.js');
  const args = [ebPath, 'build', ...extraArgs];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: process.env,
      cwd: process.cwd(),
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const signRelease = process.env['SKYTWIN_SIGN_RELEASE'] === 'true';

  // Collect extra arguments after the '--' separator
  const separatorIdx = process.argv.indexOf('--');
  const extraArgs = separatorIdx >= 0 ? process.argv.slice(separatorIdx + 1) : [];

  if (signRelease) {
    console.log('[sign-and-notarize] SKYTWIN_SIGN_RELEASE=true — validating signing credentials...');

    const { valid, missing } = validateSigningEnv();
    if (!valid) {
      printMissingVars(missing);
      process.exit(1);
    }

    console.log('[sign-and-notarize] All required signing credentials present.');
    console.log('[sign-and-notarize] Invoking electron-builder with signing enabled...');
  } else {
    console.warn('');
    console.warn('[sign-and-notarize] WARNING: Building UNSIGNED installer.');
    console.warn('  SKYTWIN_SIGN_RELEASE is not set to "true".');
    console.warn('  The resulting installer will trigger OS warnings about unverified publishers.');
    console.warn('  Set SKYTWIN_SIGN_RELEASE=true and provide the required signing env vars');
    console.warn('  (see apps/desktop/scripts/sign-and-notarize.ts) to produce a signed build.');
    console.warn('');
  }

  const exitCode = await runElectronBuilder(extraArgs);

  if (exitCode !== 0) {
    console.error(`[sign-and-notarize] electron-builder exited with code ${exitCode}`);
    process.exit(exitCode);
  }

  console.log('[sign-and-notarize] Build complete.');
}

main().catch((err: unknown) => {
  console.error('[sign-and-notarize] Unexpected error:', err);
  process.exit(1);
});
