// Preparación común de las pruebas de componentes (proyecto `components`).
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { fake } from './fakeSupabase';

// El cliente de Supabase se sustituye en el límite del módulo de acceso: todo
// lo que importa `supabase` recibe el simulado.
vi.mock('@/lib/supabase', () => ({ supabase: fake.client, supabaseConfigured: true }));

// Margen holgado: en un CI con poca CPU la primera carga de cada pantalla perezosa tarda.
configure({ asyncUtilTimeout: 10_000 });

// Las pantallas grandes se cargan con `lazy`; se precargan aquí para que la
// primera prueba de cada archivo no pague la transformación de los módulos.
await Promise.all([
  import('@/features/brand/BrandHomePage'),
  import('@/features/brand/BrandProfilePage'),
  import('@/features/brand/BrandWizardPage'),
  import('@/features/library/LibraryPage'),
  import('@/features/content/ContentListPage'),
  import('@/features/content/ContentEditorPage'),
  import('@/features/platform/PlatformPage'),
  import('@/features/team/BrandTeamPage'),
]);

// jsdom no implementa estas APIs del navegador que usan Radix, sonner y la app.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
window.scrollTo = (() => {}) as typeof window.scrollTo;

beforeEach(async () => {
  fake.reset();
  // Lo que se recuerda de si el servidor tiene R2 (se importa aquí: el módulo usa el cliente simulado).
  (await import('@/features/storage/api')).resetMediaStorageAvailability();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
