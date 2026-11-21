import type { PublicationHoldReason, SocialAccountRow } from '@/lib/database.types';

// Por qué está detenida una publicación, en una frase, y qué botón lo arregla.
// La explicación larga sigue en HOLD_REASON_TEXT (calendar.ts) y se enseña
// plegada bajo «¿Por qué?».

/** Lo que hace el botón del aviso. */
export type HoldFix =
  /** Ir a Marca → Cuentas conectadas. */
  | 'connect'
  /** Volver a guardar la publicación con la cuenta conectada que hay. */
  | 'use_account'
  /** Volver a programarla con la versión aprobada y su exportación. */
  | 'use_approved'
  /** Abrir el editor con el diálogo de exportar. */
  | 'export'
  /** Abrir la pieza en el editor (aprobarla, recuperarla…). */
  | 'open_editor'
  /** No hay nada que pulsar: solo se explica. */
  | 'none';

export interface HoldAdvice {
  /** Una frase corta, sin punto final. */
  short: string;
  fix: HoldFix;
  /** Texto del botón (vacío si `fix` es 'none'). */
  label: string;
}

type Account = Pick<SocialAccountRow, 'network' | 'status' | 'username' | 'external_id'>;

/** La cuenta activa de la red, si la hay. */
export function activeAccountOf(accounts: Account[] | undefined, network: string): Account | null {
  return accounts?.find((a) => a.network === network && a.status === 'active') ?? null;
}

export function holdAdvice(reason: PublicationHoldReason, account: Account | null): HoldAdvice {
  switch (reason) {
    case 'no_account':
      return account
        ? {
            short: 'Falta elegir la cuenta en la que se publica',
            fix: 'use_account',
            label: `Usar @${account.username || account.external_id}`,
          }
        : { short: 'Sin cuenta de Instagram conectada', fix: 'connect', label: 'Conectar cuenta' };
    case 'account_disconnected':
      return account
        ? {
            short: 'La cuenta elegida se desconectó',
            fix: 'use_account',
            label: `Usar @${account.username || account.external_id}`,
          }
        : { short: 'La cuenta de Instagram se desconectó', fix: 'connect', label: 'Conectar cuenta' };
    case 'account_needs_reauth':
      return { short: 'El acceso a la cuenta de Instagram caducó', fix: 'connect', label: 'Volver a conectar' };
    case 'content_changed':
      return {
        short: 'La pieza cambió después de programarla',
        fix: 'use_approved',
        label: 'Usar la versión aprobada',
      };
    case 'no_media':
      return { short: 'Falta la imagen exportada', fix: 'export', label: 'Exportar' };
    case 'invalid_media':
      return { short: 'La imagen elegida no vale para publicar', fix: 'export', label: 'Exportar' };
    case 'not_approved':
      return { short: 'Falta aprobar la pieza', fix: 'open_editor', label: 'Abrir la pieza' };
    case 'content_archived':
      return { short: 'La pieza está archivada', fix: 'open_editor', label: 'Abrir la pieza' };
    case 'unsupported_format':
      return { short: 'Este formato todavía no se publica solo', fix: 'none', label: '' };
  }
}

/** «1 publicación detenida» / «3 publicaciones detenidas». */
export function heldCountText(n: number): string {
  return n === 1 ? '1 publicación detenida' : `${n} publicaciones detenidas`;
}
