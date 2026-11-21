// Cliente de Supabase simulado para las pruebas de componentes. Sustituye al
// módulo `@/lib/supabase` entero (ver setup.components.ts), de modo que corre
// el código real de cada `api.ts` y de los componentes, y solo se finge la red:
// tablas en memoria, RPC registradas por cada prueba y una sesión que se puede
// abrir y cerrar. Lo que no se ha registrado falla con un error explícito.
// Las Edge Functions (`functions.invoke`) se simulan igual: cada prueba
// registra la respuesta (estado HTTP y cuerpo) con `fake.fn(nombre, …)`.
import { FunctionsFetchError, FunctionsHttpError, type Session, type User } from '@supabase/supabase-js';
import { vi } from 'vitest';

type Row = Record<string, unknown>;
interface QueryResult {
  data: unknown;
  error: unknown;
  count?: number;
}
export type RpcHandler = (args: Record<string, unknown>) => unknown;
/** Respuesta simulada de una Edge Function. Si el manejador lanza, es un fallo de red. */
export interface FunctionReply {
  status: number;
  body: unknown;
}
export type FunctionHandler = (body: unknown) => FunctionReply | Promise<FunctionReply>;
export interface AuthResult {
  data: { user: User | null; session: Session | null };
  error: unknown;
}
export interface Call {
  kind: 'insert' | 'update' | 'delete' | 'rpc' | 'function';
  name: string;
  payload: unknown;
}

type Listener = (event: string, session: Session | null) => void;

/** Disponibilidad de las integraciones que responde el servidor simulado por defecto. */
export const ALL_AVAILABLE = {
  publishing: true,
  socialOAuth: true,
  socialToken: true,
  aiText: true,
  aiImage: true,
  billing: true,
  drive: true,
  // Sin R2: las pruebas de siempre firman y suben con Supabase Storage.
  mediaStorage: false,
  reelSubtitles: true,
};
type Op = 'select' | 'insert' | 'update' | 'delete';

export function makeUser(overrides: Partial<{ id: string; email: string; fullName: string }> = {}): User {
  const { id = 'user-1', email = 'ana@example.com', fullName = 'Ana Pérez' } = overrides;
  return { id, email, user_metadata: { full_name: fullName } } as unknown as User;
}

function makeSession(user: User): Session {
  return { access_token: 'token', refresh_token: 'refresh', user } as unknown as Session;
}

const NOW = '2026-11-16T10:00:00.000Z';

class Query implements PromiseLike<QueryResult> {
  private op: Op = 'select';
  private filters: ((row: Row) => boolean)[] = [];
  private payload: Row | Row[] | null = null;
  private returning = false;
  private one: 'one' | 'maybe' | null = null;
  private orders: { column: string; ascending: boolean }[] = [];
  private window: [number, number] | null = null;
  private max: number | null = null;
  private head = false;
  private wantCount = false;

