import { NETWORKS, getFormatSpec } from './networks';

/** «Instagram», o el identificador tal cual si la red ya no está en el catálogo. */
export function networkLabel(network: string): string {
  return NETWORKS.find((n) => n.id === network)?.label ?? network;
}

/** «Instagram · Publicación». */
export function targetLabel(network: string, format: string): string {
  return `${networkLabel(network)} · ${getFormatSpec(network, format)?.label ?? format}`;
}

/** Rutas de la sección dentro de una marca. */
export function contentPaths(orgId: string, brandId: string) {
  const base = `/o/${orgId}/m/${brandId}/contenidos`;
  return { list: base, item: (contentId: string) => `${base}/${contentId}` };
}
