// Almacenamiento de medios tal como lo necesita el trabajador: bajar un
// archivo a disco y subir otro. Siempre por archivo (nunca en memoria): un
// vídeo puede pesar cientos de megas.
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PermanentError } from './errors.ts';
import type { Job } from './queue.ts';

export interface UploadOptions {
  contentType: string;
  signal?: AbortSignal;
}

export interface MediaStorage {
  download(objectPath: string, destinationFile: string, signal?: AbortSignal): Promise<void>;
  upload(sourceFile: string, objectPath: string, options: UploadOptions): Promise<void>;
  /**
   * Almacenamiento ligado a un trabajo reservado (lo usa el intermediario
   * `worker-gateway`, que solo firma rutas del trabajo que tiene reservado ese
   * trabajador). Si existe, el bucle se lo da a cada manejador en lugar del general.
   */
  forJob?(job: Job, worker: string): MediaStorage;
}

const validSegment = (s: string) => s.length > 0 && s !== '.' && s !== '..' && !s.includes('\\');

/**
 * Comprueba que una ruta del cubo pertenece a la marca del trabajo:
 * `<organización>/<marca>/<carpeta>/<archivo>`. Con el intermediario
 * (`worker-gateway`) la base de datos lo vuelve a comprobar; con la clave de
 * servicio (modo local), que se salta la RLS, esta comprobación es la que
 * impide que un trabajo lea o escriba medios de otra marca.
 */
export function assertJobPath(job: Pick<Job, 'organization_id' | 'brand_id'>, objectPath: string): string {
  if (!job.brand_id) throw new PermanentError('Un trabajo de medios debe pertenecer a una marca');
  const segments = objectPath.split('/');
  const valid =
    segments.length >= 3 &&
    segments.every(validSegment) &&
    segments[0] === job.organization_id &&
    segments[1] === job.brand_id;
  if (!valid) throw new PermanentError(`La ruta «${objectPath}» no pertenece a la marca del trabajo`);
  return objectPath;
}

/** Cubo en una carpeta local: para pruebas y para ejecutar trabajos a mano. */
export function createFolderStorage(root: string): MediaStorage {
  const resolve = (objectPath: string) => {
    const full = path.resolve(root, objectPath);
    if (!full.startsWith(path.resolve(root) + path.sep)) {
      throw new PermanentError(`La ruta «${objectPath}» se sale de la carpeta de almacenamiento`);
    }
    return full;
  };
  return {
    async download(objectPath, destinationFile) {
      const source = resolve(objectPath);
      try {
        await stat(source);
      } catch {
        throw new PermanentError(`No existe el archivo «${objectPath}»`);
      }
      await copyFile(source, destinationFile);
    },
    async upload(sourceFile, objectPath) {
      const destination = resolve(objectPath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(sourceFile, destination);
    },
  };
}
