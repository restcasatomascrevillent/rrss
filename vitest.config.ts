import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'jsdom',
          globals: true,
          include: ['src/**/*.test.ts'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
      {
        // Pruebas de componentes: la aplicación real en jsdom con el cliente de
        // Supabase simulado (src/test/fakeSupabase.ts). Cualquier *.test.tsx cae aquí.
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'components',
          environment: 'jsdom',
          globals: true,
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup.components.ts'],
          testTimeout: 40_000,
          hookTimeout: 40_000,
        },
      },
      {
        // Pruebas de base de datos: aplican las migraciones reales a un
        // Postgres en memoria (PGlite) o al de DATABASE_URL.
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
