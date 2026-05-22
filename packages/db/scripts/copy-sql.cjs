// Copy *.sql files from src/{migrations,schemas} to dist/{migrations,schemas}.
//
// Why a Node script and not `bash -c 'mkdir -p … && cp …'`: the build runs
// on Windows CI runners too, where `bash` isn't on PATH for cmd.exe — the
// previous bash one-liner failed with "The system cannot find the path
// specified" plus "'true'' is not recognized as an internal or external
// command" because Windows tried to interpret the bash string verbatim.
// Node is the one tool guaranteed available on every platform the desktop
// targets.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** @param {string} from @param {string} to */
function copyDirSqls(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(from)) {
    if (!entry.toLowerCase().endsWith('.sql')) continue;
    fs.copyFileSync(path.join(from, entry), path.join(to, entry));
    copied++;
  }
  return copied;
}

const migrations = copyDirSqls(
  path.join(ROOT, 'src/migrations'),
  path.join(ROOT, 'dist/migrations'),
);
const schemas = copyDirSqls(
  path.join(ROOT, 'src/schemas'),
  path.join(ROOT, 'dist/schemas'),
);

console.log(`[copy-sql] migrations=${migrations} schemas=${schemas}`);
