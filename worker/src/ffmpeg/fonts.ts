// Tipografía por defecto para el texto de los vídeos. FFmpeg necesita la ruta
// de un archivo de fuente: se configura con WORKER_FONT_FILE o se busca entre
// las habituales del sistema (en el contenedor, DejaVu Sans).
import { existsSync } from 'node:fs';

const CANDIDATES = [
  '/usr/share/fonts/dejavu/DejaVuSans.ttf', // Alpine (font-dejavu)
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', // Debian y Ubuntu (fonts-dejavu-core)
  '/usr/share/fonts/TTF/DejaVuSans.ttf', // Arch
  '/System/Library/Fonts/Supplemental/Arial.ttf', // macOS
  'C:/Windows/Fonts/arial.ttf', // Windows
];

export function findDefaultFont(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.WORKER_FONT_FILE) return env.WORKER_FONT_FILE;
  return CANDIDATES.find((file) => existsSync(file));
}
