// Registro en líneas JSON (una por suceso), que cualquier alojamiento recoge
// de la salida estándar.

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createJsonLogger(base: LogFields = {}, write: (line: string) => void = defaultWrite): Logger {
  const emit = (level: string, event: string, fields: LogFields = {}) =>
    write(JSON.stringify({ time: new Date().toISOString(), level, event, ...base, ...fields }));
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Registro que guarda los sucesos en memoria: para pruebas. */
export function createMemoryLogger(): Logger & { entries: Array<{ level: string; event: string } & LogFields> } {
  const entries: Array<{ level: string; event: string } & LogFields> = [];
  const push =
    (level: string) =>
    (event: string, fields: LogFields = {}) => {
      entries.push({ level, event, ...fields });
    };
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}
