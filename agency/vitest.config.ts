import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// La herramienta reutiliza la lógica de la aplicación (esquema del documento,
// catálogo de redes, verificador de marca): el alias `@` apunta a ../src igual
// que en la aplicación.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
