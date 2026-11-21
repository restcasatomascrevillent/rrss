import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SocialImportRunRow } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { socialKeys } from './api';

// Importar las publicaciones que una cuenta ya tiene (docs/importar-publicaciones.md).
// El navegador solo pide pasos a `social-import`; el token de la cuenta no sale
// nunca del servidor. Cada paso guarda lo que avanza, así que se puede detener
// o cerrar la pestaña y reanudar después sin perder ni repetir nada.

export interface ImportProgress {
  id: string;
  status: 'running' | 'paused' | 'completed';
  phase: 'listing' | 'copying' | 'done';
  copyImages: boolean;
  pages: number;
  itemsSeen: number;
  itemsNew: number;
  copied: number;
  copyFailed: number;
  retryAfter: string | null;
  lastError: string | null;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Resumen de una importación en palabras. */
export function importSummary(
  p: Pick<ImportProgress, 'itemsSeen' | 'itemsNew' | 'copied' | 'copyFailed' | 'copyImages'>,
) {
  const parts = [`${plural(p.itemsSeen, 'publicación leída', 'publicaciones leídas')} (${p.itemsNew} nuevas)`];
  if (p.copyImages) {
    parts.push(plural(p.copied, 'publicación copiada a la biblioteca', 'publicaciones copiadas a la biblioteca'));
    if (p.copyFailed > 0) parts.push(`${p.copyFailed} sin copiar`);
  }
  return parts.join(' · ');
}

export type StepOutcome = 'progress' | 'completed' | 'waiting' | 'paused' | 'busy' | 'error';

interface StepResponse {
  outcome: StepOutcome;
  run: ImportProgress | null;
  message: string | null;
  retryAfterSeconds: number | null;
}

export const importKeys = {
  lastRun: (brandId: string, accountId: string) => [...socialKeys.accounts(brandId), 'import', accountId] as const,
  total: (brandId: string) => ['brand', brandId, 'social', 'imported-total'] as const,
};

async function invoke<T>(route: 'start' | 'step' | 'pause', body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(`social-import/${route}`, { body });
  if (error) {
    let message = 'No se pudo importar. Inténtalo de nuevo.';
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === 'function') {
      const parsed = (await context.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (parsed?.error?.message) message = parsed.error.message;
    }
    throw new Error(message);
  }
  return data as T;
}

/** La última importación de la cuenta (la que se puede reanudar, o la terminada). */
export function useLastImport(brandId: string, accountId: string | null) {
  return useQuery({
    queryKey: importKeys.lastRun(brandId, accountId ?? ''),
    enabled: Boolean(accountId),
    queryFn: async (): Promise<SocialImportRunRow | null> => {
      const rows = unwrap(
        await supabase
          .from('social_import_runs')
          .select('*')
          .eq('social_account_id', accountId!)
          .order('started_at', { ascending: false })
          .limit(1),
      );
      return rows[0] ?? null;
    },
  });
}

/** Cuántas publicaciones importadas tiene la marca. */
export function useImportedTotal(brandId: string) {
  return useQuery({
    queryKey: importKeys.total(brandId),
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from('social_imported_media')
        .select('id', { count: 'exact', head: true })
        .eq('brand_id', brandId);
      if (error) throw error;
      return count ?? 0;
    },
  });
}

const STEP_PAUSE_MS = 400;

/**
 * Lleva la importación: empieza (o reanuda) y pide pasos mientras haya trabajo.
 * `stop` detiene la importación en el servidor; nada de lo importado se pierde.
 */
export function useImportDriver(brandId: string, accountId: string | null) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const runId = useRef<string | null>(null);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const refresh = useCallback(() => {
    if (!accountId) return;
    void qc.invalidateQueries({ queryKey: importKeys.lastRun(brandId, accountId) });
    void qc.invalidateQueries({ queryKey: importKeys.total(brandId) });
    void qc.invalidateQueries({ queryKey: ['brand', brandId, 'assets'] });
  }, [accountId, brandId, qc]);

  const start = useCallback(
    async (copyImages: boolean) => {
      if (!accountId || active) return;
      cancelled.current = false;
      setActive(true);
      setError(null);
      setMessage(null);
      try {
        const started = await invoke<{ run: ImportProgress }>('start', { accountId, copyImages });
        runId.current = started.run.id;
        setProgress(started.run);
        for (;;) {
          if (cancelled.current) break;
          const step = await invoke<StepResponse>('step', { runId: started.run.id });
          if (step.run) setProgress(step.run);
          refresh();
          if (step.outcome === 'progress' || step.outcome === 'busy') {
            await new Promise((resolve) => setTimeout(resolve, STEP_PAUSE_MS));
            continue;
          }
          if (step.outcome === 'waiting') {
            setMessage(
              step.message ?? 'Meta pide ir más despacio. Se puede reanudar más tarde sin perder lo importado.',
            );
          } else if (step.outcome === 'error') {
            setError(step.message ?? step.run?.lastError ?? 'La importación se detuvo.');
          }
          break;
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo importar.');
      } finally {
        setActive(false);
        refresh();
      }
    },
    [accountId, active, refresh],
  );

  const stop = useCallback(async () => {
    cancelled.current = true;
    const id = runId.current;
    if (!id) return;
    try {
      const paused = await invoke<{ run: ImportProgress }>('pause', { runId: id });
      setProgress(paused.run);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo detener.');
    } finally {
      refresh();
    }
  }, [refresh]);

  return { progress, active, message, error, start, stop };
}
