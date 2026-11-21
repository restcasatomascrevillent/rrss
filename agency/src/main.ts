// Punto de entrada: `node --import ./src/register.ts src/main.ts <orden> …`.
import { run } from './cli.ts';

process.exitCode = await run(process.argv.slice(2));
