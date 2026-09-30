import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `worktrees` holds writers' git worktrees (in-repo because /tmp is a
    // per-call read-only tmpfs here and the workspace parent is read-only); an
    // unignored one would be swept into the main tree's lint run.
    //
    // `.gate-logs` holds the gate's raw logs AND the evidence the dispatcher
    // preserves from each retired writer, which includes `.ts`/`.tsx` injection
    // backups. It was missing here until that evidence broke the lint run with
    // two parsing errors — the SAME hazard as an unignored worktree, so it gets
    // the same treatment rather than being worked around by renaming evidence.
    ignores: ['dist', 'coverage', 'node_modules', '.pnpm-home', 'worktrees', '.gate-logs'],
  },

  // Plain JS files (project tooling) — no type information available.
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Application and test sources — strict type-checked TypeScript.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      prettier,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Numbers interpolate deterministically; the default ban is too strict
      // for a codebase that formats counts and indices into messages/tests.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },

  // shadcn/ui generated files legitimately export cva variants next to their
  // components; keep them as-generated so registry updates stay diffable.
  {
    files: ['src/components/ui/**'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
);
