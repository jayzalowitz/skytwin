const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const from = path.join(ROOT, 'prompts');
const to = path.join(ROOT, 'dist/prompts');

if (!fs.existsSync(from)) {
  console.log('[copy-prompts] prompts=0');
  process.exit(0);
}

fs.rmSync(to, { force: true, recursive: true });
fs.mkdirSync(path.dirname(to), { recursive: true });
fs.cpSync(from, to, { recursive: true });

console.log(`[copy-prompts] copied ${path.relative(ROOT, from)} -> ${path.relative(ROOT, to)}`);
