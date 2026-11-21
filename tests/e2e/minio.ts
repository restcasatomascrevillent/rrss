// MinIO en Docker: el «Cloudflare R2» de la prueba local (docs/almacenamiento-r2.md).
// Solo para la prueba e2e: credenciales fijas y públicas, cubo de usar y tirar.
import { execFileSync, spawnSync } from 'node:child_process';
import { signS3Request } from '../../supabase/functions/_shared/storage/sigv4.ts';

export const MINIO = {
  contenedor: 'rrss-e2e-minio',
  // MinIO ya no publica imágenes en Docker Hub: la de Bitnami (repositorio «legacy»), con versión fija.
  imagen: 'bitnamilegacy/minio:2025.7.23',
  // Red del stack local de la CLI (project_id = "rrss-local" en supabase/config.toml):
  // las funciones llegan a MinIO por su nombre; el navegador, por el puerto publicado.
  red: 'supabase_network_rrss-local',
  publico: 'http://127.0.0.1:59000',
  interno: 'http://rrss-e2e-minio:9000',
  // Solo existen en este contenedor de pruebas: no son secretos de nadie.
  usuario: 'rrsse2eminio0001',
  clave: 'rrsse2eminiosecreto0001',
  cubo: 'rrss-e2e-media',
} as const;

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Registro del contenedor; Bitnami escribe sus avisos por la salida de errores. */
function registro(): string {
  const r = spawnSync('docker', ['logs', MINIO.contenedor], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

async function firmado(method: string, ruta: string): Promise<Response> {
  const url = `${MINIO.publico}${ruta}`;
  const headers = await signS3Request({
    method,
    url,
    region: 'us-east-1',
    credentials: { accessKeyId: MINIO.usuario, secretAccessKey: MINIO.clave },
  });
  return fetch(url, { method, headers });
}

/** Arranca MinIO (de cero) y crea el cubo. */
export async function arrancarMinio(): Promise<void> {
  try {
    docker('rm', '-f', MINIO.contenedor);
  } catch {
    // No existía.
  }
  docker(
    'run',
    '-d',
    '--name',
    MINIO.contenedor,
    '--network',
    MINIO.red,
    '-p',
    `127.0.0.1:${new URL(MINIO.publico).port}:9000`,
    '-e',
    `MINIO_ROOT_USER=${MINIO.usuario}`,
    '-e',
    `MINIO_ROOT_PASSWORD=${MINIO.clave}`,
    MINIO.imagen,
  );
  const limite = Date.now() + 60_000;
  // La imagen de Bitnami arranca MinIO en segundo plano para configurarse, lo
  // PARA y lo vuelve a arrancar: durante esa preparación ya responde «vivo»,
  // pero el reinicio corta las conexiones (el navegador ve ERR_EMPTY_RESPONSE en
  // la subida). Hay que esperar al final de la preparación y, después, a que responda.
  while (!registro().includes('MinIO setup finished')) {
    if (Date.now() > limite) throw new Error('MinIO no terminó de prepararse');
    await new Promise((listo) => setTimeout(listo, 500));
  }
  for (;;) {
    const vivo = await fetch(`${MINIO.publico}/minio/health/live`).catch(() => null);
    if (vivo?.ok) break;
    if (Date.now() > limite) throw new Error('MinIO no arrancó');
    await new Promise((listo) => setTimeout(listo, 1_000));
  }
  const cubo = await firmado('PUT', `/${MINIO.cubo}`);
  if (!cubo.ok) throw new Error(`No se pudo crear el cubo de MinIO (${cubo.status})`);
}

export function pararMinio(): void {
  try {
    docker('rm', '-f', MINIO.contenedor);
  } catch {
    // Ya no estaba.
  }
}

/** Tamaño del objeto en MinIO, o null si no está. */
export async function objetoEnMinio(clave: string): Promise<number | null> {
  const ruta = `/${MINIO.cubo}/${clave.split('/').map(encodeURIComponent).join('/')}`;
  const respuesta = await firmado('HEAD', ruta);
  if (respuesta.status === 404) return null;
  if (!respuesta.ok) throw new Error(`MinIO respondió ${respuesta.status}`);
  return Number(respuesta.headers.get('content-length'));
}
