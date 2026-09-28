// tsc does not copy non-TS assets. Copy the Lua scripts and SQL migrations next to the compiled JS.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const rel of ['platform/lua', 'db/migrations']) {
  const from = resolve(root, 'src', rel);
  const to = resolve(root, 'dist', rel);
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}
console.log('assets copied');
