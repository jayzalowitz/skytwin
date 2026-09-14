import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const NEUTRAL_CONFIG = [
  '-c', `core.hooksPath=${NULL_DEVICE}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', `core.excludesFile=${NULL_DEVICE}`,
];

function trustedGitEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

function discoverGitDirectory(repoRoot, environment) {
  const result = spawnSync('git', [
    '-C', repoRoot,
    '--no-pager',
    ...NEUTRAL_CONFIG,
    'rev-parse', '--absolute-git-dir',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 64 * 1024,
  });
  const output = result.stdout?.trim();
  if (result.error || result.status !== 0 || !output || output.includes('\n')) {
    throw new Error('could not resolve the intended repository Git directory');
  }
  return realpathSync(output);
}

/**
 * Bind every Git operation to the supplied filesystem checkout. Inherited
 * GIT_* overrides, replacement objects, user/system config, hooks, fsmonitor,
 * and global ignore rules cannot redirect or execute during evidence reads.
 */
export function createTrustedGit(repoRoot) {
  const absoluteRoot = realpathSync(resolve(repoRoot));
  const environment = trustedGitEnvironment();
  const gitDirectory = discoverGitDirectory(absoluteRoot, environment);
  const prefix = [
    '--no-pager',
    '--literal-pathspecs',
    `--git-dir=${gitDirectory}`,
    `--work-tree=${absoluteRoot}`,
    ...NEUTRAL_CONFIG,
  ];
  return {
    repoRoot: absoluteRoot,
    gitDirectory,
    spawn(args, options = {}) {
      return spawnSync('git', [...prefix, ...args], {
        cwd: absoluteRoot,
        env: environment,
        encoding: options.encoding,
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
        windowsHide: true,
      });
    },
  };
}
