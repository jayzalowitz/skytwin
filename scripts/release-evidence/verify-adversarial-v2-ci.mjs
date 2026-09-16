#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStableRegularFile } from '../release-artifacts/file-integrity.mjs';
import { createTrustedGit } from './trusted-git.mjs';
import { verifyAdversarialV2Migration } from './adversarial-v2-migration.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '../..');
const COMMIT = /^[a-f0-9]{40}$/u;

function exactCommit(value, label) {
  if (typeof value !== 'string' || !COMMIT.test(value) || /^0+$/u.test(value)) {
    throw new Error(`${label} must be a nonzero full lowercase commit SHA`);
  }
  return value;
}

function checkoutCommit(root) {
  const result = createTrustedGit(root).spawn(['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 60_000,
  });
  const commit = result.stdout?.trim();
  if (result.error || result.status !== 0 || !COMMIT.test(commit)) {
    throw new Error('current checkout commit could not be resolved safely');
  }
  return commit;
}

export function readGitHubV2TrustContext({ root = DEFAULT_ROOT, env = process.env } = {}) {
  const eventName = env.GITHUB_EVENT_NAME;
  if (eventName !== 'pull_request' && eventName !== 'push') {
    throw new Error('v2 migration CI verification only supports pull_request and push events');
  }
  if (typeof env.GITHUB_EVENT_PATH !== 'string' || env.GITHUB_EVENT_PATH.length === 0) {
    throw new Error('GITHUB_EVENT_PATH is required for protected v2 migration trust');
  }
  const eventPath = resolve(env.GITHUB_EVENT_PATH);
  let event;
  try {
    const bytes = readStableRegularFile(dirname(eventPath), eventPath, {
      maxBytes: 1024 * 1024,
    }).bytes;
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`GitHub event payload could not be read safely: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const trustedCommit = eventName === 'pull_request'
    ? exactCommit(event?.pull_request?.base?.sha, 'pull request base commit')
    : exactCommit(event?.before, 'push before commit');
  const expectedCommit = eventName === 'pull_request'
    ? exactCommit(event?.pull_request?.head?.sha, 'pull request head commit')
    : exactCommit(event?.after, 'push after commit');
  const actualCommit = checkoutCommit(root);
  if (actualCommit !== expectedCommit) {
    throw new Error(`checkout commit ${actualCommit} does not match protected event head ${expectedCommit}`);
  }
  return { trustedCommit, expectedCommit };
}

export function verifyAdversarialV2Ci({ root = DEFAULT_ROOT, env = process.env } = {}) {
  const context = readGitHubV2TrustContext({ root, env });
  const result = verifyAdversarialV2Migration({
    root,
    trustedCommit: context.trustedCommit,
    allowGenesisIfTrustedAbsent: true,
  });
  return { ...result, ...context };
}

function parseArgs(args) {
  let root = DEFAULT_ROOT;
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (flag !== '--root' || !value) throw new Error('usage: verify-adversarial-v2-ci [--root path]');
    root = resolve(value);
  }
  return { root };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = verifyAdversarialV2Ci(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `v2 adversarial migration CI verification passed: ${result.activeSuccessors} active (${result.status}), ` +
      `trusted ${result.trustedCommit}, head ${result.expectedCommit}\n`,
    );
  } catch (error) {
    process.stderr.write(`v2 adversarial migration CI verification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
