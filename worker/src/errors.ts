// Errores que el bucle distingue para decidir cómo cerrar un trabajo.
// Sin dependencias: lo importan también las pruebas de base de datos de la raíz.

/** Fallo sin remedio (entrada inválida, archivo ilegible): no se reintenta. */
export class PermanentError extends Error {
  override name = 'PermanentError';
}

/** La reserva ya no es nuestra: el trabajo se canceló o lo reclamó otro. */
export class LeaseLostError extends Error {
  override name = 'LeaseLostError';
}

/** El trabajador se está apagando y devuelve el trabajo a la cola. */
export class ShutdownError extends Error {
  override name = 'ShutdownError';
}

/** El manejador no terminó dentro del tiempo reservado. */
export class LeaseTimeoutError extends Error {
  override name = 'LeaseTimeoutError';
}

/** Tipo de trabajo previsto pero aún sin implementar. No se simula nada. */
export class NotImplementedError extends PermanentError {
  override name = 'NotImplementedError';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
