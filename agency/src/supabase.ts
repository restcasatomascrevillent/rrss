// Cliente mínimo de Supabase con `fetch`: inicio de sesión con correo y
// contraseña, PostgREST (tablas y funciones) y firma de URL de Storage.
//
// Todo va con el token de la cuenta de la agencia: la base de datos aplica la
// RLS y los permisos de esa persona. Aquí no existe la clave de servicio.

export interface SupabaseClientOptions {
  url: string;
  anonKey: string;
  fetch?: typeof fetch;
  /** Espera antes de repetir una petición rechazada por un token «del futuro» (ms). */
  retryDelayMs?: number;
}

export interface Session {
  accessToken: string;
  userId: string;
  email: string;
}

/** Error de la API con el código de Postgres (42501, RQ001…) o de la autenticación. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: string | null;

  constructor(message: string, status: number, code: string | null = null, details: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function apiError(response: Response, context: string): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  let message = text.slice(0, 300) || response.statusText;
  let code: string | null = null;
  let details: string | null = null;
  try {
    const body = JSON.parse(text) as {
      message?: string;
      msg?: string;
      error_description?: string;
      error?: string;
      code?: string | number;
      error_code?: string;
      details?: string;
    };
    message = body.message ?? body.msg ?? body.error_description ?? body.error ?? message;
    code = body.code !== undefined ? String(body.code) : (body.error_code ?? null);
    details = body.details ?? null;
  } catch {
    // Cuerpo que no es JSON: se queda el texto.
  }
  return new ApiError(`${context}: ${message}`, response.status, code, details);
}

export interface SignedUrl {
  path: string;
  signedUrl: string | null;
  error: string | null;
}

export interface SupabaseClient {
  signIn(email: string, password: string): Promise<Session>;
  readonly session: Session | null;
  /** Llama a una función de `public` con argumentos por nombre. */
  rpc<T>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Lee una tabla con una consulta de PostgREST (`select=…&id=eq.…`). */
  select<T>(table: string, query: string): Promise<T[]>;
  /** URL firmadas de varios archivos de un cubo privado. */
  signUrls(bucket: string, paths: string[], expiresInSeconds: number): Promise<SignedUrl[]>;
}

export function createClient(options: SupabaseClientOptions): SupabaseClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, '');
  let session: Session | null = null;
  const retryDelay = options.retryDelayMs ?? 1000;

  /**
   * Un token recién emitido puede llegar a PostgREST o a Storage con su reloj
   * un segundo por detrás («JWT issued at future», PGRST303): se repite la
   * petición tras una espera corta, hasta dos veces. Cualquier otro error sale tal cual.
   */
  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, init);
      if (response.status !== 401 || attempt >= 2) return response;
      const text = await response
        .clone()
        .text()
        .catch(() => '');
      if (!/PGRST303|issued at future|iat/i.test(text)) return response;
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }

  const headers = (json = true): Record<string, string> => {
    if (!session) throw new Error('Primero hay que iniciar sesión.');
    return {
      apikey: options.anonKey,
      Authorization: `Bearer ${session.accessToken}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  };

  return {
    get session() {
      return session;
    },

    async signIn(email, password) {
      const response = await doFetch(`${base}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: options.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) throw await apiError(response, 'No se ha podido iniciar sesión con la cuenta de la agencia');
      const body = (await response.json()) as { access_token?: string; user?: { id?: string; email?: string } };
      if (!body.access_token || !body.user?.id)
        throw new ApiError('La respuesta del inicio de sesión no trae sesión', 500);
      session = { accessToken: body.access_token, userId: body.user.id, email: body.user.email ?? email };
      return session;
    },

    async rpc<T>(name: string, args: Record<string, unknown> = {}) {
      const response = await send(`${base}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(args),
      });
      if (!response.ok) throw await apiError(response, `La plataforma rechazó ${name}`);
      const text = await response.text();
      return (text ? JSON.parse(text) : null) as T;
    },

    async select<T>(table: string, query: string) {
      const response = await send(`${base}/rest/v1/${table}?${query}`, { headers: headers(false) });
      if (!response.ok) throw await apiError(response, `No se ha podido leer ${table}`);
      return (await response.json()) as T[];
    },

    async signUrls(bucket, paths, expiresInSeconds) {
      if (!paths.length) return [];
      const response = await send(`${base}/storage/v1/object/sign/${encodeURIComponent(bucket)}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ expiresIn: expiresInSeconds, paths }),
      });
      if (!response.ok) throw await apiError(response, 'No se han podido firmar los enlaces de los recursos');
      const rows = (await response.json()) as { path: string | null; signedURL: string | null; error: string | null }[];
      return rows.map((row, index) => ({
        path: row.path ?? paths[index]!,
        signedUrl: row.signedURL ? `${base}/storage/v1${row.signedURL}` : null,
        error: row.error,
      }));
    },
  };
}
