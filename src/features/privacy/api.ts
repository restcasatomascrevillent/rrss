import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LEGAL_VERSIONS } from '@/features/legal/legal';
import { signStoragePaths } from '@/features/storage/api';
import type { AccountDeletionCheck, LegalAcceptanceRow } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { removeLocal } from '@/lib/localStore';
import { supabase } from '@/lib/supabase';
import { downloadText } from '@/lib/utils';

// Derechos del RGPD desde la aplicación: aceptar los documentos legales,
// descargar los datos propios, exportar una organización y borrar (cuenta u
// organización). Leer y exportar van con la sesión de la persona (RLS);
// borrar pasa por las Edge Functions `delete-account` y `delete-organization`.

export const privacyKeys = {
  acceptances: (userId: string) => ['legal-acceptances', userId] as const,
  deletionCheck: (userId: string) => ['account-deletion-check', userId] as const,
};

/** Duración de los enlaces firmados de la exportación de una organización (1 hora). */
export const EXPORT_LINK_SECONDS = 3600;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function fileSafe(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'organizacion'
  );
}

export function useLegalAcceptances(userId: string) {
  return useQuery({
    queryKey: privacyKeys.acceptances(userId),
    queryFn: async (): Promise<LegalAcceptanceRow[]> =>
      unwrap(
        await supabase
          .from('legal_acceptances')
          .select('*')
          .eq('user_id', userId)
          .order('accepted_at', { ascending: false }),
      ),
  });
}

/** ¿Aceptó ya las versiones vigentes de las condiciones y de la política de privacidad? */
export function acceptedCurrent(rows: LegalAcceptanceRow[]): boolean {
  return (['terms', 'privacy'] as const).every((doc) =>
    rows.some((r) => r.document === doc && r.version === LEGAL_VERSIONS[doc]),
  );
}

export function useAcceptLegal(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      unwrap(
        await supabase.rpc('accept_legal_documents', {
          p_terms_version: LEGAL_VERSIONS.terms,
          p_privacy_version: LEGAL_VERSIONS.privacy,
        }),
      ),
    onSuccess: (rows) => qc.setQueryData(privacyKeys.acceptances(userId), rows),
  });
}

/** «Descargar mis datos»: un JSON con los datos personales de la sesión. */
export function useExportMyData() {
  return useMutation({
    mutationFn: async () => {
      const data = unwrap(await supabase.rpc('export_my_data'));
      downloadText(`mis-datos-${today()}.json`, JSON.stringify(data, null, 2));
      return data;
    },
  });
}

type ExportedBrand = {
  assets?: { storage_path?: unknown }[];
  knowledge_sources?: { storage_path?: unknown }[];
};

/** Rutas de los archivos de una exportación de organización. */
export function exportedPaths(data: Record<string, unknown>): string[] {
  const brands = (Array.isArray(data.brands) ? data.brands : []) as ExportedBrand[];
  const paths = brands.flatMap((b) => [
    ...(b.assets ?? []).map((a) => a.storage_path),
    ...(b.knowledge_sources ?? []).map((s) => s.storage_path),
  ]);
  return [...new Set(paths.filter((p): p is string => typeof p === 'string' && p.length > 0))];
}

/**
 * Exportar los datos de una organización (solo propietarios): el JSON de la
 * base de datos más un enlace firmado de corta duración para cada archivo.
 */
export function useExportOrganization(orgId: string, orgName: string) {
  return useMutation({
    mutationFn: async () => {
      const data = unwrap(await supabase.rpc('export_organization_data', { p_organization_id: orgId })) as Record<
        string,
        unknown
      >;
      const paths = exportedPaths(data);
      const files: { path: string; url: string | null }[] = [];
      for (let i = 0; i < paths.length; i += 500) {
        const batch = paths.slice(i, i + 500);
        // Cada archivo en su almacén (Supabase Storage o Cloudflare R2).
        const byPath = await signStoragePaths(batch, EXPORT_LINK_SECONDS);
        for (const path of batch) files.push({ path, url: byPath.get(path) ?? null });
      }

      const expires = new Date(Date.now() + EXPORT_LINK_SECONDS * 1000).toISOString();
      const result = { ...data, files: { links_expire_at: expires, items: files } };
      downloadText(`organizacion-${fileSafe(orgName)}-${today()}.json`, JSON.stringify(result, null, 2));
      return { files: files.length };
    },
  });
}

export function useAccountDeletionCheck(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: privacyKeys.deletionCheck(userId),
    enabled,
    staleTime: 0,
    queryFn: async (): Promise<AccountDeletionCheck> => unwrap(await supabase.rpc('my_account_deletion_check')),
  });
}

/** Error de una función de supresión, con el mensaje del servidor (ya en español). */
export class DeletionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly blocking: AccountDeletionCheck['blocking'] = [],
  ) {
    super(message);
    // `Error` a secas: translateError() muestra entonces el mensaje tal cual.
    this.name = 'Error';
  }
}

const NETWORK_MESSAGE = 'No se ha podido conectar con el servidor. Comprueba la conexión y vuelve a intentarlo.';

type DeletionPayload = { error?: { code?: string; message?: string; blocking?: AccountDeletionCheck['blocking'] } };

async function invokeDeletion<T>(name: 'delete-account' | 'delete-organization', body: Record<string, unknown>) {
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.functions.invoke(name, { body });
  } catch {
    throw new DeletionError('network', NETWORK_MESSAGE);
  }
  if (!result.error) return result.data as T;
  const context = (result.error as { context?: unknown }).context;
  if (context instanceof Response) {
    let payload: DeletionPayload = {};
    try {
      payload = (await context.clone().json()) as DeletionPayload;
    } catch {
      /* sin cuerpo */
    }
    throw new DeletionError(
      payload.error?.code ?? 'internal',
      payload.error?.message ?? 'No se ha podido completar el borrado. Inténtalo de nuevo.',
      payload.error?.blocking ?? [],
    );
  }
  throw new DeletionError('network', NETWORK_MESSAGE);
}

/** Lo que la aplicación deja en el navegador de esta persona (ver la política de cookies). */
function forgetLocalData(userId: string): void {
  removeLocal(`rrss.last.${userId}`);
  removeLocal('rrss.pendingInvite');
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('rrss.brandDraft.')) window.localStorage.removeItem(key);
    }
  } catch {
    /* sin almacenamiento */
  }
}

export type DeletedAccount = { deleted: true; deletedOrganizations: { id: string; name: string }[] };

export function useDeleteAccount(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { confirmation: string; password: string }) => {
      const result = await invokeDeletion<DeletedAccount>('delete-account', input);
      forgetLocalData(userId);
      // La cuenta ya no existe: se cierra la sesión de este navegador.
      await supabase.auth.signOut({ scope: 'local' });
      qc.clear();
      return result;
    },
  });
}

export function useDeleteOrganization(orgId: string, userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (confirmation: string) => {
      const result = await invokeDeletion<{ deleted: true; filesPending: number }>('delete-organization', {
        organizationId: orgId,
        confirmation,
      });
      removeLocal(`rrss.last.${userId}`);
      qc.removeQueries({ queryKey: ['org', orgId] });
      await qc.invalidateQueries({ queryKey: ['orgs', userId] });
      return result;
    },
  });
}
