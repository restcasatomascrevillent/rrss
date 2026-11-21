import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, preloadScreenFor } from './App';
import { reloadOnceForNewVersion } from './lib/lazyRoute';
import './index.css';

// La pantalla de entrada se pide ya, en paralelo con la sesión.
preloadScreenFor(window.location.pathname);

// Vite avisa así cuando no puede descargar algo que necesita un trozo de código
// (típico tras un despliegue). Se recarga una vez; si ya se hizo, el error sigue
// su curso y el límite de errores enseña «Hay una versión nueva».
window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnceForNewVersion()) event.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
