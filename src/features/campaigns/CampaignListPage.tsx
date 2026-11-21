import { CalendarDays, Megaphone, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Skeleton, Spinner } from '@/components/ui';
import { useSources } from '@/features/brand/api';
import { networkLabel } from '@/features/content/labels';
import { useBrand, useOrg } from '@/features/orgs/context';
import type { CampaignRow } from '@/lib/database.types';
import { useCampaigns, useCampaignsOverview } from './api';
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_STATUS_TONE, campaignPaths, campaignsAvailable } from './labels';
import { NewCampaignDialog } from './NewCampaignDialog';
import { shortDay } from './plan';
import { PiecePreview } from './PiecePreview';
import { usePiecePreviews, type PreviewRequest } from './previews';
import { useFeatureStatus } from '@/features/platform/integrations/useFeature';

/** Campañas de la marca: pedir un plan y ver en qué punto está cada uno. */
export function CampaignListPage() {
  const { org } = useOrg();
  const { brand } = useBrand();
  const aiText = useFeatureStatus('aiText');
  // Con la marca en modo agencia no hace falta esperar al servidor.
  if (aiText === undefined && brand.ai_mode !== 'agency') return <Spinner />;
  const available = campaignsAvailable(brand, aiText === true);
  if (!available) return <Navigate to={`/o/${org.id}/m/${brand.id}/inicio`} replace />;
  return <CampaignList />;
}

function CampaignList() {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const mode = brand.ai_mode === 'agency' ? 'agency' : 'ai';
  // Con la IA hace falta poder crear contenido; a la agencia lo pide quien puede comentar (como un encargo).
  const canAsk = mode === 'ai' ? can('edit') : can('comment');
  const campaigns = useCampaigns(brand.id);
  const sources = useSources(brand.id);
  const textSources = (sources.data ?? []).filter((s) => s.kind === 'text' && s.storage_path !== null).length;
  const [creating, setCreating] = useState(false);
  const rows = campaigns.data ?? [];

  const newButton = canAsk && (
    <Button onClick={() => setCreating(true)} data-testid="campaign-new">
      <Plus className="h-4 w-4" aria-hidden />
      {mode === 'ai' ? 'Preparar un plan' : 'Pedir un plan'}
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Campañas"
        description={
          mode === 'ai'
            ? 'La IA propone el plan; al aceptarlo, sus piezas se crean como borradores.'
            : 'La agencia prepara el plan; al aceptarlo, sus piezas se crean como borradores.'
        }
        action={newButton}
      />

      {campaigns.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : campaigns.isError ? (
        <Card>
          <ErrorState error={campaigns.error} onRetry={() => void campaigns.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Megaphone}
            title="Todavía no hay campañas"
            description={
              canAsk
                ? `Pide un plan con «${mode === 'ai' ? 'Preparar un plan' : 'Pedir un plan'}» y tus palabras («prepara la semana que viene»), y revísalo antes de crear nada.`
                : 'Cuando alguien pida un plan, aparecerá aquí.'
            }
          />
        </Card>
      ) : (
        <CampaignCards campaigns={rows} />
      )}

      {canAsk && (
        <NewCampaignDialog
          orgId={org.id}
          brandId={brand.id}
          mode={mode}
          open={creating}
          onOpenChange={setCreating}
          textSourceCount={textSources}
        />
      )}
    </>
  );
}

/** Miniaturas que se enseñan por campaña en la lista. */
const THUMBS_PER_CAMPAIGN = 5;

function CampaignCards({ campaigns }: { campaigns: CampaignRow[] }) {
  const { org } = useOrg();
  const { brand } = useBrand();
  const paths = campaignPaths(org.id, brand.id);
  const overview = useCampaignsOverview(brand.id, campaigns);

  // Lo que se enseña en pequeño: las piezas creadas (aceptadas) o las del plan.
  const thumbs = useMemo(() => {
    const byCampaign = new Map<string, { request: PreviewRequest; format: string }[]>();
    for (const campaign of campaigns) {
      const plan = overview.data?.plans.get(campaign.id) ?? null;
      const links = overview.data?.contents.get(campaign.id);
      const items = links
        ? links.map((link) => {
            const piece = plan?.pieces[link.piece_index];
            return {
              request: {
                key: `${campaign.id}:${link.content_id}`,
                contentId: link.content_id,
                version: link.current_version,
                ...(piece?.assetIds[0] ? { assetId: piece.assetIds[0] } : {}),
              },
              format: piece?.format ?? '',
            };
          })
        : (plan?.pieces ?? []).map((piece, index) => ({
            request: {
              key: `${campaign.id}:${index}`,
              ...(piece.assetIds[0] ? { assetId: piece.assetIds[0] } : {}),
            },
            format: piece.format,
          }));
      byCampaign.set(campaign.id, items.slice(0, THUMBS_PER_CAMPAIGN));
    }
    return byCampaign;
  }, [campaigns, overview.data]);
  const requests = useMemo(() => [...thumbs.values()].flat().map((t) => t.request), [thumbs]);
  const previews = usePiecePreviews(brand.id, requests);

  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="campaign-list">
      {campaigns.map((campaign) => {
        const plan = overview.data?.plans.get(campaign.id);
        const total = overview.data?.contents.get(campaign.id)?.length ?? plan?.pieces.length;
        const items = thumbs.get(campaign.id) ?? [];
        return (
          <li key={campaign.id}>
            <Link
              to={paths.item(campaign.id)}
              className="flex h-full flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-card transition-colors hover:border-muted"
              data-testid="campaign-row"
            >
              <span className="flex items-start justify-between gap-3">
                <span className="line-clamp-2 min-w-0 text-base font-semibold">{campaign.title}</span>
                <Badge tone={CAMPAIGN_STATUS_TONE[campaign.status]} className="shrink-0">
                  {CAMPAIGN_STATUS_LABEL[campaign.status]}
                </Badge>
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="h-4 w-4" aria-hidden />
                  {shortDay(campaign.starts_on)} – {shortDay(campaign.ends_on)}
                </span>
                <span>{campaign.networks.map(networkLabel).join(', ')}</span>
              </span>
              <span className="mt-auto flex items-center gap-1.5" data-testid="campaign-row-thumbs">
                {items.map((item) => (
                  <span
                    key={item.request.key}
                    className="block aspect-[4/5] w-10 overflow-hidden rounded-md border border-border"
                  >
                    <PiecePreview source={previews.get(item.request.key)} format={item.format} size={48} />
                  </span>
                ))}
                {total !== undefined && total > items.length && (
                  <span className="text-xs text-muted">+{total - items.length}</span>
                )}
                <span className="ml-auto text-xs text-muted" data-testid="campaign-row-count">
                  {campaign.current_plan_version === 0
                    ? 'Sin plan todavía'
                    : total === undefined
                      ? ''
                      : `${total} ${total === 1 ? 'pieza' : 'piezas'}`}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
