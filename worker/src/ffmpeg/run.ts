// Lanzar FFmpeg y ffprobe como binarios externos (no se enlaza ninguna
// biblioteca suya). Sin shell: los argumentos van tal cual, sin comillas.
import { spawn } from 'node:child_process';

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

export function toolsFromEnv(env: NodeJS.ProcessEnv = process.env): MediaTools {
  return { ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ffprobe: env.FFPROBE_PATH || 'ffprobe' };
}

export class ProcessError extends Error {
  override name = 'ProcessError';
}

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
}

const STDERR_TAIL = 2_000;

/** Ejecuta un programa y devuelve su salida estándar. Al abortar, lo mata. */
export function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const { cwd, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new ProcessError(`No se pudo ejecutar «${command}»: ${error.message}`));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason);
      if (code !== 0) {
        return reject(new ProcessError(`«${command}» terminó con código ${code}: ${stderr.trim() || 'sin detalle'}`));
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

/** FFmpeg sin cabecera, sin leer del teclado y sobrescribiendo la salida. */
export function runFfmpeg(tools: MediaTools, args: string[], options: RunOptions = {}): Promise<string> {
  return runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], options);
}

/** Número con punto decimal y sin notación exponencial, como lo espera FFmpeg. */
export function num(value: number, decimals = 4): string {
  return Number(value.toFixed(decimals)).toString();
}
