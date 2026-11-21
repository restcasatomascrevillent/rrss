// Enlaces a los sitios donde se arreglan los avisos de publicación.

/** Ancla de la tarjeta «Cuentas conectadas» dentro de Marca → Datos de la marca. */
export const CONNECTED_ACCOUNTS_ANCHOR = 'cuentas-conectadas';

/** Marca → Datos de la marca, bajando hasta «Cuentas conectadas». */
export function connectedAccountsPath(orgId: string, brandId: string): string {
  return `/o/${orgId}/m/${brandId}/marca?seccion=datos#${CONNECTED_ACCOUNTS_ANCHOR}`;
}

/** Parámetro con el que el editor abre directamente el diálogo de exportar. */
export const EXPORT_PARAM = 'exportar';

/** El editor de la pieza con el diálogo de exportar ya abierto. */
export function exportPath(orgId: string, brandId: string, contentId: string): string {
  return `/o/${orgId}/m/${brandId}/contenidos/${contentId}?${EXPORT_PARAM}=1`;
}