  constructor(
    private readonly fake: FakeSupabase,
    private readonly table: string,
  ) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    if (this.op === 'select') {
      this.head = options?.head === true;
      this.wantCount = options?.count !== undefined;
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(payload: Row | Row[]) {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = 'update';
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  neq(column: string, value: unknown) {
    this.filters.push((row) => row[column] !== value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  is(column: string, value: unknown) {
    this.filters.push((row) => (value === null ? row[column] == null : row[column] === value));
    return this;
  }
  /** Solo la forma que usa la aplicación: `.not(col, 'is', null)`. */
  not(column: string, operator: string, value: unknown) {
    if (operator !== 'is' || value !== null) throw new Error(`not(${operator}) sin simular en la prueba`);
    this.filters.push((row) => row[column] != null);
    return this;
  }
  /** LIKE sin distinguir mayúsculas, con los comodines escapados por `likePattern`. */
  ilike(column: string, pattern: string) {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]!;
      if (c === '\\' && i + 1 < pattern.length) source += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      else if (c === '%') source += '.*';
      else if (c === '_') source += '.';
      else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    const regex = new RegExp(`^${source}$`, 'is');
    this.filters.push((row) => regex.test(String(row[column] ?? '')));
    return this;
  }
  gte(column: string, value: unknown) {
    this.filters.push((row) => String(row[column]) >= String(value));
    return this;
  }
  lt(column: string, value: unknown) {
    this.filters.push((row) => String(row[column]) < String(value));
    return this;
  }
  gt(column: string, value: unknown) {
    this.filters.push((row) => String(row[column]) > String(value));
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  range(from: number, to: number) {
    this.window = [from, to];
    return this;
  }
  single() {
    this.one = 'one';
    return this;
  }
  maybeSingle() {
    this.one = 'maybe';
    return this;
  }

  then<R1 = QueryResult, R2 = never>(
    onFulfilled?: ((value: QueryResult) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve()
      .then(() => this.run())
      .then(onFulfilled, onRejected);
  }

  private matching(): Row[] {
    const rows = this.fake.tables[this.table] ?? [];
    return rows.filter((row) => this.filters.every((f) => f(row)));
  }

  private shape(rows: Row[]): QueryResult {
    if (this.one === 'one') {
      if (rows.length !== 1)
        return {
          data: null,
          error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
        };
      return { data: structuredClone(rows[0]), error: null };
    }
    if (this.one === 'maybe') {
      if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows returned' } };
      return { data: rows[0] ? structuredClone(rows[0]) : null, error: null };
    }
    return { data: structuredClone(rows), error: null };
  }

  private run(): QueryResult {
    const injected = this.fake.takeFailure(this.table, this.op);
    if (injected) return { data: null, error: injected };
    const table = (this.fake.tables[this.table] ??= []);

    if (this.op === 'select') {
      let rows = this.matching();
      for (const { column, ascending } of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const x = String(a[column] ?? '');
          const y = String(b[column] ?? '');
          const order = x < y ? -1 : x > y ? 1 : 0;
          return ascending ? order : -order;
        });
      }
      const total = rows.length;
      if (this.window) rows = rows.slice(this.window[0], this.window[1] + 1);
      if (this.max !== null) rows = rows.slice(0, this.max);
      if (this.head) return { data: null, error: null, count: total };
      return { ...this.shape(rows), ...(this.wantCount ? { count: total } : {}) };
    }

    if (this.op === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const created = incoming.map((row) => ({
        id: `${this.table}-${++this.fake.sequence}`,
        created_at: NOW,
        updated_at: NOW,
        ...row,
      }));
      this.fake.calls.push({ kind: 'insert', name: this.table, payload: this.payload });
      table.push(...created);
      return this.returning ? this.shape(created) : { data: null, error: null };
    }

    if (this.op === 'update') {
      const rows = this.matching();
      this.fake.calls.push({ kind: 'update', name: this.table, payload: this.payload });
      for (const row of rows) Object.assign(row, this.payload);
      return this.returning ? this.shape(rows) : { data: null, error: null };
    }

    const rows = this.matching();
    this.fake.calls.push({ kind: 'delete', name: this.table, payload: null });
    this.fake.tables[this.table] = table.filter((row) => !rows.includes(row));
    return this.returning ? this.shape(rows) : { data: null, error: null };
  }
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  calls: Call[] = [];
  sequence = 0;
  session: Session | null = null;
  private rpcs = new Map<string, RpcHandler>();
  private functionHandlers = new Map<string, FunctionHandler>();
  private failures: { table: string; op: string; error: unknown }[] = [];
  private listeners = new Set<Listener>();

  auth = {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signInWithPassword: vi.fn<(credentials: { email: string; password: string }) => Promise<AuthResult>>(),
    signUp: vi.fn<(input: { email: string; password: string; options?: unknown }) => Promise<AuthResult>>(),
    signOut: vi.fn<() => Promise<{ error: unknown }>>(),
    resetPasswordForEmail: vi.fn<(email: string, options?: unknown) => Promise<{ error: unknown }>>(),
    updateUser: vi.fn<(attributes: unknown) => Promise<{ error: unknown }>>(),
  };
  /** Contenido de los archivos del almacenamiento simulado, por ruta (lo que devuelve `download`). */
  files: Record<string, string> = {};
  storage = {
    from: () => ({
      download: async (path: string) =>
        path in this.files
          ? { data: new Blob([this.files[path]!], { type: 'text/plain' }), error: null }
          : { data: null, error: { message: 'Object not found' } },
      upload: async () => ({ data: null, error: null }),
      remove: async () => ({ data: null, error: null }),
      createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/signed' }, error: null }),
      createSignedUrls: async () => ({ data: [], error: null }),
    }),
  };

  functions = {
    invoke: async (name: string, options: { body?: unknown } = {}): Promise<{ data: unknown; error: unknown }> => {
      this.calls.push({ kind: 'function', name, payload: options.body });
      const handler = this.functionHandlers.get(name);
      if (!handler)
        return { data: null, error: new FunctionsFetchError(new Error(`Función sin simular en la prueba: ${name}`)) };
      let reply: FunctionReply;
      try {
        reply = await handler(options.body);
      } catch (error) {
        return { data: null, error: new FunctionsFetchError(error) };
      }
      if (reply.status >= 200 && reply.status < 300) return { data: structuredClone(reply.body), error: null };
      const response = new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
      return { data: null, error: new FunctionsHttpError(response) };
    },
  };

  /** Lo que importa `@/lib/supabase` como `supabase`. */
  client = {
    auth: this.auth,
    storage: this.storage,
    functions: this.functions,
    from: (table: string) => new Query(this, table),
    rpc: async (name: string, args: Record<string, unknown> = {}): Promise<QueryResult> => {
      this.calls.push({ kind: 'rpc', name, payload: args });
      const injected = this.takeFailure(name, 'rpc');
      if (injected) return { data: null, error: injected };
      const handler = this.rpcs.get(name);
      if (!handler) return { data: null, error: { message: `RPC sin simular en la prueba: ${name}` } };
      try {
        return { data: await handler(args), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };

  constructor() {
    this.reset();
  }

  reset() {
    this.tables = {};
    this.files = {};
    this.calls = [];
    this.sequence = 0;
    this.session = null;
    this.rpcs = new Map();
    this.functionHandlers = new Map();
    // Plataforma → Integraciones: por defecto, el servidor dice que todo está
    // configurado; lo que se enseña lo deciden los interruptores VITE_* de cada
    // prueba. Una prueba puede sustituirlo con `fake.fn('platform-integrations', …)`.
    this.functionHandlers.set('platform-integrations', (body) =>
      (body as { action?: string } | undefined)?.action === 'availability'
        ? { status: 200, body: { ...ALL_AVAILABLE } }
        : { status: 404, body: { error: { message: 'Sin simular en la prueba' } } },
    );
    this.failures = [];
    this.listeners = new Set();
    this.auth.getSession.mockReset().mockImplementation(async () => ({ data: { session: this.session }, error: null }));
    this.auth.onAuthStateChange.mockReset().mockImplementation((listener: Listener) => {
      this.listeners.add(listener);
      return { data: { subscription: { unsubscribe: () => this.listeners.delete(listener) } } };
    });
    this.auth.signInWithPassword.mockReset().mockImplementation(async ({ email }) => {
      const user = makeUser({ email });
      this.signIn(user);
      return { data: { user, session: this.session }, error: null };
    });
    this.auth.signUp.mockReset().mockImplementation(async ({ email }) => {
      const user = makeUser({ email });
      this.signIn(user);
      return { data: { user, session: this.session }, error: null };
    });
    this.auth.signOut.mockReset().mockImplementation(async () => {
      this.session = null;
      this.emit('SIGNED_OUT');
      return { error: null };
    });
    this.auth.resetPasswordForEmail.mockReset().mockResolvedValue({ error: null });
    this.auth.updateUser.mockReset().mockResolvedValue({ error: null });
  }

  private emit(event: string) {
    for (const listener of this.listeners) listener(event, this.session);
  }

  /** Abre sesión con este usuario (como si ya hubiera entrado antes o acabara de hacerlo). */
  signIn(user: User): Session {
    this.session = makeSession(user);
    this.emit('SIGNED_IN');
    return this.session;
  }

  rpc(name: string, handler: RpcHandler) {
    this.rpcs.set(name, handler);
  }

  /** Registra la respuesta de una Edge Function. */
  fn(name: string, handler: FunctionHandler) {
    this.functionHandlers.set(name, handler);
  }

  /** Hace fallar la próxima operación `op` sobre `table` (o, con `rpc`, la RPC de ese nombre). */
  failNext(table: string, op: Op | 'rpc', error: unknown) {
    this.failures.push({ table, op, error });
  }

  takeFailure(table: string, op: string): unknown {
    const index = this.failures.findIndex((f) => f.table === table && f.op === op);
    if (index < 0) return null;
    return this.failures.splice(index, 1)[0]!.error;
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  callsTo(name: string, kind?: Call['kind']): Call[] {
    return this.calls.filter((c) => c.name === name && (kind === undefined || c.kind === kind));
  }
}

export const fake = new FakeSupabase();
