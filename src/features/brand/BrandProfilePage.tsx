import { Archive, ArchiveRestore, Download, History } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  Input,
  PageHeader,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { assetKeys, deleteAssets } from '@/features/library/api';
import { useBrand, useOrg } from '@/features/orgs/context';
import type { BrandProfileRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { downloadText } from '@/lib/utils';
import { useActiveProfile, useSaveProfile, useUpdateBrand } from './api';
import { BasicsFields } from './BasicsFields';
import { AiModeCard } from '@/features/requests/AiModeCard';
import { ConnectedAccountsCard } from '@/features/social/ConnectedAccountsCard';
import { profileCompleteness } from './completeness';
import { brandBasicsSchema, configFileName, exportBrandConfig, type BrandBasics } from './config';
import {
  AudienceSection,
  BusinessSection,
  ChannelsSection,
  ContextSection,
  PublishingRulesSection,
  VisualSection,
  VoiceSection,
  type SectionProps,
} from './editor/sections';
import { HistoryDialog } from './HistoryDialog';
import { LogoManager } from './LogoManager';
import { logosToDiscard, settleSaved } from './logos';
import {
  emptyProfile,
  nextProvenance,
  normalizeProfile,
  parseProfile,
  parseProvenance,
  type BrandProfileData,
  type ProfileSectionKey,
  type ProvenanceSource,
} from './profile';
import { ProfileProposalFromSources } from './ProfileProposalFromSources';
import { BrandFontsCard } from './BrandFontsCard';
import { SourcesCard } from './SourcesCard';
import { useFeature } from '@/features/platform/integrations/useFeature';

const TABS = [
  { value: 'negocio', label: 'Negocio' },
  { value: 'publico', label: 'Público y objetivos' },
  { value: 'voz', label: 'Voz' },
  { value: 'visual', label: 'Identidad visual' },
  { value: 'canales', label: 'Canales e idiomas' },
  { value: 'contexto', label: 'Contexto' },
  { value: 'fuentes', label: 'Fuentes' },
  { value: 'datos', label: 'Datos de la marca' },
] as const;
type TabValue = (typeof TABS)[number]['value'];

/** Sección del perfil (o nombre de pestaña) → pestaña. Lo usan los enlaces «siguientes pasos». */
const SECTION_TAB: Record<ProfileSectionKey | 'fuentes' | 'datos', TabValue> = {
  business: 'negocio',
  audience: 'publico',
  goals: 'publico',
  voice: 'voz',
  visual: 'visual',
  channels: 'canales',
  languages: 'canales',
  competitors: 'contexto',
  references: 'contexto',
  restrictions: 'contexto',
  fuentes: 'fuentes',
  datos: 'datos',
};

function BrandDataTab() {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const canManage = can('manage');
  const update = useUpdateBrand(org.id, brand.id);
  const initial: BrandBasics = useMemo(
    () => ({
      name: brand.name,
      sector: brand.sector,
      website: brand.website,
      timezone: brand.timezone,
      default_locale: brand.default_locale,
    }),
    [brand],
  );
  const [basics, setBasics] = useState(initial);
  const [archiving, setArchiving] = useState(false);
  const dirty = JSON.stringify(basics) !== JSON.stringify(initial);
  const archived = brand.status === 'archived';

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = brandBasicsSchema.safeParse(basics);
    if (!parsed.success) return toast.error(parsed.error.issues[0]?.message ?? 'Revisa los datos.');
    update.mutate(parsed.data, {
      onSuccess: () => toast.success('Datos guardados'),
      onError: (e) => toast.error(translateError(e)),
    });
  }

  function toggleArchive() {
    update.mutate(
      { status: archived ? 'active' : 'archived' },
      {
        onSuccess: () => {
          setArchiving(false);
          toast.success(archived ? 'Marca reactivada' : 'Marca archivada');
        },
        onError: (e) => {
          setArchiving(false);
          toast.error(translateError(e));
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Datos de la marca" />
        <CardBody>
          <form onSubmit={submit} className="space-y-5">
            <BasicsFields value={basics} onChange={setBasics} disabled={!canManage} />
            {canManage && (
              <Button
                type="submit"
                loading={update.isPending && !archiving}
                disabled={!dirty || !basics.name.trim()}
                data-testid="brand-data-save"
              >
                Guardar datos
              </Button>
            )}
          </form>
        </CardBody>
      </Card>
      <AiModeCard />
      <ConnectedAccountsCard />
      {canManage && (
        <Card>
          <CardHeader
            title={archived ? 'Reactivar la marca' : 'Archivar la marca'}
            description={
              archived
                ? 'Volverá a aparecer en la lista de marcas.'
                : 'Deja de aparecer en el día a día, pero no se borra nada: se puede reactivar cuando quieras.'
            }
            action={
              <Button
                variant="secondary"
                onClick={() => (archived ? toggleArchive() : setArchiving(true))}
                loading={update.isPending && archived}
                data-testid="brand-archive"
              >
                {archived ? (
                  <ArchiveRestore className="h-4 w-4" aria-hidden />
                ) : (
                  <Archive className="h-4 w-4" aria-hidden />
                )}
                {archived ? 'Reactivar' : 'Archivar'}
              </Button>
            }
          />
        </Card>
      )}
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={`¿Archivar ${brand.name}?`}
        description="La marca quedará oculta en la lista. Su perfil, su biblioteca y su equipo se conservan."
        confirmLabel="Archivar"
        destructive={false}
        loading={update.isPending}
        onConfirm={toggleArchive}
      />
    </div>
  );
}

export function BrandProfilePage() {
  const { brand } = useBrand();
  const active = useActiveProfile(brand.id);
  if (active.isPending) return <Spinner />;
  if (active.isError) return <ErrorState error={active.error} onRetry={() => void active.refetch()} />;
  // La clave reinicia el borrador cuando llega del servidor una versión distinta.
  return <ProfileEditor key={active.data?.id ?? 'none'} active={active.data} />;
}

function ProfileEditor({ active }: { active: BrandProfileRow | null }) {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const canManage = can('manage');
  const aiText = useFeature('aiText');
  const save = useSaveProfile(brand.id);
  const [params, setParams] = useSearchParams();

  const saved = useMemo(() => (active ? parseProfile(active.data) : emptyProfile()), [active]);
  const [draft, setDraft] = useState<BrandProfileData>(saved);
  const [note, setNote] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const queryClient = useQueryClient();
  // Logotipos subidos aquí y aún sin guardar, y los que van en el guardado en curso.
  const pendingLogos = useRef(new Set<string>());
  const savingLogos = useRef(new Set<string>());

  // Al salir sin guardar, los logotipos subidos que no llegaron a ninguna versión se borran de la biblioteca.
  useEffect(() => {
    const brandId = brand.id;
    const pending = pendingLogos.current;
    const saving = savingLogos.current;
    return () => {
      const orphans = logosToDiscard(pending, saving);
      if (orphans.length === 0) return;
      void deleteAssets(orphans)
        .catch(() => undefined)
        .finally(() => queryClient.invalidateQueries({ queryKey: assetKeys.all(brandId) }));
    };
  }, [brand.id, queryClient]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const completeness = useMemo(() => profileCompleteness(draft), [draft]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const requested = params.get('seccion') ?? '';
  const tab: TabValue =
    SECTION_TAB[requested as keyof typeof SECTION_TAB] ??
    (TABS.some((t) => t.value === requested) ? (requested as TabValue) : 'negocio');

  function persist(data: BrandProfileData, changeNote: string, onDone?: () => void, source: ProvenanceSource = 'user') {
    const clean = normalizeProfile(data);
    const provenance = nextProvenance(parseProvenance(active?.provenance), active ? saved : null, clean, source);
    // Las versiones guardadas (también al restaurar) enlazan estos logotipos: no se tocan al salir.
    savingLogos.current.clear();
    clean.visual.logoAssetIds.forEach((id) => savingLogos.current.add(id));
    // Con la promesa y no con los avisos de `mutate`: al guardar llega una versión nueva, el editor se
    // vuelve a montar (cambia su `key`) y los avisos de `mutate` de un componente desmontado no se ejecutan.
    save.mutateAsync({ data: clean, provenance, note: changeNote }).then(
      (row) => {
        settleSaved(pendingLogos.current, clean.visual.logoAssetIds);
        toast.success(`Perfil guardado (versión ${row.version})`);
        onDone?.();
      },
      (e: unknown) => {
        savingLogos.current.clear();
        toast.error(translateError(e));
      },
    );
  }

  function exportConfig() {
    const config = exportBrandConfig(brand, saved);
    downloadText(configFileName(brand.name), JSON.stringify(config, null, 2));
  }

  const sectionProps: SectionProps = { value: draft, onChange: setDraft, disabled: !canManage };

  return (
    <>
      <PageHeader
        title="Marca"
        description={
          active
            ? `Perfil de ${brand.name} · versión ${active.version} · ${completeness.percent}% completo`
            : `Perfil de ${brand.name} · sin guardar todavía`
        }
        action={
          <>
            <Button variant="secondary" onClick={() => setHistoryOpen(true)} data-testid="profile-history">
              <History className="h-4 w-4" aria-hidden />
              Historial
            </Button>
            <Button variant="secondary" onClick={exportConfig} data-testid="profile-export">
              <Download className="h-4 w-4" aria-hidden />
              Descargar configuración
            </Button>
          </>
        }
      />

      <Tabs value={tab} onValueChange={(value) => setParams({ seccion: value }, { replace: true })}>
        <TabsList label="Secciones del perfil de marca">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="mt-6">
          {(
            [
              ['negocio', BusinessSection],
              ['publico', AudienceSection],
              ['voz', VoiceSection],
              ['canales', ChannelsSection],
              ['contexto', ContextSection],
            ] as const
          ).map(([value, Section]) => (
            <TabsContent key={value} value={value}>
              <Card>
                <CardBody className={value === 'voz' ? 'space-y-8' : undefined}>
                  <Section {...sectionProps} />
                  {value === 'voz' && (
                    <section aria-labelledby="publishing-rules-title" className="space-y-4 border-t border-border pt-6">
                      <div>
                        <h2 id="publishing-rules-title" className="text-base">
                          Reglas de publicación
                        </h2>
                        <p className="text-sm text-muted">Las usa el verificador de marca antes de publicar.</p>
                      </div>
                      <PublishingRulesSection {...sectionProps} />
                    </section>
                  )}
                </CardBody>
              </Card>
            </TabsContent>
          ))}
          <TabsContent value="visual" className="space-y-6">
            <Card>
              <CardBody className="space-y-6">
                <LogoManager
                  organizationId={org.id}
                  brandId={brand.id}
                  ids={draft.visual.logoAssetIds}
                  onChange={(logoAssetIds) => setDraft((d) => ({ ...d, visual: { ...d.visual, logoAssetIds } }))}
                  pending={pendingLogos}
                  disabled={!canManage}
                />
                <VisualSection {...sectionProps} />
              </CardBody>
            </Card>
            <BrandFontsCard organizationId={org.id} brandId={brand.id} canManage={canManage} />
          </TabsContent>
          <TabsContent value="fuentes" className="space-y-6">
            {/* En modo agencia el servidor rechaza la IA de texto (`agency_mode`): no se ofrece. */}
            {canManage && aiText && brand.ai_mode !== 'agency' && (
              <ProfileProposalFromSources
                brandId={brand.id}
                currentProfile={active ? saved : null}
                blockedReason={dirty ? 'Guarda o descarta antes los cambios del perfil.' : undefined}
                // Lo aceptado se guarda como versión nueva; las secciones que cambian quedan como «propuestas por la IA».
                onAccept={(profile, fields) =>
                  persist(profile, `Propuesta de la IA: ${fields.length} campos aceptados`, undefined, 'ai')
                }
              />
            )}
            <SourcesCard organizationId={org.id} brandId={brand.id} canManage={canManage} />
          </TabsContent>
          <TabsContent value="datos">
            <BrandDataTab key={brand.updated_at} />
          </TabsContent>
        </div>
      </Tabs>

      {canManage && dirty && (
        <div className="sticky bottom-20 z-20 mt-6 lg:bottom-4" data-testid="profile-save-bar">
          <Card className="flex flex-col gap-3 p-3 shadow-pop sm:flex-row sm:items-center">
            <p className="text-sm font-medium sm:shrink-0">Hay cambios sin guardar</p>
            <Input
              aria-label="Nota del cambio (opcional)"
              placeholder="Nota del cambio (opcional)"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="sm:flex-1"
              data-testid="profile-note"
            />
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setDraft(saved)} disabled={save.isPending}>
                Descartar
              </Button>
              <Button onClick={() => persist(draft, note)} loading={save.isPending} data-testid="profile-save">
                Guardar versión
              </Button>
            </div>
          </Card>
        </div>
      )}

      <HistoryDialog
        brandId={brand.id}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        canRestore={canManage}
        restoring={save.isPending}
        onRestore={(version, data) => persist(data, `Restaurada la versión ${version}`, () => setHistoryOpen(false))}
      />
    </>
  );
}
