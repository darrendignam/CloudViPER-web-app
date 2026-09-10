const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
    {
        ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'src/views/**', 'src/public/**']
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                require: 'readonly',
                module: 'writable',
                fetch: 'readonly',
                AbortSignal: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                NodeJS: 'readonly'
            }
        },
        rules: {
            // This codebase leans on `any` for Sequelize rows and Docker
            // payloads. Typing those properly is worthwhile but is a refactor,
            // not a lint fix, so it is a warning rather than an error for now.
            '@typescript-eslint/no-explicit-any': 'warn',
            // Catches the genuinely dead code: an assigned result nobody reads,
            // which is how the terminate route came to discard its own message.
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none'
            }],
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    },
    {
        // app.ts requires its routes lazily so they load after passport is
        // configured, and ContainerService defers the Kubernetes client the same
        // way. Converting these to imports would hoist them and change init
        // order, which is a refactor with real risk rather than a lint fix.
        files: ['src/app.ts', 'src/logs/**'],
        rules: {
            '@typescript-eslint/no-require-imports': 'off'
        }
    },
    {
        files: ['src/test/**/*.ts'],
        languageOptions: {
            globals: {
                describe: 'readonly',
                it: 'readonly',
                expect: 'readonly',
                jest: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly'
            }
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
            // Test scaffolding accumulates unused helpers and imports. They are
            // dead weight rather than a correctness risk, and removing them in
            // bulk risks disturbing suites for no behavioural gain, so they are
            // surfaced rather than enforced. Source code keeps this as an error.
            '@typescript-eslint/no-unused-vars': 'warn'
        }
    }
);
