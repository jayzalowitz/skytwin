import { app, dialog } from 'electron';
import { execSync, execFile } from 'child_process';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';

interface DependencyCheck {
  name: string;
  command: string;
  installHint: string;
}

function hasCommand(cmd: string): boolean {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
      stdio: 'ignore',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function getLinuxDistro(): string {
  try {
    const osRelease = readFileSync('/etc/os-release', 'utf-8');
    const idMatch = osRelease.match(/^ID=(.*)$/m);
    if (idMatch) {
      const id = idMatch[1].replace(/"/g, '').trim().toLowerCase();
      if (['ubuntu', 'debian', 'pop', 'mint', 'elementary'].includes(id)) return 'debian';
      if (['fedora', 'rhel', 'centos', 'rocky', 'alma'].includes(id)) return 'redhat';
      if (['arch', 'manjaro', 'endeavouros'].includes(id)) return 'arch';
      if (['opensuse', 'sles'].some((d) => id.includes(d))) return 'suse';
    }
  } catch {
    // /etc/os-release not available
  }
  return 'unknown';
}

function getPlatformInstallHint(dep: string): string {
  if (dep === 'CockroachDB') {
    if (process.platform === 'darwin') {
      return 'brew install cockroachdb/tap/cockroach';
    }

    if (process.platform === 'win32') {
      if (hasCommand('choco')) {
        return 'choco install cockroachdb -y';
      }
      if (hasCommand('scoop')) {
        return 'scoop install cockroach';
      }
      return 'Download from https://www.cockroachlabs.com/docs/releases/ — or install Chocolatey (choco) / Scoop first';
    }

    // Linux
    const distro = getLinuxDistro();
    switch (distro) {
      case 'debian':
        return 'sudo apt-get install -y cockroachdb  (or: sudo snap install cockroachdb)';
      case 'redhat':
        return 'sudo dnf install -y cockroachdb  (or: sudo snap install cockroachdb)';
      case 'arch':
        return 'yay -S cockroachdb-bin  (AUR)';
      default:
        if (hasCommand('snap')) {
          return 'sudo snap install cockroachdb';
        }
        return 'curl https://binaries.cockroachdb.com/cockroach-latest.linux-amd64.tgz | tar xz && sudo mv cockroach-*/cockroach /usr/local/bin/';
    }
  }

  return 'See project README for install instructions';
}

const DEPENDENCIES: DependencyCheck[] = [
  {
    name: 'CockroachDB',
    command: process.platform === 'win32' ? 'cockroach.exe version' : 'cockroach version',
    installHint: getPlatformInstallHint('CockroachDB'),
  },
];

function checkCommand(command: string): boolean {
  try {
    execSync(command, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Locations where a bundled or user-installed CockroachDB binary may live.
 * If any of these exists, the dependency is considered satisfied and the
 * first-launch dialog skips it — CockroachManager will spawn it directly.
 */
function bundledCockroachLocations(): string[] {
  const platformArch = `${process.platform}-${process.arch}`;
  const binName = process.platform === 'win32' ? 'cockroach.exe' : 'cockroach';
  const candidates: string[] = [];

  // Packaged Electron bundle: under <resourcesPath>/cockroach/<platform-arch>/.
  if (app.isPackaged) {
    candidates.push(join(process.resourcesPath, 'cockroach', platformArch, binName));
  }

  // Dev fallback: installed by `bin/skytwin-db install`.
  candidates.push(join(homedir(), '.local', 'share', 'skytwin', 'bin', binName));

  return candidates;
}

function hasBundledCockroach(): boolean {
  return bundledCockroachLocations().some((p) => existsSync(p));
}

/**
 * Checks all required dependencies. Returns list of missing ones.
 *
 * CockroachDB is considered satisfied if EITHER the binary is on PATH
 * (legacy path, brew install / apt install) OR the desktop bundle ships
 * its own at <resourcesPath>/cockroach/<platform-arch>/. Until v0.6.55 we
 * only checked PATH, which forced every desktop user to install CRDB
 * themselves — exactly the friction we set out to remove.
 */
export function checkDependencies(): { name: string; installHint: string }[] {
  const missing: { name: string; installHint: string }[] = [];
  for (const dep of DEPENDENCIES) {
    if (dep.name === 'CockroachDB' && hasBundledCockroach()) {
      continue;
    }
    if (!checkCommand(dep.command)) {
      missing.push({ name: dep.name, installHint: dep.installHint });
    }
  }
  return missing;
}

/**
 * Shows a dialog for missing dependencies with install instructions.
 * Returns true if user clicked "Check Again" and deps are now available.
 */
export async function showDependencyDialog(
  missing: { name: string; installHint: string }[],
): Promise<boolean> {
  const names = missing.map((d) => d.name).join(', ');
  const instructions = missing
    .map((d) => `  ${d.name}: ${d.installHint}`)
    .join('\n');

  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Missing Dependencies',
    message: `SkyTwin requires ${names} to run.`,
    detail: `Install with:\n${instructions}\n\nThen click "Check Again".`,
    buttons: ['Check Again', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 1) return false;

  // Recheck
  const stillMissing = checkDependencies();
  if (stillMissing.length === 0) return true;

  // Recurse if still missing
  return showDependencyDialog(stillMissing);
}

/**
 * Run database migrations using the monorepo db:migrate script.
 * Returns true on success.
 */
export async function runMigrations(resourcePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const script = join(resourcePath, 'packages', 'db', 'dist', 'migrations', 'run.js');
    execFile('node', [script], { timeout: 30000 }, (error) => {
      if (error) {
        console.error('[first-launch] Migration failed:', error.message);
        resolve(false);
      } else {
        console.log('[first-launch] Migrations complete');
        resolve(true);
      }
    });
  });
}

/**
 * Seed development data.
 */
export async function runSeed(resourcePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const script = join(resourcePath, 'packages', 'db', 'dist', 'seeds', 'run.js');
    execFile('node', [script], { timeout: 30000 }, (error) => {
      if (error) {
        console.warn('[first-launch] Seeding failed (may be fine):', error.message);
        resolve(false);
      } else {
        console.log('[first-launch] Seed data loaded');
        resolve(true);
      }
    });
  });
}
