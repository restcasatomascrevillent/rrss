// Lógica de las Edge Functions de supresión (RGPD, derecho de supresión):
//   * `delete-account`: borra la cuenta de quien llama.
//   * `delete-organization`: borra una organización de la que quien llama es propietario.
// Sin nada de Deno: recibe sus dependencias y devuelve una `Response`, para que
// las pruebas la ejecuten en Node contra las migraciones reales
// (tests/db/rgpd.test.ts). Los `index.ts` de cada función solo la conectan.
//
// Garantías:
//   1. El usuario sale SIEMPRE del token de sesión validado; el cuerpo de la
//      petición no puede nombrar a otra persona.
//   2. Las funciones SQL (`gdpr_*`) solo las ejecuta la clave de servicio y
//      vuelven a comprobar los permisos de ese usuario: un propietario solo
//      borra su organización, y una cuenta no se borra si deja una organización
//      con miembros sin propietario (RG001).
//   3. Confirmación fuerte: para la cuenta, escribir el propio correo y la
//      contraseña; para la organización, escribir su nombre exacto (RG002).
//   4. Los archivos se borran de Storage después de los datos. Si falla, sus
//      rutas siguen en `storage_cleanup_queue` para que el servidor las barra.
//
// Esto no es asesoría legal: qué se borra y qué se conserva es una propuesta
// para revisar (docs/rgpd.md).

export type GdprRpcClient = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { code?: string; message: string; details?: string | null } | null }>;

export interface GdprDeps {
  /** Valida el token de sesión y devuelve el usuario, o `null` si no vale. */
  authenticate(accessToken: string): Promise<{ userId: string; email: string } | null>;
  /** ¿Es la contraseña de esa cuenta? (Solo para borrar la cuenta.) */
  verifyPassword(email: string, password: string): Promise<boolean>;
  /** Funciones SQL con la clave de servicio. */
  rpc: GdprRpcClient;
  /** Todas las rutas del cubo bajo un prefijo (recursivo). */
  listObjects(prefix: string): Promise<string[]>;
  /** Borra archivos del cubo; devuelve las rutas que no se pudieron borrar. */
  removeObjects(paths: string[]): Promise<{ failed: string[] }>;
  /** Borra la cuenta de Auth (API de administración, clave de servicio). */
  deleteAuthUser(userId: string): Promise<void>;
  /** Registro del servidor. Nunca recibe contraseñas ni tokens. */
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Origen permitido para CORS (por defecto, cualquiera: la sesión va en cabecera, no en cookie). */
  allowedOrigin?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 10_000;
/** Lote máximo de la API de Storage para borrar. */
export const STORAGE_REMOVE_BATCH = 1000;

type Json = Record<string, unknown>;

function responder(allowedOrigin: string | undefined) {
  const cors = {
    'access-control-allow-origin': allowedOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
    });
  const fail = (status: number, code: string, message: string, extra: Json = {}) =>
    json(status, { error: { code, message, ...extra } });
  return { cors, json, fail };
}

type Fail = ReturnType<typeof responder>['fail'];

