import { resolve } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { boundaryConfigs } from '../../eslint.config.js';

/**
 * Spec test 25: "ESLint boundary rule - importing another module's internals fails lint."
 * Lints probe snippets against exactly the boundary rules the repo enforces.
 */
const root = resolve(import.meta.dirname, '../..');
const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: boundaryConfigs as unknown as Linter.Config[]
});

async function restrictedImportErrors(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

describe('module boundary lint rule (spec test 25)', () => {
  it("rejects importing another module's internals", async () => {
    const errors = await restrictedImportErrors(
      'apps/api/src/modules/auth/probe.ts',
      "import { flightsService } from '../flights/flights.service.js';\nexport const x = flightsService;\n"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Module 'auth'");
    expect(errors[0]).toContain('public API');
  });

  it('rejects deep imports written through the modules directory too', async () => {
    const errors = await restrictedImportErrors(
      'apps/api/src/modules/booking/probe.ts',
      "import { sessionService } from '../../modules/auth/session.service.js';\nexport const x = sessionService;\n"
    );
    expect(errors).toHaveLength(1);
  });

  it('rejects flights importing booking internals', async () => {
    const errors = await restrictedImportErrors(
      'apps/api/src/modules/flights/probe.ts',
      "import { insert } from '../booking/inventory.service.js';\nexport const x = insert;\n"
    );
    expect(errors).toHaveLength(1);
  });

  it("allows importing another module through its public index", async () => {
    for (const [file, other] of [
      ['apps/api/src/modules/auth/probe.ts', 'flights'],
      ['apps/api/src/modules/flights/probe.ts', 'booking'],
      ['apps/api/src/modules/booking/probe.ts', 'flights']
    ] as const) {
      const errors = await restrictedImportErrors(file, `import { api } from '../${other}/index.js';\nexport const x = api;\n`);
      expect(errors, `${file} -> ${other}/index.js`).toEqual([]);
    }
  });

  it('allows imports inside the same module and from platform/shared', async () => {
    const errors = await restrictedImportErrors(
      'apps/api/src/modules/booking/probe.ts',
      [
        "import { a } from './hold.service.js';",
        "import { b } from '../../platform/db.js';",
        "import { c } from '@flight/shared';",
        'export const x = [a, b, c];'
      ].join('\n')
    );
    expect(errors).toEqual([]);
  });

  it('forbids platform from importing modules', async () => {
    const errors = await restrictedImportErrors(
      'apps/api/src/platform/probe.ts',
      "import { authService } from '../modules/auth/index.js';\nexport const x = authService;\n"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('platform must never import from modules');
  });

  it('lets app wiring import modules only through their index', async () => {
    const bad = await restrictedImportErrors(
      'apps/api/src/app.ts',
      "import { router } from './modules/auth/auth.routes.js';\nexport const x = router;\n"
    );
    expect(bad).toHaveLength(1);
    const good = await restrictedImportErrors(
      'apps/api/src/app.ts',
      "import { authRouter } from './modules/auth/index.js';\nexport const x = authRouter;\n"
    );
    expect(good).toEqual([]);
  });
});
