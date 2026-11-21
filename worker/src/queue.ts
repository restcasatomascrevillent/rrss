// Contrato de la cola, tal como lo necesita el trabajador. Es el mismo de
// `supabase/migrations/20261116111000_jobs.sql` (reclamar, terminar, fallar) y
// `20261117150000_jobs_release_extend.sql` (devolver, renovar), sin nada de
// Supabase: la conexión se inyecta.

export type JsonObject = Record<string, unknown>;

export interface Job {
  id: string;
  organization_id: string;
  brand_id: string | null;
  kind: string;
  payload: JsonObject;
  attempts: number;
  max_attempts: number;
}

export interface ClaimOptions {
  worker: string;
  kinds: string[];
  limit: number;
  leaseSeconds: number;
}

export interface JobQueue {
  /** Reserva hasta `limit` trabajos de los tipos dados durante `leaseSeconds`. */
  claim(options: ClaimOptions): Promise<Job[]>;
  /** Cierra como terminado. Lanza `LeaseLostError` si la reserva ya no es nuestra. */
  complete(jobId: string, worker: string, result: JsonObject): Promise<void>;
  /**
   * Anota un fallo. Con `retry` vuelve a la cola (con espera creciente) si
   * quedan intentos. Lanza `LeaseLostError` si la reserva ya no es nuestra.
   */
  fail(jobId: string, worker: string, error: string, retry: boolean): Promise<void>;
  /**
   * Devuelve a la cola un trabajo a medias sin gastar intento (apagado
   * ordenado). Lanza `LeaseLostError` si la reserva ya no es nuestra.
   */
  release(jobId: string, worker: string): Promise<void>;
  /**
   * Renueva la reserva: caduca dentro de `leaseSeconds` desde ahora. Lanza
   * `LeaseLostError` si la reserva ya no es nuestra.
   */
  extendLease(jobId: string, worker: string, leaseSeconds: number): Promise<void>;
}
