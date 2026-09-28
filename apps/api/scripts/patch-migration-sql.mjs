// drizzle-kit cannot emit `ON UPDATE CURRENT_TIMESTAMP(3)` for DATETIME columns, but the spec's DDL
// (Section 8) requires it on every `updated_at`. Run after `drizzle-kit generate`; idempotent.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const from = /(`updated_at` datetime\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\))(?! ON UPDATE)/g;
const to = '$1 ON UPDATE CURRENT_TIMESTAMP(3)';

let patched = 0;
for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
  const path = resolve(dir, file);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(from, to);
  if (after !== before) {
    writeFileSync(path, after);
    patched += 1;
    console.log(`patched ${file}`);
  }
}
console.log(`${patched} file(s) patched`);