/** Sesión y cuerpo comunes a las dos funciones. */
async function readRequest(
  request: Request,
  deps: GdprDeps,
  fail: Fail,
): Promise<{ user: { userId: string; email: string }; body: Json } | Response> {
  const header = request.headers.get('authorization') ?? '';
  const accessToken = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (!accessToken) return fail(401, 'unauthenticated', 'Inicia sesión para continuar.');
  let user: { userId: string; email: string } | null;
  try {
    user = await deps.authenticate(accessToken);
  } catch {
    return fail(500, 'internal', 'No se ha podido comprobar la sesión. Inténtalo de nuevo.');
  }
  if (!user) return fail(401, 'unauthenticated', 'La sesión ha caducado. Vuelve a iniciar sesión.');

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, 'too_large', 'La petición es demasiado grande.');
    body = JSON.parse(raw || '{}');
  } catch {
    return fail(400, 'invalid_request', 'La petición no es JSON válido.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(400, 'invalid_request', 'La petición no es válida.');
  }
  return { user, body: body as Json };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Borra los archivos de las organizaciones borradas: las rutas que dio la base
 * de datos más lo que haya en el cubo bajo `<organización>/`. Quita de la cola
 * de limpieza lo que se borró. Nunca lanza: un fallo deja las rutas en la cola.
 */
async function removeOrganizationFiles(
  deps: GdprDeps,
  organizationIds: string[],
  knownPaths: string[],
): Promise<{ removed: number; failed: number }> {
  const paths = new Set(knownPaths);
  for (const id of organizationIds) {
    try {
      for (const path of await deps.listObjects(`${id}/`)) paths.add(path);
    } catch (error) {
      deps.log?.('storage_list_failed', { organizationId: id, message: (error as Error).message });
    }
  }
  // Solo rutas de esas organizaciones: nada fuera de su prefijo.
  const all = [...paths].filter((p) => organizationIds.some((id) => p.startsWith(`${id}/`)));
  let failed: string[] = [];
  for (let i = 0; i < all.length; i += STORAGE_REMOVE_BATCH) {
    const batch = all.slice(i, i + STORAGE_REMOVE_BATCH);
    try {
      failed = failed.concat((await deps.removeObjects(batch)).failed);
    } catch (error) {
      deps.log?.('storage_remove_failed', { count: batch.length, message: (error as Error).message });
      failed = failed.concat(batch);
    }
  }
  const removed = all.filter((p) => !failed.includes(p));
  if (removed.length > 0) {
    const { error } = await deps.rpc('gdpr_forget_storage_paths', { p_paths: removed });
    if (error) deps.log?.('cleanup_queue_failed', { code: error.code, message: error.message });
  }
  if (failed.length > 0) deps.log?.('storage_files_pending', { count: failed.length });
  return { removed: removed.length, failed: failed.length };
}

/** `delete-account`: cuerpo `{ confirmation: <tu correo>, password: <tu contraseña> }`. */
export function createDeleteAccountHandler(deps: GdprDeps): (request: Request) => Promise<Response> {
  const { cors, json, fail } = responder(deps.allowedOrigin);

  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Esta función solo admite POST.');

    const read = await readRequest(request, deps, fail);
    if (read instanceof Response) return read;
    const { user, body } = read;

    // Confirmación fuerte: el correo escrito a mano y la contraseña.
    const confirmation = typeof body.confirmation === 'string' ? body.confirmation.trim().toLowerCase() : '';
    if (!user.email || confirmation !== user.email.trim().toLowerCase()) {
      return fail(400, 'confirmation_mismatch', 'Escribe tu correo electrónico exactamente para confirmar el borrado.');
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) return fail(400, 'password_required', 'Escribe tu contraseña para confirmar el borrado.');
    let passwordOk: boolean;
    try {
      passwordOk = await deps.verifyPassword(user.email, password);
    } catch {
      return fail(500, 'internal', 'No se ha podido comprobar la contraseña. Inténtalo de nuevo.');
    }
    if (!passwordOk) return fail(403, 'wrong_password', 'La contraseña no es correcta.');

    // Datos: comprueba que no deja organizaciones sin propietario y borra las suyas.
    const { data, error } = await deps.rpc('gdpr_delete_account_data', { p_user_id: user.userId });
    if (error) {
      if (error.code === 'RG001') {
        let blocking: unknown = [];
        try {
          blocking = JSON.parse(error.details ?? '[]');
        } catch {
          /* sin detalle */
        }
        return fail(409, 'owner_of_shared_organizations', error.message, { blocking });
      }
      deps.log?.('delete_account_data_failed', { code: error.code, message: error.message });
      return fail(500, 'internal', 'No se ha podido borrar la cuenta. Inténtalo de nuevo.');
    }
    const result = (data ?? {}) as Json;
    const deletedOrganizations = Array.isArray(result.deleted_organizations)
      ? (result.deleted_organizations as Json[])
      : [];

    // Cuenta de Auth: al borrarla, la base de datos anonimiza su autoría.
    try {
      await deps.deleteAuthUser(user.userId);
    } catch (e) {
      deps.log?.('delete_auth_user_failed', { message: (e as Error).message });
      return fail(
        500,
        'auth_delete_failed',
        deletedOrganizations.length > 0
          ? 'Se han borrado tus organizaciones sin más miembros, pero no la cuenta. Vuelve a intentarlo.'
          : 'No se ha podido borrar la cuenta. Inténtalo de nuevo.',
      );
    }

    const organizationIds = deletedOrganizations
      .map((o) => o.organization_id)
      .filter((id): id is string => typeof id === 'string');
    const files = await removeOrganizationFiles(deps, organizationIds, stringList(result.storage_paths));
    deps.log?.('account_deleted', { organizations: organizationIds.length, files: files.removed });
    return json(200, {
      deleted: true,
      deletedOrganizations: deletedOrganizations.map((o) => ({ id: o.organization_id, name: o.name })),
      filesPending: files.failed,
    });
  };
}

/** `delete-organization`: cuerpo `{ organizationId, confirmation: <nombre exacto> }`. */
export function createDeleteOrganizationHandler(deps: GdprDeps): (request: Request) => Promise<Response> {
  const { cors, json, fail } = responder(deps.allowedOrigin);

  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Esta función solo admite POST.');

    const read = await readRequest(request, deps, fail);
    if (read instanceof Response) return read;
    const { user, body } = read;

    const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
    if (!UUID.test(organizationId)) return fail(400, 'invalid_request', 'Indica la organización (organizationId).');
    const confirmation = typeof body.confirmation === 'string' ? body.confirmation : '';

    const { data, error } = await deps.rpc('gdpr_delete_organization', {
      p_user_id: user.userId,
      p_organization_id: organizationId,
      p_confirmation: confirmation,
    });
    if (error) {
      if (error.code === '42501') return fail(403, 'forbidden', error.message);
      if (error.code === 'RG002') return fail(400, 'confirmation_mismatch', error.message);
      deps.log?.('delete_organization_failed', { code: error.code, message: error.message });
      return fail(500, 'internal', 'No se ha podido borrar la organización. Inténtalo de nuevo.');
    }
    const result = (data ?? {}) as Json;
    const files = await removeOrganizationFiles(deps, [organizationId], stringList(result.storage_paths));
    deps.log?.('organization_deleted', { files: files.removed });
    return json(200, { deleted: true, organizationId, filesPending: files.failed });
  };
}

/**
 * Lista recursiva del cubo con la API de Storage (que lista por carpetas):
 * `list(prefix, offset)` devuelve una página; un elemento sin `id` es una carpeta.
 */
export async function listAllObjects(
  list: (prefix: string, offset: number) => Promise<{ name: string; id: string | null }[]>,
  prefix: string,
  pageSize = 1000,
): Promise<string[]> {
  const base = prefix.replace(/\/+$/, '');
  const out: string[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await list(base, offset);
    for (const item of page) {
      const path = `${base}/${item.name}`;
      if (item.id) out.push(path);
      else out.push(...(await listAllObjects(list, path, pageSize)));
    }
    if (page.length < pageSize) break;
  }
  return out;
}
