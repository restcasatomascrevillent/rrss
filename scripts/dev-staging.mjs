// Arranca la aplicación en local contra el Supabase de staging de rrss.
//
//   npm run dev:staging
//
// No usa ningún archivo .env: la URL y la clave pública (anon) de staging se
// pasan a Vite por entorno, que tiene prioridad sobre los .env*. La clave anon
// es pública (acaba en el navegador); se pide a la API de gestión de Supabase
// con el token de rrss (el mismo que usa scripts/supabase-rrss.sh) para no
// tenerla escrita en el repositorio. De la respuesta solo se usa la anon: la
// clave de servicio no se guarda ni se imprime.
//
// En Node y no en bash: en Windows, `bash` lanzado desde npm puede ser el de
// WSL, que no ve el Node de Windows.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const PROJECT_REF = 'zzkdrfhqmjfvrdsoguio';
const tokenFile = process.env.RRSS_SUPABASE_TOKEN_FILE ?? join(homedir(), '.supabase-rrss', 'token');

function fail(message) {
  console.error(message);
  process.exit(2);
}

let token;
try {
  token = readFileSync(tokenFile, 'utf8').trim();
} catch {
  fail(`Falta el token de rrss en ${tokenFile} (una sola línea, sin extensión).`);
}
if (!token) fail(`El archivo del token de rrss está vacío: ${tokenFile}`);

const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) fail(`No se pudo obtener la clave pública de staging (HTTP ${response.status}).`);
const keys = await response.json();
const anon = Array.isArray(keys) ? keys.find((k) => k.name === 'anon')?.api_key : undefined;
if (!anon) fail('La respuesta de Supabase no trae la clave pública (anon).');

const env = {
  ...process.env,
  VITE_SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
  VITE_SUPABASE_ANON_KEY: anon,
};
delete env.RRSS_SUPABASE_TOKEN_FILE;

console.log(`Aplicación contra staging (${PROJECT_REF}) en http://localhost:5173`);
const child = spawn('npx', ['vite', '--port', '5173', '--strictPort', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
