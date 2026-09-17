import { configDefaults, defineConfig } from 'vitest/config';

const cockroachIntegrationFiles = [
  'src/__tests__/decision-receipt.e2e.test.ts',
  'src/__tests__/gmail-archive-admission-repository.integration.test.ts',
  'src/__tests__/gmail-archive-proposal-repository.integration.test.ts',
  'src/__tests__/owned-migration.e2e.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [
            ...configDefaults.exclude,
            '**/dist/**',
            ...cockroachIntegrationFiles,
          ],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'cockroach-integration',
          include: cockroachIntegrationFiles,
          exclude: [...configDefaults.exclude, '**/dist/**'],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    passWithNoTests: true,
  },
});
