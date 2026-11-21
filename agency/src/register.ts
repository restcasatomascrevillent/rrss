// Registra la resolución de módulos de loader.ts antes de arrancar la
// herramienta: `node --import ./src/register.ts src/main.ts`.
import { register } from 'node:module';

register('./loader.ts', import.meta.url);
