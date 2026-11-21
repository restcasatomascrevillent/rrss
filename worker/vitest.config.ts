import { defineConfig } from 'vitest/config';

// Las pruebas lanzan FFmpeg de verdad: van en serie para no saturar la máquina.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
