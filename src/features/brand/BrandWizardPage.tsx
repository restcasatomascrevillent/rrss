import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, FileJson, FileText, Globe, ImagePlus, Link2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Card, CardBody, EmptyState, Input, Notice, PageHeader } from '@/components/ui';
import { LOGO_MIME_TYPES, SOURCE_MIME_TYPES } from '@/config/app';
import { uploadAsset } from '@/features/library/api';
import { keys as orgKeys } from '@/features/orgs/api';
import { useOrg } from '@/features/orgs/context';
import { translateError } from '@/lib/errors';
import { validateFile } from '@/lib/files';
import { readLocal, removeLocal, writeLocal } from '@/lib/localStore';
import { cn, formatBytes } from '@/lib/utils';
import { addUrlSource, createBrand, normalizeUrl, saveBrandProfile, setBrandStatus, uploadSource } from './api';
import { BasicsFields } from './BasicsFields';
import { brandBasicsSchema, parseBrandConfig, type BrandBasics } from './config';
import { AudienceSection, BusinessSection, ChannelsSection, VisualSection, VoiceSection } from './editor/sections';
import {
  emptyProfile,
  nextProvenance,
  normalizeProfile,
  parseProfile,
  type BrandProfileData,
  type ProvenanceSource,
} from './profile';
import { SOURCES_NOTICE } from './sourcesNotice';

const STEPS = ['Básicos', 'Negocio', 'Público', 'Voz', 'Identidad', 'Fuentes', 'Resumen'] as const;

interface Draft {
  step: number;
  basics: BrandBasics;
  profile: BrandProfileData;
  sourceUrls: string[];
  origin: ProvenanceSource;
}

const EMPTY_BASICS: BrandBasics = {
  name: '',
  sector: '',
  website: '',
  timezone: 'Europe/Madrid',
  default_locale: 'es',
};

function newDraft(): Draft {
  return { step: 0, basics: EMPTY_BASICS, profile: emptyProfile(), sourceUrls: [], origin: 'user' };
}

/** Lee el borrador guardado sin fiarse de su forma (puede venir de una versión anterior de la app). */
function loadDraft(key: string): Draft | null {
  const raw = readLocal<Partial<Draft> | null>(key, null);
  if (!raw || typeof raw !== 'object') return null;
  const basics = brandBasicsSchema.partial().safeParse(raw.basics ?? {});
  const draft: Draft = {
    step: typeof raw.step === 'number' && raw.step >= 0 && raw.step < STEPS.length ? raw.step : 0,
    basics: { ...EMPTY_BASICS, ...(basics.success ? basics.data : {}) },
    profile: parseProfile(raw.profile),
    sourceUrls: Array.isArray(raw.sourceUrls) ? raw.sourceUrls.filter((u): u is string => typeof u === 'string') : [],
    origin: raw.origin === 'import' ? 'import' : 'user',
  };
  const untouched = JSON.stringify({ ...draft, step: 0 }) === JSON.stringify(newDraft());
  return untouched ? null : draft;
}

