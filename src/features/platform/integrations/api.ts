import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegrationAuditRow, IntegrationSettingRow, IntegrationTestRow } from '@/lib/database.types';
import { supabase } from '@/lib/supabase';
import type { IntegrationId } from './catalog';

// Plataforma → Integraciones. Todo pasa por la función `platform-integrations`
// (supabase/functions/platform-integrations/handler.ts): el navegador manda los
// valores al guardar y nunca recibe un secreto de vuelta.

/** Qué está configurado y listo en el servidor (solo booleanos). */
export interface IntegrationAvailability {
  publishing: boolean;
  socialOAuth: boolean;
  socialToken: boolean;
  aiText: boolean;
  aiImage: boolean;
  billing: boolean;
  /** Biblioteca con Google Drive (cliente OAuth y claves de cifrado). */
  drive: boolean;
  /** Archivos de la biblioteca en Cloudflare R2 (docs/almacenamiento-r2.md). */
  mediaStorage: boolean;
  /** Subtítulos automáticos de los reels con OpenAI (docs/editor-reels.md). */
  reelSubtitles: boolean;
}

export interface IntegrationStatus {
  settings: IntegrationSettingRow[];
  tests: IntegrationTestRow[];
  audit: IntegrationAuditRow[];
  /** Ajustes que vienen de variables de entorno de las funciones (sin valor). */
  environment: string[];
  availability: IntegrationAvailability;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  checks: Array<{ name: string; ok: boolean | null; message: string }>;
}

export const integrationKeys = {
  availability: ['platform', 'integrations', 'availability'] as const,
  status: ['platform', 'integrations', 'status'] as const,
};

const FAILED = 'No se ha podido hablar con el servidor. Inténtalo de nuevo en un momento.';

export async function callIntegrations<T>(body: Record<string, unknown>): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.functions.invoke('platform-integrations', { body });
  } catch {
    throw new Error(FAILED);
  }
  if (result.error) {
    const context = (result.error as { context?: unknown }).context;
    if (context instanceof Response) {
      const payload = (await context
        .clone()
        .json()
        .catch(() => null)) as { error?: { message?: unknown } } | null;
      const message = payload?.error?.message;
      if (typeof message === 'string' && message) throw new Error(message);
    }
    throw new Error(FAILED);
  }
  return result.data as T;
}

/**
 * Disponibilidad de las integraciones. Se pregunta una vez y se guarda unos
 * minutos; si el servidor no contesta, nada está disponible (lo que no
 * funciona no sale).
 */
export function useIntegrationAvailability(enabled = true) {
  return useQuery({
    queryKey: integrationKeys.availability,
    queryFn: () => callIntegrations<IntegrationAvailability>({ action: 'availability' }),
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useIntegrationStatus() {
  return useQuery({
    queryKey: integrationKeys.status,
    queryFn: () => callIntegrations<IntegrationStatus>({ action: 'status' }),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: integrationKeys.status });
    void qc.invalidateQueries({ queryKey: integrationKeys.availability });
  };
}

/** Guarda o borra (`null`) ajustes de una integración. */
export function useSaveIntegration() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { integration: IntegrationId; values: Record<string, string | null> }) =>
      callIntegrations<{ saved: string[] }>({ action: 'save', ...input }),
    onSuccess: invalidate,
  });
}

export function useTestIntegration() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (integration: IntegrationId) => callIntegrations<ProbeResult>({ action: 'test', integration }),
    onSettled: invalidate,
  });
}

/**
 * Genera el token del trabajador para `worker-gateway` (sustituye al anterior,
 * que deja de valer). El token solo viaja en esta respuesta: no se guarda.
 */
export function useGenerateWorkerToken() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => callIntegrations<{ token: string }>({ action: 'generate_worker_token' }),
    onSuccess: invalidate,
  });
}

export function useGenerateTokenKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => callIntegrations<{ keyId: string }>({ action: 'generate_token_key' }),
    onSuccess: invalidate,
  });
}
