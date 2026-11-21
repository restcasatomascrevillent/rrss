// Dependencias reales de las funciones de supresión, sobre los clientes de
// Supabase que crea cada `index.ts` (Deno). Aquí no hay nada de Deno, así que
// también se compila con el resto del código compartido. La lógica está en
// handler.ts, probada en Node.
//
// Secretos: la clave de servicio solo existe en la función (variables de
// entorno). `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`
// las pone Supabase en todas las funciones.
import type { ObjectStorage } from '../storage/contract.ts';
import { listAllObjects, type GdprDeps, type GdprRpcClient } from './handler.ts';

const BUCKET = 'brand-media';

type ErrorLike = { message: string } | null;

/** Lo que se usa del cliente con la clave de servicio. */
export interface GdprAdminClient {
  auth: {
    getUser(token: string): Promise<{ data: { user: { id: string; email?: string | null } | null }; error: unknown }>;
    admin: { deleteUser(id: string): Promise<{ error: ErrorLike }> };
  };
  rpc: GdprRpcClient;
  storage: {
    from(bucket: string): {
      list(
        prefix: string,
        options: { limit: number; offset: number },
      ): Promise<{ data: { name: string; id: string | null }[] | null; error: ErrorLike }>;
      remove(paths: string[]): Promise<{ data: unknown; error: ErrorLike }>;
    };
  };
}

/** Lo que se usa de un cliente nuevo con la clave pública (para comprobar la contraseña). */
export interface GdprAnonClient {
  auth: {
    signInWithPassword(c: { email: string; password: string }): Promise<{ error: unknown }>;
    signOut(o: { scope: 'local' }): Promise<unknown>;
  };
}

export function createGdprDeps(options: {
  name: string;
  admin: GdprAdminClient;
  anonClient: () => GdprAnonClient;
  allowedOrigin?: string;
  /**
   * Cubo de Cloudflare R2, si está configurado (docs/almacenamiento-r2.md): lo
   * que haya bajo la carpeta de la organización también se borra.
   */
  r2?: () => Promise<ObjectStorage | null>;
}): GdprDeps {
  const { admin, name } = options;
  return {
    async authenticate(accessToken) {
      const { data, error } = await admin.auth.getUser(accessToken);
      return error || !data.user ? null : { userId: data.user.id, email: data.user.email ?? '' };
    },

    // Comprueba la contraseña abriendo una sesión aparte que se cierra al
    // momento (solo esa: la de la persona sigue abierta mientras no se borre).
    async verifyPassword(email, password) {
      const probe = options.anonClient();
      const { error } = await probe.auth.signInWithPassword({ email, password });
      if (error) return false;
      await probe.auth.signOut({ scope: 'local' });
      return true;
    },

    rpc: (fn, args) => admin.rpc(fn, args),

    async listObjects(prefix) {
      const paths = await listAllObjects(async (folder, offset) => {
        const { data, error } = await admin.storage.from(BUCKET).list(folder, { limit: 1000, offset });
        if (error) throw new Error(error.message);
        return (data ?? []).map((item) => ({ name: item.name, id: item.id ?? null }));
      }, prefix);
      const r2 = await options.r2?.();
      if (r2) for (const object of await r2.list(prefix)) paths.push(object.key);
      return [...new Set(paths)];
    },

    // La API borra lo que existe y no se queja de lo que ya no estaba: solo un
    // error de la llamada deja las rutas pendientes. Con R2, cada ruta se borra
    // en los dos almacenes (en el que no está, no pasa nada).
    async removeObjects(paths) {
      const { error } = await admin.storage.from(BUCKET).remove(paths);
      const failed = new Set(error ? paths : []);
      const r2 = await options.r2?.().catch(() => null);
      if (r2) for (const key of (await r2.remove(paths)).failed) failed.add(key);
      return { failed: [...failed] };
    },

    async deleteAuthUser(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error(error.message);
    },

    log: (event, data) => console.error(`[${name}] ${event}`, JSON.stringify(data)),
    allowedOrigin: options.allowedOrigin,
  };
}
