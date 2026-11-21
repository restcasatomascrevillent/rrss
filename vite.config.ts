import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, strictPort: true },
  // Recorte de fotos en el navegador (onnxruntime-web en un Worker): módulo ES y
  // sin pre-empaquetar, para que encuentre su .wasm (docs/edicion-fotos.md, §7).
  worker: { format: 'es' as const },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          supabase: ['@supabase/supabase-js'],
          ui: [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-tabs',
            'sonner',
          ],
          // Sin lucide-react ni zod: metidos aquí arrastraban todos los iconos
          // (unos 4.700) y el validador al primer paquete. Fuera, cada pantalla
          // carga solo los iconos que usa y zod llega con las pantallas que lo piden.
          data: ['@tanstack/react-query'],
        },
      },
    },
  },
});
