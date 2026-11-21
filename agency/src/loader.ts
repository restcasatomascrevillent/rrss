// Resolución de módulos para importar la lógica compartida de la aplicación
// (`../src`) desde Node sin empaquetar: el alias `@/` y las importaciones
// relativas sin extensión, que en la aplicación resuelve Vite.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const APP_SRC = fileURLToPath(new URL('../../src/', import.meta.url));

type Next = (specifier: string, context: unknown) => Promise<unknown>;

function withExtension(file: string): string | null {
  for (const candidate of [file, `${file}.ts`, `${file}.tsx`, path.join(file, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier: string, context: { parentURL?: string }, next: Next): Promise<unknown> {
  if (specifier.startsWith('@/')) {
    const found = withExtension(path.join(APP_SRC, specifier.slice(2)));
    if (found) return next(pathToFileURL(found).href, context);
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const parent = fileURLToPath(context.parentURL);
    if (parent.startsWith(APP_SRC) && !path.extname(specifier)) {
      const found = withExtension(path.resolve(path.dirname(parent), specifier));
      if (found) return next(pathToFileURL(found).href, context);
    }
  }
  return next(specifier, context);
}
