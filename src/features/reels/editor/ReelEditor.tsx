// Editor de reels: una pieza de formato reel cuyas versiones son montajes
// (proyecto con el plan v2). Línea de tiempo, vista previa al momento en el
// navegador, textos y subtítulos, música con su licencia, guardado con
// versiones, aprobación y montaje del vídeo por el trabajador de medios.
import {
  Captions,
  ChevronLeft,
  Clapperboard,
  History,
  Images,
  Music2,
  Plus,
  Redo2,
  Save,
  Send,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Notice,
  Select,
  Skeleton,
} from '@/components/ui';
import { mediaWorkerEnabled } from '@/config/app';
import { useActiveProfile } from '@/features/brand/api';
import { useBrandFontFaces, useReelFont } from '@/features/brand/fontsApi';
import { parseProfile } from '@/features/brand/profile';
import {
  fetchContentVersion,
  isVersionConflict,
  useContentMutations,
  useContentVersions,
} from '@/features/content/api';
import { SaveVersionDialog } from '@/features/content/editor/SaveVersionDialog';
import { contentPaths } from '@/features/content/labels';
import { STATUS_LABEL, STATUS_TONE, statusActions, statusChangedMessage } from '@/features/content/status';
import { useSignedUrls } from '@/features/library/api';
import { useBrand, useOrg } from '@/features/orgs/context';
import { useFeature } from '@/features/platform/integrations/useFeature';
import { PUBLISHABLE_TARGETS } from '@/features/social/calendar';
import { PublishNowDialog } from '@/features/social/PublishNowDialog';
import type { ContentItemRow, ContentStatus, ContentVersionRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { cn, formatDateTime } from '@/lib/utils';
import { useRequestReel, useReelSources, type ReelSourceAsset } from '../api';
import { describeJob, isActive } from '../plan';
import { REEL_TEMPLATES, type ReelTemplateSummary } from '../templates';
import { jobContentVersion, pieceJobKeys, renderOfVersion, usePieceJobs, useSaveReelVersion } from './api';
import { previewWarnings } from './compose';
import { editorReducer, initEditor, type Selection } from './history';
import { Inspector, type Apply, type BrandFontOption } from './Inspector';
import { addClip, addText, brandTextStyle, moveClip, moveText, newId, setMusic, trimClip, trimText } from './ops';
import {
  applyTemplate,
  buildRenderRequest,
  emptyProject,
  isReelProject,
  parseProject,
  planTimeline,
  projectProblems,
  ProjectError,
  REEL_MAX_CLIPS,
  REEL_MAX_SECONDS,
  type ReelProject,
} from './project';
import { ReelPlayer } from './ReelPlayer';
import { Timeline, ZOOM_LEVELS } from './Timeline';
import { useQueryClient } from '@tanstack/react-query';

const DEFAULT_TEMPLATE_ID = 'fundido-suave';
const fmt = (n: number) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(n);
const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));

const defaultTemplate = (): ReelTemplateSummary =>
  REEL_TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID) ?? REEL_TEMPLATES[0]!;

type Start =
  | { kind: 'project'; project: ReelProject }
  | { kind: 'empty'; previous: 'none' | 'design' }
  | { kind: 'unreadable'; message: string };

/** Con qué se abre el editor: el montaje de la versión vigente, uno vacío o el aviso de que no se puede leer. */
export function startOf(version: ContentVersionRow | null): Start {
  if (!version) return { kind: 'empty', previous: 'none' };
  if (!isReelProject(version.data)) return { kind: 'empty', previous: 'design' };
  try {
    return { kind: 'project', project: parseProject(version.data) };
  } catch (error) {
    return { kind: 'unreadable', message: error instanceof ProjectError ? error.message : 'El montaje no es válido.' };
  }
}

export interface ReelEditorProps {
  item: ContentItemRow;
  version: ContentVersionRow | null;
  /** Vuelve a cargar la pieza desde cero (tras restaurar una versión). */
  onReopen: () => void;
}

