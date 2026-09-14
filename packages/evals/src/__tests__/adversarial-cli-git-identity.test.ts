import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveGitSourceIdentity } from '../adversarial-cli.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository(content: string): { directory: string; commit: string } {
  const directory = mkdtempSync(join(tmpdir(), 'skytwin-git-identity-'));
  directories.push(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'eval-test@skytwin.invalid'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Eval Test'], { cwd: directory });
  writeFileSync(join(directory, 'tracked.txt'), content);
  execFileSync('git', ['add', 'tracked.txt'], { cwd: directory });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: directory });
  return {
    directory,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim(),
  };
}

function withGitOverrides(overrides: Record<string, string>, run: () => void): void {
  const prior = new Map<string, string | undefined>();
  try {
    for (const [name, value] of Object.entries(overrides)) {
      prior.set(name, process.env[name]);
      process.env[name] = value;
    }
    run();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

it('binds generator identity to the requested checkout despite inherited Git view overrides', () => {
  const intended = repository('intended\n');
  const alternate = repository('alternate\n');
  writeFileSync(join(intended.directory, 'untracked.txt'), 'dirty\n');

  withGitOverrides({
    GIT_DIR: join(alternate.directory, '.git'),
    GIT_WORK_TREE: alternate.directory,
  }, () => {
    expect(resolveGitSourceIdentity(intended.directory)).toMatchObject({
      commit: intended.commit,
      cleanTree: false,
    });
  });
});

it('ignores replacement refs when measuring the generator checkout tree', () => {
  const intended = repository('original\n');
  writeFileSync(join(intended.directory, 'tracked.txt'), 'replacement\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: intended.directory });
  execFileSync('git', ['commit', '--quiet', '-m', 'replacement'], { cwd: intended.directory });
  const replacement = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: intended.directory,
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['checkout', '--quiet', '--detach', intended.commit], { cwd: intended.directory });
  execFileSync('git', ['replace', intended.commit, replacement], { cwd: intended.directory });

  expect(execFileSync('git', ['status', '--porcelain'], {
    cwd: intended.directory,
    encoding: 'utf8',
  })).not.toBe('');
  expect(resolveGitSourceIdentity(intended.directory)).toMatchObject({
    commit: intended.commit,
    cleanTree: true,
  });
});
