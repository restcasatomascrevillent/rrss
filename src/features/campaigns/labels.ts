import type { BrandRow, CampaignStatus } from '@/lib/database.types';

// Estados de una campaña, rutas de la sección y cuándo se enseña. Espejo de la
// migración 20261119510000: aquí solo se decide qué enseñar; manda la base de datos.

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  requested: 'Pedido a la agencia',
  proposed: 'Plan por revisar',
  accepted: 'Aceptado',
  discarded: 'Descartado',
};

export const CAMPAIGN_STATUS_TONE: Record<CampaignStatus, 'neutral' | 'primary' | 'warning' | 'success' | 'danger'> = {
  requested: 'primary',
  proposed: 'warning',
  accepted: 'success',
  discarded: 'neutral',
};

/**
 * ¿Hay forma de preparar un plan en esta marca? Con la IA de texto conectada
 * (VITE_AI_TEXT_ENABLED) o con la marca en modo agencia. Si no, la sección no
 * sale (lo que no funciona no se enseña).
 */
export function campaignsAvailable(brand: Pick<BrandRow, 'ai_mode'>, aiText: boolean): boolean {
  return brand.ai_mode === 'agency' || aiText;
}

export function campaignPaths(orgId: string, brandId: string) {
  const base = `/o/${orgId}/m/${brandId}/campanas`;
  return { list: base, item: (campaignId: string) => `${base}/${campaignId}` };
}