export function ReelEditor({ item, version, onReopen }: ReelEditorProps) {
  const [start] = useState(() => startOf(version));
  const [forceNew, setForceNew] = useState(false);
  const { org } = useOrg();
  const { brand } = useBrand();
  const paths = contentPaths(org.id, brand.id);

  if (start.kind === 'unreadable' && !forceNew) {
    return (
      <div className="space-y-4">
        <Link to={paths.list} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Contenidos
        </Link>
        <Card>
          <CardBody className="space-y-3">
            <ErrorState error={new Error(start.message)} />
            <Button onClick={() => setForceNew(true)}>Empezar un montaje nuevo</Button>
          </CardBody>
        </Card>
      </div>
    );
  }
  const initial = start.kind === 'project' ? start.project : emptyProject(defaultTemplate());
  return (
    <Editor
      item={item}
      initial={initial}
      previousDesign={start.kind === 'empty' && start.previous === 'design'}
      onReopen={onReopen}
    />
  );
}

function Editor({
  item,
  initial,
  previousDesign,
  onReopen,
}: {
  item: ContentItemRow;
  initial: ReelProject;
  previousDesign: boolean;
  onReopen: () => void;
}) {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const queryClient = useQueryClient();
  const paths = contentPaths(org.id, brand.id);
  const canEdit = can('edit');
  const canApprove = can('approve');
  const readOnly = !canEdit || Boolean(item.archived_at);
  const [state, dispatch] = useReducer(editorReducer, initial, initEditor);
  const { project, selection } = state;
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [expectedVersion, setExpectedVersion] = useState(item.current_version);
  const dirty = JSON.stringify(project) !== baseline;
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(2);
  const [saveOpen, setSaveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [musicOpen, setMusicOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [busyStatus, setBusyStatus] = useState<ContentStatus | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const template = REEL_TEMPLATES.find((t) => t.id === project.template.id) ?? defaultTemplate();
  const sources = useReelSources(brand.id);
  const byPath = useMemo(() => new Map((sources.data ?? []).map((a) => [a.storage_path, a])), [sources.data]);
  const labelOf = useCallback((path: string) => byPath.get(path)?.file_name ?? path.split('/').pop() ?? path, [byPath]);
  const fileSecondsOf = useCallback(
    (path: string) => {
      const ms = byPath.get(path)?.duration_ms;
      return typeof ms === 'number' && ms > 0 ? ms / 1000 : null;
    },
    [byPath],
  );
  const timeline = useMemo(
    () => planTimeline(project.plan.clips, template, (c) => fileSecondsOf(c.path)),
    [project.plan.clips, template, fileSecondsOf],
  );

  // Direcciones firmadas de todo lo que suena o se ve en el reel.
  const usedPaths = useMemo(
    () =>
      [
        ...new Set([
          ...project.plan.clips.map((c) => c.path),
          ...(project.plan.music ? [project.plan.music.path] : []),
        ]),
      ].sort(),
    [project.plan.clips, project.plan.music],
  );
  const signed = useSignedUrls(usedPaths);
  const urls = useMemo(() => signed.data ?? new Map<string, string>(), [signed.data]);

  // Marca: paleta del perfil y tipografías .ttf/.otf (las que puede usar el trabajador).
  const profileRow = useActiveProfile(brand.id);
  const profile = useMemo(() => (profileRow.data ? parseProfile(profileRow.data.data) : null), [profileRow.data]);
  const palette = useMemo(
    () => (profile?.visual.colors ?? []).map((c) => ({ hex: c.hex.toUpperCase(), name: c.name })),
    [profile],
  );
  const fontFaces = useBrandFontFaces(brand.id);
  const reelFont = useReelFont(brand.id);
  const fonts: BrandFontOption[] = useMemo(
    () =>
      fontFaces.fonts
        .filter((f) => f.format === 'ttf' || f.format === 'otf')
        .map((f) => ({
          path: f.storage_path,
          family: f.family,
          label: `${f.family} ${f.weight}${f.style === 'italic' ? ' cursiva' : ''}`,
        })),
    [fontFaces.fonts],
  );

  const autoSubtitles = useFeature('reelSubtitles');
  const publishingOn = useFeature('publishing');
  const worker = mediaWorkerEnabled();
  const jobs = usePieceJobs(brand.id, item.id);
  const request = useRequestReel(brand.id);
  const saveReel = useSaveReelVersion(brand.id);
  const mutations = useContentMutations(org.id, brand.id);

  const problems = projectProblems(project, template, { fileSeconds: fileSecondsOf });
  const warnings = previewWarnings(project.plan, template, {
    loadedFamilies: fontFaces.families,
    brandReelFont: Boolean(reelFont.data),
    mimeOf: (path) => byPath.get(path)?.mime_type ?? null,
  });
  const render = renderOfVersion(jobs.data ?? [], expectedVersion);
  const rendering = (jobs.data ?? []).some((j) => isActive(j) && jobContentVersion(j) === expectedVersion);

  const apply: Apply = useCallback((change, merge) => dispatch({ type: 'change', change, merge }), []);
  const select = useCallback((next: Selection) => dispatch({ type: 'select', selection: next }), []);

  // Teclado: deshacer y rehacer, y espacio para reproducir (fuera de los campos).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      } else if (event.key === ' ' && rootRef.current?.contains(event.target as Node)) {
        event.preventDefault();
        setPlaying((p) => !p);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const seek = useCallback(
    (seconds: number) => {
      setPlaying(false);
      setPlayhead(Math.max(0, Math.min(seconds, timeline.total)));
    },
    [timeline.total],
  );

  async function save(note: string) {
    try {
      const row = await saveReel.mutateAsync({ contentId: item.id, project, note, expectedVersion });
      setExpectedVersion(row.version);
      setBaseline(JSON.stringify(project));
      dispatch({ type: 'commit' });
      setSaveOpen(false);
      toast.success(`Versión ${row.version} guardada.`);
    } catch (error) {
      toast.error(
        isVersionConflict(error)
          ? 'Otra persona ha guardado una versión más reciente. Vuelve a abrir la pieza antes de guardar.'
          : error instanceof ProjectError
            ? error.message
            : translateError(error),
      );
    }
  }

  async function changeStatus(to: ContentStatus) {
    setBusyStatus(to);
    try {
      await mutations.setStatus.mutateAsync({ contentId: item.id, status: to, expectedVersion });
      toast.success(statusChangedMessage(to));
    } catch (error) {
      toast.error(translateError(error));
    } finally {
      setBusyStatus(null);
    }
  }

  function renderVideo() {
    if (dirty || problems.length > 0) return;
    request.mutate(
      {
        request: buildRenderRequest(project, { id: item.id, version: expectedVersion }),
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: pieceJobKeys(brand.id, item.id) });
          toast.success('Montaje encargado: el vídeo llegará a la biblioteca (carpeta «Reels»).');
        },
        onError: (error) => toast.error(translateError(error)),
      },
    );
  }

  async function restore(versionNumber: number) {
    try {
      const row = await mutations.restore.mutateAsync({ contentId: item.id, version: versionNumber, expectedVersion });
      const loaded = await fetchContentVersion(item.id, row.version);
      if (isReelProject(loaded.row.data)) {
        const restored = parseProject(loaded.row.data);
        dispatch({ type: 'reset', project: restored });
        setBaseline(JSON.stringify(restored));
        setExpectedVersion(row.version);
      } else {
        onReopen();
      }
      setHistoryOpen(false);
      toast.success(`Versión ${versionNumber} restaurada como versión ${row.version}.`);
    } catch (error) {
      toast.error(translateError(error));
    }
  }

  // El identificador del elemento nuevo se calcula antes, para elegirlo en el mismo paso.
  const takenIds = () => [...project.plan.clips.map((c) => c.id), ...project.plan.texts.map((t) => t.id)];
  const addMedia = (asset: ReelSourceAsset) => {
    dispatch({
      type: 'change',
      change: (p) => addClip(p, asset, template),
      select: { kind: 'clip', id: newId('c', takenIds()) },
    });
  };
  const newText = () => {
    const defaultFont = fonts.find((f) => reelFont.data && f.family === reelFont.data.family);
    const style = brandTextStyle(template, {
      fontPath: defaultFont?.path,
      fontFamily: defaultFont?.family,
      color: palette[0]?.hex,
    });
    dispatch({
      type: 'change',
      change: (p) => addText(p, template, playhead, style, timeline.total),
      select: { kind: 'text', id: newId('t', takenIds()) },
    });
  };

  const actions = statusActions(item, { edit: canEdit, approve: canApprove });
  const canPublish =
    publishingOn &&
    canEdit &&
    !item.archived_at &&
    item.status === 'approved' &&
    PUBLISHABLE_TARGETS.has(`${item.network}:${item.format}`);
  const pps = ZOOM_LEVELS[zoom]!;

  return (
    <div ref={rootRef} className="space-y-4" data-testid="reel-editor">
      {/* ── Cabecera ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Link to={paths.list} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Contenidos
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{item.title}</h1>
        <Badge tone={STATUS_TONE[item.status]}>
          <span data-testid="reel-status">{STATUS_LABEL[item.status]}</span>
        </Badge>
        <span className="text-xs text-muted" data-testid="reel-version">
          {expectedVersion > 0 ? `Versión ${expectedVersion}` : 'Sin guardar'}
          {dirty ? ' · cambios sin guardar' : ''}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!readOnly && (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Deshacer"
              disabled={state.past.length === 0}
              onClick={() => dispatch({ type: 'undo' })}
              data-testid="reel-undo"
            >
              <Undo2 className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Rehacer"
              disabled={state.future.length === 0}
              onClick={() => dispatch({ type: 'redo' })}
              data-testid="reel-redo"
            >
              <Redo2 className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              onClick={() => setSaveOpen(true)}
              disabled={!dirty || project.plan.clips.length === 0}
              data-testid="reel-save"
            >
              <Save className="h-4 w-4" aria-hidden />
              Guardar versión
            </Button>
          </>
        )}
        <Button variant="secondary" onClick={() => setHistoryOpen(true)} disabled={item.current_version === 0}>
          <History className="h-4 w-4" aria-hidden />
          Historial
        </Button>
        {actions.map((action) => (
          <Button
            key={action.to}
            variant="secondary"
            onClick={() => void changeStatus(action.to)}
            disabled={(action.needsVersion && (expectedVersion === 0 || dirty)) || busyStatus !== null}
            loading={busyStatus === action.to}
            data-testid={`reel-status-${action.to}`}
          >
            {action.label}
          </Button>
        ))}
        {worker && !readOnly && (
          <Button
            variant="secondary"
            onClick={renderVideo}
            disabled={dirty || expectedVersion === 0 || problems.length > 0 || rendering}
            loading={request.isPending}
            title={dirty ? 'Guarda los cambios antes de montar' : undefined}
            data-testid="reel-render"
          >
            <Clapperboard className="h-4 w-4" aria-hidden />
            {rendering ? 'Montando…' : 'Montar el vídeo'}
          </Button>
        )}
        {canPublish && render && (
          <Button variant="secondary" onClick={() => setPublishOpen(true)}>
            <Send className="h-4 w-4" aria-hidden />
            Publicar ahora
          </Button>
        )}
      </div>

      {previousDesign && (
        <Notice>
          La versión vigente de esta pieza es un diseño por capas. Aquí empiezas un montaje de vídeo: al guardarlo será
          una versión nueva. El diseño sigue en el historial y se puede abrir{' '}
          <Link to="?editor=imagen" className="font-medium text-primary underline">
            en el editor de imagen
          </Link>
          .
        </Notice>
      )}
      {!worker && (
        <Notice>
          Puedes montar, previsualizar, guardar y aprobar el reel. El vídeo final lo monta el trabajador de medios, que
          no está disponible en este entorno.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {/* ── Vista previa ── */}
        <div className="space-y-3">
          <ReelPlayer
            plan={project.plan}
            timeline={timeline}
            template={template}
            urls={urls}
            defaultFamily={reelFont.data?.family ?? null}
            playhead={playhead}
            playing={playing}
            onTime={setPlayhead}
            onPlayingChange={setPlaying}
          />
          {warnings.length > 0 && project.plan.clips.length > 0 && (
            <div data-testid="reel-preview-warnings">
              <Notice tone="warning">
                <span className="font-medium">Se verá distinto en el vídeo:</span>
                <ul className="mt-1 list-disc pl-4 text-xs">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Notice>
            </div>
          )}
        </div>

        {/* ── Plantilla, añadir y propiedades ── */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Plantilla de partida">
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={template.id}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = REEL_TEMPLATES.find((t) => t.id === e.target.value);
                    if (next) apply((p) => applyTemplate(p, next));
                  }}
                  data-testid="reel-template"
                >
                  {REEL_TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {!readOnly && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setMediaOpen(true)}
                  disabled={project.plan.clips.length >= REEL_MAX_CLIPS}
                  data-testid="reel-add-media"
                >
                  <Images className="h-4 w-4" aria-hidden />
                  Foto o clip
                </Button>
                <Button
                  variant="secondary"
                  onClick={newText}
                  disabled={project.plan.clips.length === 0}
                  data-testid="reel-add-text"
                >
                  <Type className="h-4 w-4" aria-hidden />
                  Texto
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => (project.plan.music ? select({ kind: 'music' }) : setMusicOpen(true))}
                  data-testid="reel-add-music"
                >
                  <Music2 className="h-4 w-4" aria-hidden />
                  Música
                </Button>
                <Button variant="secondary" onClick={() => select({ kind: 'subtitles' })} data-testid="reel-subtitles">
                  <Captions className="h-4 w-4" aria-hidden />
                  Subtítulos
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-muted">{template.description}</p>
          <Card>
            <CardBody>
              <Inspector
                project={project}
                selection={selection}
                template={template}
                readOnly={readOnly}
                apply={apply}
                onSelect={select}
                labelOf={labelOf}
                fileSecondsOf={fileSecondsOf}
                urlOf={(path) => urls.get(path)}
                palette={palette}
                fonts={fonts}
                autoSubtitles={autoSubtitles}
                brandId={brand.id}
              />
            </CardBody>
          </Card>
        </div>
      </div>

      {/* ── Línea de tiempo ── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Línea de tiempo</span>
          <span className="text-muted" data-testid="reel-duration">
            {fmt(timeline.total)} s de {REEL_MAX_SECONDS} s como máximo
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Alejar la línea de tiempo"
              disabled={zoom === 0}
              onClick={() => setZoom((z) => z - 1)}
            >
              <ZoomOut className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Acercar la línea de tiempo"
              disabled={zoom === ZOOM_LEVELS.length - 1}
              onClick={() => setZoom((z) => z + 1)}
              data-testid="reel-zoom-in"
            >
              <ZoomIn className="h-4 w-4" aria-hidden />
            </Button>
          </span>
        </div>
        {project.plan.clips.length === 0 ? (
          <Card>
            <EmptyState
              icon={Images}
              title="Todavía no hay nada en el reel"
              description="Añade fotos y clips de la biblioteca. La plantilla pone la duración, las transiciones y el estilo de partida."
              action={
                !readOnly ? (
                  <Button onClick={() => setMediaOpen(true)}>
                    <Plus className="h-4 w-4" aria-hidden />
                    Añadir foto o clip
                  </Button>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <Timeline
            plan={project.plan}
            timeline={timeline}
            pxPerSecond={pps}
            playhead={playhead}
            selection={selection}
            readOnly={readOnly}
            labelOf={labelOf}
            fileSecondsOf={fileSecondsOf}
            onSeek={seek}
            onSelect={select}
            onMoveClip={(from, to) => apply((p) => moveClip(p, from, to))}
            onTrimClip={(id, edge, value, key) => {
              const clip = project.plan.clips.find((c) => c.id === id);
              apply((p) => trimClip(p, id, edge, value, clip ? fileSecondsOf(clip.path) : null), key);
            }}
            onMoveText={(id, value, key) => apply((p) => moveText(p, id, value), key)}
            onTrimText={(id, edge, value, key) => apply((p) => trimText(p, id, edge, value), key)}
            onDragEnd={() => dispatch({ type: 'commit' })}
          />
        )}
        {problems.length > 0 && project.plan.clips.length > 0 && (
          <ul className="space-y-1 text-sm text-danger" data-testid="reel-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Montajes de la pieza ── */}
      {worker && (
        <Card>
          <CardBody className="space-y-2">
            <h2 className="text-sm font-semibold">Montajes</h2>
            {jobs.isPending ? (
              <Skeleton className="h-12" />
            ) : (jobs.data ?? []).length === 0 ? (
              <p className="text-sm text-muted">Todavía no se ha montado ninguna versión.</p>
            ) : (
              <ul className="divide-y divide-border" data-testid="reel-piece-jobs">
                {(jobs.data ?? []).map((job) => {
                  const view = describeJob(job);
                  return (
                    <li
                      key={job.id}
                      className="flex flex-wrap items-center gap-2 py-2 text-sm"
                      data-testid="reel-piece-job"
                    >
                      <span>Versión {jobContentVersion(job) ?? '?'}</span>
                      <Badge
                        tone={
                          view.tone === 'success'
                            ? 'success'
                            : view.tone === 'danger'
                              ? 'danger'
                              : view.tone === 'progress'
                                ? 'primary'
                                : 'neutral'
                        }
                      >
                        {view.label}
                      </Badge>
                      <span className="text-xs text-muted">{formatDateTime(job.created_at)}</span>
                      {view.detail && <span className="w-full text-xs text-danger">{view.detail}</span>}
                      {view.assetId && (
                        <Link
                          to={`/o/${org.id}/m/${brand.id}/biblioteca?recurso=${view.assetId}`}
                          className="font-medium text-primary hover:underline"
                        >
                          Ver el vídeo
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <SaveVersionDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        saving={saveReel.isPending}
        issues={[]}
        onSave={(note) => void save(note)}
      />
      <MediaPicker
        open={mediaOpen}
        onOpenChange={setMediaOpen}
        sources={(sources.data ?? []).filter((a) => a.kind === 'image' || a.kind === 'video')}
        loading={sources.isPending}
        error={sources.error}
        onPick={(asset) => {
          addMedia(asset);
          setMediaOpen(false);
        }}
      />
      <MusicPicker
        open={musicOpen}
        onOpenChange={setMusicOpen}
        audios={(sources.data ?? []).filter((a) => a.kind === 'audio')}
        onPick={(asset, note) => {
          apply((p) => setMusic(p, asset.storage_path, template, note));
          select({ kind: 'music' });
          setMusicOpen(false);
        }}
      />
      <VersionsDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        brandId={brand.id}
        contentId={item.id}
        current={expectedVersion}
        canRestore={!readOnly}
        restoring={mutations.restore.isPending}
        onRestore={(v) => void restore(v)}
      />
      {canPublish && render && (
        <PublishNowDialog
          brandId={brand.id}
          open={publishOpen}
          onOpenChange={setPublishOpen}
          contentId={item.id}
          assetIds={[render]}
          editorPath={paths.item(item.id)}
        />
      )}
    </div>
  );
}

function MediaPicker({
  open,
  onOpenChange,
  sources,
  loading,
  error,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: ReelSourceAsset[];
  loading: boolean;
  error: unknown;
  onPick: (asset: ReelSourceAsset) => void;
}) {
  const [query, setQuery] = useState('');
  const visible = sources.filter((s) => s.file_name.toLowerCase().includes(query.trim().toLowerCase()));
  const thumbs = useSignedUrls(
    open
      ? visible
          .filter((a) => a.kind === 'image')
          .map((a) => a.storage_path)
          .sort()
      : [],
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Añadir una foto o un clip"
      description="De la biblioteca de la marca."
      size="lg"
    >
      <Input
        placeholder="Buscar por nombre"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Buscar"
      />
      {loading ? (
        <Skeleton className="mt-3 h-24" />
      ) : error ? (
        <ErrorState error={error} />
      ) : visible.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No hay fotos ni clips. Súbelos primero a la biblioteca.</p>
      ) : (
        <ul
          className="mt-3 grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4"
          data-testid="reel-media-picker"
        >
          {visible.map((asset) => {
            const url = thumbs.data?.get(asset.storage_path);
            return (
              <li key={asset.id}>
                <button
                  type="button"
                  className="block w-full overflow-hidden rounded-lg border border-border bg-subtle text-left hover:shadow-pop"
                  onClick={() => onPick(asset)}
                  aria-label={`Añadir «${asset.file_name}»`}
                  data-testid="reel-media-option"
                >
                  <span className="flex aspect-square items-center justify-center overflow-hidden">
                    {asset.kind === 'image' && url ? (
                      <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <Clapperboard className="h-6 w-6 text-muted" aria-hidden />
                    )}
                  </span>
                  <span className="block truncate px-2 py-1 text-xs">{asset.file_name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

/** Elegir la música: aviso de licencia y confirmación obligatoria, que queda en el plan y en la procedencia. */
function MusicPicker({
  open,
  onOpenChange,
  audios,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audios: ReelSourceAsset[];
  onPick: (asset: ReelSourceAsset, note: string) => void;
}) {
  const [choice, setChoice] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const asset = audios.find((a) => a.id === choice);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setConfirmed(false);
          setNote('');
        }
        onOpenChange(next);
      }}
      title="Música del reel"
      description="Una pista de audio de la biblioteca de la marca."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!asset || !confirmed}
            onClick={() => asset && onPick(asset, note)}
            data-testid="reel-music-add"
          >
            Usar esta música
          </Button>
        </>
      }
    >
      {audios.length === 0 ? (
        <p className="text-sm text-muted">No hay audios en la biblioteca. Sube primero la pista.</p>
      ) : (
        <div className="space-y-3">
          <Select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            aria-label="Pista"
            data-testid="reel-music-choice"
          >
            <option value="">Elige una pista</option>
            {audios.map((a) => (
              <option key={a.id} value={a.id}>
                {a.file_name}
              </option>
            ))}
          </Select>
          <div data-testid="reel-music-license">
            <Notice tone="warning">
              La licencia de la música es responsabilidad de la marca. Publicar música sin permiso puede hacer que la
              red silencie o retire el vídeo. Confírmalo solo si la marca tiene derecho a usarla en redes sociales.
            </Notice>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              data-testid="reel-music-confirm"
            />
            La marca tiene licencia para usar esta música en sus redes.
          </label>
          <Input
            placeholder="De dónde sale la licencia (opcional): biblioteca, contrato…"
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Nota sobre la licencia"
          />
        </div>
      )}
    </Dialog>
  );
}

function VersionsDialog({
  open,
  onOpenChange,
  brandId,
  contentId,
  current,
  canRestore,
  restoring,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brandId: string;
  contentId: string;
  current: number;
  canRestore: boolean;
  restoring: boolean;
  onRestore: (version: number) => void;
}) {
  const versions = useContentVersions(brandId, contentId, open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Historial de versiones">
      {versions.isPending ? (
        <Skeleton className="h-24" />
      ) : versions.isError ? (
        <ErrorState error={versions.error} />
      ) : (
        <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto" data-testid="reel-versions">
          {versions.data.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className={cn('font-medium', v.version === current && 'text-primary')}>Versión {v.version}</span>
              <span className="text-xs text-muted">
                {v.author} · {formatDateTime(v.created_at)}
              </span>
              {v.change_note && <span className="w-full text-xs">{v.change_note}</span>}
              {canRestore && v.version !== current && (
                <Button variant="ghost" size="sm" loading={restoring} onClick={() => onRestore(v.version)}>
                  Restaurar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
