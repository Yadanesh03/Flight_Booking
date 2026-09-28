import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const MODULES = ['auth', 'flights', 'booking'];

/**
 * Module boundary rules (Architecture spec, Section 3.3):
 *  - a module may import another module ONLY through `<module>/index.js`;
 *  - `platform` never imports from modules;
 *  - app wiring (app.ts, main.ts, seed) may import modules only through their index.
 */
function moduleBoundary(self) {
  const others = MODULES.filter((m) => m !== self);
  return {
    files: [`apps/api/src/modules/${self}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: others.map((other) => ({
            group: [`../${other}/**`, `!../${other}/index.js`, `**/modules/${other}/**`, `!**/modules/${other}/index.js`],
            message: `Module '${self}' may only import '${other}' through its public API (modules/${other}/index.ts).`
          }))
        }
      ]
    }
  };
}

/**
 * Every boundary rule in one array. Exported so tests/unit/boundary.test.ts can lint probe snippets
 * against exactly the rules the repo enforces (spec test 25).
 */
export const boundaryConfigs = [
  ...MODULES.map(moduleBoundary),
  {
    files: ['apps/api/src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**', '../modules', '../../modules'],
              message: 'platform must never import from modules.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['apps/api/src/app.ts', 'apps/api/src/main.ts', 'apps/api/src/seed/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*/**', '!**/modules/*/index.js'],
              message: 'Import modules only through their public API (modules/<name>/index.ts).'
            }
          ]
        }
      ]
    }
  }
];

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.tools/**', '**/coverage/**', 'apps/api/src/db/migrations/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts', 'apps/web/vite.config.ts']
        },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } }
  },
  ...boundaryConfigs,
  {
    // Test files: relax rules that fight with mocking and supertest ergonomics.
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off'
    }
  }
);
