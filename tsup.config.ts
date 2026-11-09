import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    api: 'apps/api/src/main.ts',
    worker: 'apps/worker/src/main.ts',
    migrate: 'scripts/migrate.ts',
    'rotate-encryption': 'scripts/rotate-encryption.ts',
    'bootstrap-admin': 'scripts/bootstrap-admin.ts',
    'import-catalogue': 'scripts/import-catalogue.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  noExternal: ['@clubby/contracts', '@clubby/api-client'],
  clean: true,
});
