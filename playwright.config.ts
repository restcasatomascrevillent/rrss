import { execSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

// Prueba de extremo a extremo (Fases 1 y 2) contra el Supabase LOCAL
// (`supabase start`, ver supabase/config.toml). Nunca apunta a un proyecto remoto.
//
// La aplicación se sirve en un puerto propio (5273) para no chocar con un
// `npm run dev` abierto en el 5173. Los archivos van en orden y con un solo
// trabajador: cada uno parte de lo que dejó el anterior (usuarios,
// organizaciones, marcas), guardado en `.e2e/estado.json`.
export const E2E_PORT = 5273;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * URL y clave anónima del stack local, leídas de `supabase status -o env`. La
 * clave anónima del stack local es pública (la misma en todas las máquinas):
 * no es un secreto. Se pasan a Vite por entorno, así la prueba no depende de
 * ningún archivo `.env*` (las variables del entorno mandan sobre ellos).
 */
function localSupabase(): { url: string; anonKey: string } {
  let output = '';
  try {
    // execSync usa el intérprete del sistema (en Windows la CLI de npm es un `.cmd`;
    // en Linux/CI la instala supabase/setup-cli como binario). Nada más depende del SO.
    output = execSync('supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { url: '', anonKey: '' };
  }
  const read = (name: string) => new RegExp(`^${name}="?([^"\\r\\n]*)"?`, 'm').exec(output)?.[1] ?? '';
  return { url: read('API_URL'), anonKey: read('ANON_KEY') };
}

const supabase = localSupabase();
// La comprobación (y el mensaje claro si falla) está en tests/e2e/global-setup.ts.
process.env.E2E_SUPABASE_URL_DETECTADA = supabase.url;
// La prueba de aislamiento llama a la API con la clave anónima, como la aplicación.
process.env.E2E_SUPABASE_ANON_KEY = supabase.anonKey;

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // En CI (GitHub Actions) una prueba `.only` olvidada no debe colar un verde falso.
  forbidOnly: !!process.env.CI,
  // Holgados a propósito: con Docker y otros procesos en la misma máquina hay parones de varios segundos.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // En CI se añaden las anotaciones de GitHub; el informe HTML se sube como artefacto si falla.
  reporter: process.env.CI
    ? [['list'], ['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: E2E_BASE_URL,
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    trace: process.env.E2E_TRAZA === '1' ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } }],
  webServer: [
    {
      // La función `ai-generate` con el proveedor simulado de pruebas locales
      // (Fase 2). El archivo no lleva secretos; ver supabase/functions/e2e.env.
      command: 'supabase functions serve --env-file supabase/functions/e2e.env',
      wait: { stdout: /Serving functions on/ },
      timeout: 120_000,
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
      url: `${E2E_BASE_URL}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_SUPABASE_URL: supabase.url,
        VITE_SUPABASE_ANON_KEY: supabase.anonKey,
        // La IA de texto existe en este entorno: la sirve la función local con el proveedor simulado.
        VITE_AI_TEXT_ENABLED: 'true',
        // Y la de imagen (ai-media con la imagen simulada de pruebas locales).
        VITE_AI_IMAGE_ENABLED: 'true',
        // Y la edición de fotos con IA (ai-media con la edición simulada de pruebas locales).
        VITE_AI_PHOTO_EDIT_ENABLED: 'true',
        // Quitar el fondo en el navegador con una máscara simulada (sin descargar el modelo real).
        VITE_CUTOUT_SIMULATED: 'true',
        // El copiloto por voz del editor (tarea editor.copilot con el mismo proveedor simulado).
        VITE_AI_VOICE_COPILOT_ENABLED: 'true',
        // El trabajador de medios existe en este entorno: lo arranca tests/e2e/11-reels.spec.ts contra el stack local.
        VITE_MEDIA_WORKER_ENABLED: 'true',
        // Subtítulos automáticos del editor de reels, con la transcripción simulada (ai-transcribe).
        VITE_REEL_SUBTITLES_ENABLED: 'true',
        // Publicación (Fase 3): conectar y programar, contra la Graph API simulada de social-publish/social-connect.
        VITE_SOCIAL_PUBLISHING_ENABLED: 'true',
        // Biblioteca con Google Drive, contra el Drive simulado de drive-media.
        VITE_DRIVE_LIBRARY_ENABLED: 'true',
      },
    },
  ],
});