function FileChips({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  if (files.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2 text-sm">
          <FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="shrink-0 text-xs text-muted">{formatBytes(file.size)}</span>
          <button
            type="button"
            onClick={() => onRemove(index)}
            aria-label={`Quitar ${file.name}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-border hover:text-fg"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

const count = (n: number, one: string, many: string) => (n === 0 ? 'Sin indicar' : `${n} ${n === 1 ? one : many}`);

export function BrandWizardPage() {
  const { org, isAdmin } = useOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const draftKey = `rrss.brandDraft.${org.id}`;

  const [recovered] = useState(() => loadDraft(draftKey));
  const [draft, setDraft] = useState<Draft>(() => recovered ?? newDraft());
  const [showRecovered, setShowRecovered] = useState(recovered !== null);
  const [logoFiles, setLogoFiles] = useState<File[]>([]);
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Autoguardado del borrador (solo texto: los archivos no caben en localStorage).
  useEffect(() => {
    const timer = window.setTimeout(() => writeLocal(draftKey, draft), 400);
    return () => window.clearTimeout(timer);
  }, [draft, draftKey]);

  const { step, basics, profile } = draft;
  const setProfile = (next: BrandProfileData) => setDraft((d) => ({ ...d, profile: next }));
  const last = step === STEPS.length - 1;

  function goTo(next: number) {
    if (next > 0 && !basics.name.trim()) {
      setNameError('Escribe el nombre de la marca para continuar.');
      setDraft((d) => ({ ...d, step: 0 }));
      return;
    }
    setNameError(null);
    setDraft((d) => ({ ...d, step: Math.max(0, Math.min(STEPS.length - 1, next)) }));
    window.scrollTo({ top: 0 });
    headingRef.current?.focus();
  }

  function startOver() {
    removeLocal(draftKey);
    setDraft(newDraft());
    setLogoFiles([]);
    setSourceFiles([]);
    setShowRecovered(false);
  }

  async function importConfig(file: File) {
    const result = parseBrandConfig(await file.text());
    if (!result.ok) return setImportErrors(result.errors);
    setImportErrors([]);
    setDraft((d) => ({
      ...d,
      basics: result.config.brand,
      profile: result.config.profile,
      origin: 'import',
      step: STEPS.length - 1,
    }));
    toast.success('Configuración importada. Revísala antes de crear la marca.');
  }

  function addFiles(files: FileList, allowed: readonly string[], add: (valid: File[]) => void) {
    const valid: File[] = [];
    for (const file of Array.from(files)) {
      const problem = validateFile(file, allowed);
      if (problem) toast.error(problem);
      else valid.push(file);
    }
    if (valid.length > 0) add(valid);
  }

  function addUrl() {
    const url = normalizeUrl(urlInput);
    if (!url) return toast.error('La dirección web no es válida.');
    setDraft((d) => (d.sourceUrls.includes(url) ? d : { ...d, sourceUrls: [...d.sourceUrls, url] }));
    setUrlInput('');
  }

  async function create() {
    const parsed = brandBasicsSchema.safeParse(basics);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Revisa los datos básicos.');
      return goTo(0);
    }
    const problems: string[] = [];
    let brandId: string | null = null;
    try {
      setCreating('Creando la marca…');
      const brand = await createBrand(org.id, parsed.data);
      brandId = brand.id;

      const logoIds: string[] = [];
      for (const [index, file] of logoFiles.entries()) {
        setCreating(`Subiendo logotipos (${index + 1} de ${logoFiles.length})…`);
        try {
          logoIds.push((await uploadAsset({ organizationId: org.id, brandId: brand.id, file, kind: 'logo' })).id);
        } catch (e) {
          problems.push(`Logotipo «${file.name}»: ${translateError(e)}`);
        }
      }

      for (const [index, file] of sourceFiles.entries()) {
        setCreating(`Subiendo documentos (${index + 1} de ${sourceFiles.length})…`);
        try {
          await uploadSource(org.id, brand.id, file);
        } catch (e) {
          problems.push(`Documento «${file.name}»: ${translateError(e)}`);
        }
      }
      for (const url of draft.sourceUrls) {
        try {
          await addUrlSource(org.id, brand.id, url);
        } catch (e) {
          problems.push(`Web ${url}: ${translateError(e)}`);
        }
      }

      setCreating('Guardando el perfil…');
      const clean = normalizeProfile({ ...profile, visual: { ...profile.visual, logoAssetIds: logoIds } });
      await saveBrandProfile(
        brand.id,
        clean,
        nextProvenance({}, null, clean, draft.origin),
        draft.origin === 'import' ? 'Importada desde configuración' : 'Alta de la marca',
      );
      await setBrandStatus(brand.id, 'active');

      removeLocal(draftKey);
      await queryClient.invalidateQueries({ queryKey: orgKeys.brands(org.id) });
      if (problems.length > 0)
        toast.warning(`Marca creada, pero algunos archivos no se subieron: ${problems.join(' · ')}`, {
          duration: 12000,
        });
      else toast.success('Marca creada');
      navigate(`/o/${org.id}/m/${brand.id}/inicio`, { replace: true });
    } catch (e) {
      setCreating(null);
      if (brandId) {
        // La marca existe pero el alta quedó a medias: se lleva al usuario a completarla, sin duplicarla.
        removeLocal(draftKey);
        await queryClient.invalidateQueries({ queryKey: orgKeys.brands(org.id) });
        toast.error(
          `La marca se ha creado, pero no se pudo completar el alta: ${translateError(e)} Termina de configurarla desde «Marca».`,
          { duration: 12000 },
        );
        navigate(`/o/${org.id}/m/${brandId}/marca`, { replace: true });
      } else {
        toast.error(translateError(e));
      }
    }
  }

  if (!isAdmin) {
    return (
      <Card>
        <EmptyState
          icon={X}
          title="No puedes crear marcas"
          description="Solo los propietarios y administradores de la organización pueden dar de alta marcas."
          action={
            <Link to={`/o/${org.id}`}>
              <Button>Volver</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-3xl" data-testid="brand-wizard">
      <PageHeader
        title="Nueva marca"
        description="Solo el nombre es obligatorio. Todo lo demás se puede completar o cambiar después."
      />

      {showRecovered && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-primary-soft px-3.5 py-3 text-sm text-primary"
          data-testid="wizard-recovered"
        >
          <span>Hemos recuperado el borrador que dejaste a medias (los archivos hay que volver a elegirlos).</span>
          <span className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={startOver}>
              Empezar de cero
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowRecovered(false)}>
              Seguir
            </Button>
          </span>
        </div>
      )}

      <ol className="mb-6 flex gap-1.5" aria-label="Pasos del asistente">
        {STEPS.map((label, index) => (
          <li key={label} className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => goTo(index)}
              aria-current={index === step ? 'step' : undefined}
              aria-label={`Paso ${index + 1} de ${STEPS.length}: ${label}`}
              data-testid={`wizard-step-${index}`}
              className="block w-full rounded-md py-1 text-left"
            >
              <span
                className={cn('block h-1.5 rounded-full transition-colors', index <= step ? 'bg-primary' : 'bg-border')}
              />
              <span
                className={cn(
                  'mt-1.5 hidden truncate text-xs sm:block',
                  index === step ? 'font-medium text-fg' : 'text-muted',
                )}
              >
                {label}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <Card>
        <CardBody className="space-y-6">
          <h2 ref={headingRef} tabIndex={-1} className="text-lg outline-none">
            <span className="text-muted">
              {step + 1}/{STEPS.length}
            </span>{' '}
            {
              [
                'Datos básicos',
                'El negocio',
                'Público y objetivos',
                'Voz de la marca',
                'Identidad visual',
                'Fuentes de conocimiento',
                'Revisa y crea',
              ][step]
            }
          </h2>

          {step === 0 && (
            <>
              <BasicsFields
                value={basics}
                onChange={(next) => setDraft((d) => ({ ...d, basics: next }))}
                nameError={nameError}
              />
              <div className="rounded-lg border border-dashed border-border p-4">
                <p className="text-sm font-medium">¿Ya tienes una configuración exportada?</p>
                <p className="mt-0.5 text-xs text-muted">
                  Impórtala para crear una marca nueva con esos datos, sin rellenar el asistente.
                </p>
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => importRef.current?.click()}>
                  <FileJson className="h-4 w-4" aria-hidden />
                  Subir una configuración guardada
                </Button>
                <input
                  ref={importRef}
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  aria-label="Subir una configuración guardada"
                  data-testid="wizard-import-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void importConfig(file);
                    e.target.value = '';
                  }}
                />
                {importErrors.length > 0 && (
                  <div
                    role="alert"
                    className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
                    data-testid="wizard-import-errors"
                  >
                    <p className="font-medium">No se ha podido importar:</p>
                    <ul className="mt-1 list-inside list-disc">
                      {importErrors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </>
          )}

          {step === 1 && <BusinessSection value={profile} onChange={setProfile} />}
          {step === 2 && <AudienceSection value={profile} onChange={setProfile} />}
          {step === 3 && <VoiceSection value={profile} onChange={setProfile} />}

          {step === 4 && (
            <>
              <div className="space-y-2">
                <p className="text-sm font-medium">Logotipos</p>
                <p className="text-xs text-muted">PNG, JPG o WebP. Se subirán a la biblioteca al crear la marca.</p>
                <FileChips
                  files={logoFiles}
                  onRemove={(i) => setLogoFiles((f) => f.filter((_, index) => index !== i))}
                />
                <Button variant="secondary" size="sm" onClick={() => logoRef.current?.click()}>
                  <ImagePlus className="h-4 w-4" aria-hidden />
                  Elegir logotipos
                </Button>
                <input
                  ref={logoRef}
                  type="file"
                  multiple
                  accept={LOGO_MIME_TYPES.join(',')}
                  className="sr-only"
                  aria-label="Elegir logotipos"
                  data-testid="wizard-logo-input"
                  onChange={(e) => {
                    if (e.target.files)
                      addFiles(e.target.files, LOGO_MIME_TYPES, (valid) => setLogoFiles((f) => [...f, ...valid]));
                    e.target.value = '';
                  }}
                />
              </div>
              <VisualSection value={profile} onChange={setProfile} />
              <ChannelsSection value={profile} onChange={setProfile} />
            </>
          )}

          {step === 5 && (
            <>
              <p className="text-sm text-muted">
                Sube el manual de marca y otros documentos, o indica la web. Servirán para que la plataforma conozca la
                marca.
              </p>
              <Notice>{SOURCES_NOTICE}</Notice>
              <div className="space-y-2">
                <p className="text-sm font-medium">Documentos</p>
                <FileChips
                  files={sourceFiles}
                  onRemove={(i) => setSourceFiles((f) => f.filter((_, index) => index !== i))}
                />
                <Button variant="secondary" size="sm" onClick={() => sourceRef.current?.click()}>
                  <Upload className="h-4 w-4" aria-hidden />
                  Elegir documentos
                </Button>
                <input
                  ref={sourceRef}
                  type="file"
                  multiple
                  accept={SOURCE_MIME_TYPES.join(',')}
                  className="sr-only"
                  aria-label="Elegir documentos de la marca"
                  data-testid="wizard-source-input"
                  onChange={(e) => {
                    if (e.target.files)
                      addFiles(e.target.files, SOURCE_MIME_TYPES, (valid) => setSourceFiles((f) => [...f, ...valid]));
                    e.target.value = '';
                  }}
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Páginas web</p>
                {draft.sourceUrls.length > 0 && (
                  <ul className="space-y-1.5">
                    {draft.sourceUrls.map((url) => (
                      <li key={url} className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2 text-sm">
                        <Globe className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{url}</span>
                        <button
                          type="button"
                          onClick={() => setDraft((d) => ({ ...d, sourceUrls: d.sourceUrls.filter((u) => u !== url) }))}
                          aria-label={`Quitar ${url}`}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-border hover:text-fg"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-2">
                  <Input
                    type="text"
                    inputMode="url"
                    aria-label="Dirección de la página web"
                    placeholder="https://tumarca.com"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addUrl();
                      }
                    }}
                    data-testid="wizard-url"
                  />
                  <Button variant="secondary" onClick={addUrl} disabled={!urlInput.trim()} data-testid="wizard-url-add">
                    <Link2 className="h-4 w-4" aria-hidden />
                    Añadir
                  </Button>
                </div>
              </div>
            </>
          )}

          {step === 6 && (
            <dl className="divide-y divide-border" data-testid="wizard-summary">
              <SummaryRow label="Marca">
                <strong>{basics.name || '—'}</strong>
                {basics.sector && ` · ${basics.sector}`}
                {basics.website && ` · ${basics.website}`}
              </SummaryRow>
              <SummaryRow label="Negocio">
                {profile.business.description || 'Sin descripción'} ·{' '}
                {count(
                  profile.business.products.filter((p) => p.name.trim()).length,
                  'producto o servicio',
                  'productos o servicios',
                )}
              </SummaryRow>
              <SummaryRow label="Público y objetivos">
                {count(profile.audience.segments.filter((s) => s.name.trim()).length, 'público', 'públicos')} ·{' '}
                {count(profile.goals.length, 'objetivo', 'objetivos')}
              </SummaryRow>
              <SummaryRow label="Voz">
                {profile.voice.tone.length > 0 ? profile.voice.tone.join(', ') : 'Sin indicar'}
              </SummaryRow>
              <SummaryRow label="Identidad visual">
                <span className="flex flex-wrap items-center gap-2">
                  {profile.visual.colors.map((color, i) => (
                    <span
                      key={i}
                      className="inline-block h-5 w-5 rounded-full border border-border"
                      style={{ backgroundColor: color.hex }}
                      title={color.name || color.hex}
                    />
                  ))}
                  <span>
                    {count(profile.visual.colors.length, 'color', 'colores')} ·{' '}
                    {count(profile.visual.fonts.filter((f) => f.family.trim()).length, 'tipografía', 'tipografías')} ·{' '}
                    {count(logoFiles.length, 'logotipo', 'logotipos')}
                  </span>
                </span>
              </SummaryRow>
              <SummaryRow label="Fuentes">
                {count(sourceFiles.length, 'documento', 'documentos')} · {count(draft.sourceUrls.length, 'web', 'webs')}
              </SummaryRow>
            </dl>
          )}
        </CardBody>
      </Card>

      <div className="mt-6 flex items-center justify-between gap-3">
        {step === 0 ? (
          <Link to={`/o/${org.id}`}>
            <Button variant="ghost">Cancelar</Button>
          </Link>
        ) : (
          <Button
            variant="secondary"
            onClick={() => goTo(step - 1)}
            disabled={creating !== null}
            data-testid="wizard-back"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Atrás
          </Button>
        )}
        <div className="flex items-center gap-3">
          {creating && (
            <span role="status" className="text-sm text-muted">
              {creating}
            </span>
          )}
          {!last && step > 0 && (
            <Button variant="ghost" onClick={() => goTo(STEPS.length - 1)} data-testid="wizard-skip">
              Ir al resumen
            </Button>
          )}
          {last ? (
            <Button
              onClick={() => void create()}
              loading={creating !== null}
              disabled={!basics.name.trim()}
              data-testid="wizard-create"
            >
              <Check className="h-4 w-4" aria-hidden />
              Crear marca
            </Button>
          ) : (
            <Button onClick={() => goTo(step + 1)} data-testid="wizard-next">
              Siguiente
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
