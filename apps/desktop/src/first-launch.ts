import { dialog } from 'electron';
import { execSync, exec } from 'child_process';

interface DependencyCheck {
  name: string;
  command: string;
  installHint: string;
}

const DEPENDENCIES: DependencyCheck[] = [
  {
    name: 'CockroachDB',
    command: 'cockroach version',
    installHint: process.platform === 'darwin'
      ? 'brew install cockroachdb/tap/cockroach'
      : process.platform === 'win32'
        ? 'scoop install cockroach'
        : 'curl https://binaries.cockroachdb.com/cockroach-latest.linux-amd64.tgz | tar xz',
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
 * Checks all required dependencies. Returns list of missing ones.
 */
export function checkDependencies(): { name: string; installHint: string }[] {
  const missing: { name: string; installHint: string }[] = [];
  for (const dep of DEPENDENCIES) {
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
    const migrationCmd = `node ${resourcePath}/packages/db/dist/migrations/run.js`;
    exec(migrationCmd, { timeout: 30000 }, (error) => {
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
    const seedCmd = `node ${resourcePath}/packages/db/dist/seeds/run.js`;
    exec(seedCmd, { timeout: 30000 }, (error) => {
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
