import {
  Archive,
  ArchiveRestore,
  CalendarPlus,
  CheckCircle2,
  ChevronLeft,
  Circle,
  Download,
  History,
  Image as ImageIcon,
  LayoutTemplate,
  Mic,
  PencilLine,
  Redo2,
  ScanEye,
  Save,
  Send,
  SendHorizontal,
  SearchX,
  Sparkles,
  Square,
  Stamp,
  ShieldAlert,
  Type,
  Undo2,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type MoreAction,
  type MoreMenuItem,
} from '@/components/ui';
import { aiVoiceCopilotEnabled } from '@/config/app';
import { AiBrandCheck } from '@/features/ai/AiBrandCheck';
import { GenerateCaptionDialog } from '@/features/ai/GenerateCaptionDialog';
import { GenerateImageDialog } from '@/features/ai/GenerateImageDialog';
import { canEditPhoto, canEditWithAi, useAiEditOptions } from '@/features/photo-edit/api';
import { PhotoEditDialog } from '@/features/photo-edit/PhotoEditDialog';
import type { PhotoToolsContext } from './editor/panels/PhotoPanel';
import { AskAgencyButton, ContentRequestOrigin } from '@/features/requests/ContentRequestPanel';
import { useActiveProfile } from '@/features/brand/api';
import { orderFontOptions } from '@/features/brand/fonts';
import { loadBrandFonts, useBrandFontFaces } from '@/features/brand/fontsApi';
import { publishedText } from '@/features/brandcheck/text';
import type { FindingTarget } from '@/features/brandcheck/types';
import { parseProfile } from '@/features/brand/profile';
import { previewPath, useAssetsByIds, useSignedUrls } from '@/features/library/api';
import { useBrand, useOrg } from '@/features/orgs/context';
import type { ContentStatus } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import {
  fetchContent,
  isVersionConflict,
  useContent,
  useContentMutations,
  type LoadedContent,
  type LoadedVersion,
} from './api';
import { aiContentReasons, describeAiReasons } from './aiLabel';
import { toneOfPalette } from './copilot/legibility';
import { speechRecognitionAvailable } from './copilot/speech';
import {
  allLayers,
  createEmptyDocument,
  DocumentError,
  MAX_LAYERS,
  pageLimits,
  pageView,
  type ContentDocument,
  type DocumentIssue,
} from './document';
import { ImagePickerDialog, LogoPickerDialog } from './editor/AssetPickerDialog';
import { BRAND_CHECK_PANEL } from './editor/brandCheckSlot';
import { assetIdsOf } from './editor/canvas/nodes';
import type { CanvasViewProps, SafeZoneOverlay } from './editor/canvas/types';
import { activePageIndex, editorReducer, initEditor } from './editor/history';
import { AddStickerSelect } from './editor/panels/AddStickerSelect';
import { newImageLayer, newLogoLayer, newShapeLayer, newTextLayer } from './editor/layers';
import { ArrangeControls, MultiSelectionPanel } from './editor/panels/ArrangeControls';
import { CopyPanel } from './editor/panels/CopyPanel';
import { LayersPanel } from './editor/panels/LayersPanel';
import { PageStrip } from './editor/panels/PageStrip';
import { PropertiesPanel, type BrandStyle } from './editor/panels/PropertiesPanel';
import { PieceSettingsDialog } from './editor/PieceSettingsDialog';
import { NetworkPreviewDialog } from './editor/preview/NetworkPreviewDialog';
import { SaveVersionDialog } from './editor/SaveVersionDialog';
import { imageUrlOf, mainImageLayer, useImagePalette } from './editor/useImagePalette';
import { VersionsDialog } from './editor/VersionsDialog';
import { ApplyTemplateDialog } from './templates/ApplyTemplateDialog';
import { PublishNowDialog } from '@/features/social/PublishNowDialog';
import { ScheduleDialog } from '@/features/social/ScheduleDialog';
import { EXPORT_PARAM } from '@/features/social/links';
import { PUBLISHABLE_TARGETS } from '@/features/social/calendar';
import { ExportImageDialog } from './export/ExportImageDialog';
import { exportForPublishing } from './export/exportForPublishing';
import { contentPaths, networkLabel, targetLabel } from './labels';
import { allowedCanvasRatios, getFormatSpec, recommendedCanvasRatio, type NetworkFormatSpec } from './networks';
import { safeZoneFor } from './safeZones';
import {
  editorPrimaryAction,
  STATUS_LABEL,
  STATUS_TONE,
  statusActions,
  statusChangedMessage,
  type StatusAction,
} from './status';
import { useFeature } from '@/features/platform/integrations/useFeature';

// El lienzo (y Konva con él) se descarga aparte, solo al abrir el editor.
const CanvasView = lazy(() => import('./editor/canvas/KonvaCanvas'));
// El editor de reels (piezas de formato reel), aparte: solo se descarga al abrir una.
const ReelEditor = lazy(() => import('@/features/reels/editor/ReelEditor').then((m) => ({ default: m.ReelEditor })));
// El copiloto por voz, también aparte: solo se descarga al pulsar «Dictar».
const VoiceCopilot = lazy(() => import('./copilot/VoiceCopilot').then((m) => ({ default: m.VoiceCopilot })));

/**
 * Documento de partida de una idea sin diseño: la proporción que recomienda la
 * red, si es una de las del lienzo, y las páginas mínimas del formato (un
 * carrusel empieza con dos).
 */
function startingDocument(spec: NetworkFormatSpec | undefined): ContentDocument {
  const media = spec?.media.includes('image') ? 'image' : spec?.media[0];
  const recommended = spec ? recommendedCanvasRatio(spec, media) : null;
  const allowed = spec ? allowedCanvasRatios(spec, media) : null;
  const aspectRatio = recommended?.ratio ?? (allowed?.ratios.includes('1:1') ? '1:1' : allowed?.ratios[0]) ?? '1:1';
  return createEmptyDocument({ aspectRatio, pages: pageLimits(spec).min });
}

/** Cambios de estado que hacen avanzar la pieza (el resto la devuelven atrás). */
const FORWARD_STATUSES = new Set<ContentStatus>(['in_review', 'approved']);

/** Campo del panel «Publicación» al que lleva cada parte del texto señalada por el verificador. */
const COPY_FIELD: Partial<Record<FindingTarget['part'], string>> = {
  caption: 'copy-caption',
  hashtags: 'copy-hashtags',
  mentions: 'copy-mentions',
  altText: 'copy-alt',
};

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));

export function ContentEditorPage() {
  const { org } = useOrg();
  const { brand } = useBrand();
  const { contentId = '' } = useParams();
  const content = useContent(brand.id, contentId);
  const paths = contentPaths(org.id, brand.id);
  // Volver a abrir el editor desde cero con los datos ya refrescados (tras restaurar una versión ilegible).
  const [session, setSession] = useState(0);
  const [searchParams] = useSearchParams();

  if (content.isPending) return <Spinner />;
  if (content.isError) {
    const missing = (content.error as { code?: string } | null)?.code === 'PGRST116';
    return (
      <Card>
        {missing ? (
          <EmptyState
            icon={SearchX}
            title="No encontramos este contenido"
            description="Puede que no exista o que no tengas acceso a él."
            action={
              <Link to={paths.list}>
                <Button>Ver los contenidos</Button>
              </Link>
            }
          />
        ) : (
          <ErrorState error={content.error} onRetry={() => void content.refetch()} />
        )}
      </Card>
    );
  }
  // Un reel se monta en el editor de reels; un diseño por capas antiguo se puede abrir con ?editor=imagen.
  if (content.data.item.format === 'reel' && searchParams.get('editor') !== 'imagen') {
    return (
      <Suspense fallback={<Spinner />}>
        <ReelEditor
          key={`${contentId}:${session}`}
          item={content.data.item}
          version={content.data.current?.row ?? null}
          onReopen={() => setSession((n) => n + 1)}
        />
      </Suspense>
    );
  }
  return <Editor key={`${contentId}:${session}`} content={content.data} onReopen={() => setSession((n) => n + 1)} />;
}

/**
 * El editor de una pieza. El documento se toma de `content` solo al montarse:
 * después manda el estado del editor, y los refrescos de la pieza (estado,
 * archivado) no pisan los cambios sin guardar.
 */
function Editor({ content, onReopen }: { content: LoadedContent; onReopen: () => void }) {
  const initial = content;
  const { org } = useOrg();
  const { brand, can, role } = useBrand();
  const navigate = useNavigate();
  // `?exportar=1`: se llega desde un aviso del calendario («Falta la imagen exportada → Exportar»).
  const [searchParams, setSearchParams] = useSearchParams();
  const item = content.item;
  const contentId = item.id;
  const paths = contentPaths(org.id, brand.id);
  const brandBase = `/o/${org.id}/m/${brand.id}`;
  const spec = getFormatSpec(item.network, item.format);
  const canEdit = can('edit');
  const canApprove = can('approve');
  const readOnly = !canEdit || Boolean(item.archived_at);
  const mutations = useContentMutations(org.id, brand.id);

  // El documento con el que se abre: la versión vigente o, en una idea sin diseño, uno vacío.
  const [unreadable] = useState(() => (initial.current && !initial.current.document ? initial.current : null));
  const [initialDocument] = useState(() => initial.current?.document ?? startingDocument(spec));
  const [state, dispatch] = useReducer(editorReducer, initialDocument, initEditor);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initialDocument));
  /** Versión sobre la que se trabaja: la que se manda como «esperada» al guardar, restaurar o cambiar de estado. */
  const [expectedVersion, setExpectedVersion] = useState(initial.item.current_version);
  const dirty = useMemo(() => JSON.stringify(state.document) !== baseline, [state.document, baseline]);

  const [panel, setPanel] = useState('layer');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveIssues, setSaveIssues] = useState<DocumentIssue[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(() => searchParams.has(EXPORT_PARAM));
  useEffect(() => {
    if (searchParams.has(EXPORT_PARAM)) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);
  const [publishNowOpen, setPublishNowOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [imagePicker, setImagePicker] = useState(false);
  const [logoPicker, setLogoPicker] = useState(false);
  const [imageAi, setImageAi] = useState(false);
  const [photoEditing, setPhotoEditing] = useState(false);
  const [photoEditTab, setPhotoEditTab] = useState<'enhance' | 'ai'>('enhance');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<LoadedVersion | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busyStatus, setBusyStatus] = useState<ContentStatus | null>(null);
  /** Texto que se está escribiendo directamente sobre el lienzo. */
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [showSafeZone, setShowSafeZone] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [focusText, setFocusText] = useState(0);
  /** Campo del texto de la publicación que hay que enfocar (al pulsar un hallazgo del verificador). */
  const [focusCopy, setFocusCopy] = useState<{ field: string; range?: FindingTarget['range']; n: number } | null>(null);
  // Con la marca en modo agencia no se redacta con el servicio de IA: se pide a la agencia.
  const aiText = useFeature('aiText');
  const aiEnabled = aiText && brand.ai_mode !== 'agency';
  // La imagen con IA es otro servicio, independiente del texto: depende solo de su interruptor.
  const aiImage = useFeature('aiImage');
  // Copiloto por voz: IA de texto configurada en el servidor + su interruptor +
  // dictado en el navegador. No redacta (coloca lo dictado), por eso sí sale en
  // marcas en modo agencia (decisión provisional, docs/ESTADO.md).
  const [voiceSupported] = useState(() => aiVoiceCopilotEnabled() && speechRecognitionAvailable());
  const voiceCopilot = voiceSupported && aiText;
  const [copilotOpen, setCopilotOpen] = useState(false);

  // Página activa: la que se ve en el lienzo y la que cambian las órdenes de capas.
  const pageIndex = activePageIndex(state);
  const page = useMemo(() => pageView(state.document, pageIndex), [state.document, pageIndex]);
  const layers = page.layers;
  // Las capas nuevas no repiten identificador con las de ninguna página.
  const everyLayer = allLayers(state.document);
  const pageRange = pageLimits(spec);
  const showPages = pageRange.max > 1 || state.document.pages.length > 1;
  const selected = layers.find((layer) => layer.id === state.selectedId) ?? null;
  const selectedLayers = useMemo(() => {
    const ids = new Set(state.selectedIds);
    return layers.filter((layer) => ids.has(layer.id));
  }, [layers, state.selectedIds]);

  // ── Zona segura de la red (orientativa) ──
  const safeZone = useMemo(() => safeZoneFor(spec, state.document.canvas), [spec, state.document.canvas]);
  const safeZoneOverlay: SafeZoneOverlay | null = useMemo(
    () => (showSafeZone && safeZone ? { unsafe: safeZone.unsafe, safe: safeZone.safe } : null),
    [showSafeZone, safeZone],
  );

  // ── Marca: paleta, tipografías y logotipos del perfil ──
  const profileRow = useActiveProfile(brand.id);
  const profile = useMemo(() => (profileRow.data ? parseProfile(profileRow.data.data) : null), [profileRow.data]);
  // Tipografías subidas por la marca: se cargan con FontFace antes de dibujar y se ofrecen las primeras.
  const brandFonts = useBrandFontFaces(brand.id);
  const brandFontFamilies = JSON.stringify(brandFonts.families);
  const brandStyle: BrandStyle = useMemo(
    () => ({
      palette: (profile?.visual.colors ?? []).map((c) => ({ hex: c.hex.toUpperCase(), name: c.name })),
      fonts: orderFontOptions(
        JSON.parse(brandFontFamilies) as string[],
        (profile?.visual.fonts ?? []).map((f) => f.family),
        [],
      ),
    }),
    [profile, brandFontFamilies],
  );
  const logoIds = profile?.visual.logoAssetIds ?? [];

  // ── Imágenes del documento: recurso → dirección firmada ──
  const assetIdsKey = assetIdsOf(state.document).join(',');
  const assetIds = useMemo(() => (assetIdsKey ? assetIdsKey.split(',') : []), [assetIdsKey]);
  const assets = useAssetsByIds(brand.id, assetIds);
  const storagePaths = useMemo(() => (assets.data ?? []).map((a) => a.storage_path).sort(), [assets.data]);
  const signed = useSignedUrls(storagePaths);
  const images = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of assets.data ?? []) {
      const url = signed.data?.get(asset.storage_path);
      if (url) map.set(asset.id, url);
    }
    return map;
  }, [assets.data, signed.data]);

  // La tira de páginas solo pinta miniaturas: firma las ligeras (el lienzo usa los originales).
  const stripPaths = useMemo(() => (assets.data ?? []).map(previewPath).sort(), [assets.data]);
  const stripSigned = useSignedUrls(stripPaths);
  const stripImages = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of assets.data ?? []) {
      const url = stripSigned.data?.get(previewPath(asset));
      if (url) map.set(asset.id, url);
    }
    return map;
  }, [assets.data, stripSigned.data]);

  // «Esta foto» para el copiloto: la imagen elegida en el lienzo, si la hay.
  const selectedImage = useMemo(() => {
    if (selected?.type !== 'image' || selected.source.kind !== 'asset') return null;
    const assetId = selected.source.assetId;
    const row = (assets.data ?? []).find((asset) => asset.id === assetId);
    return row ? { id: row.id, name: row.file_name, width: row.width, height: row.height } : null;
  }, [selected, assets.data]);

  // «Editar foto» de la capa elegida: el recurso de la biblioteca y su dirección.
  const editablePhoto = useMemo(() => {
    if (selected?.type !== 'image' || selected.source.kind !== 'asset') return null;
    const assetId = selected.source.assetId;
    const row = (assets.data ?? []).find((asset) => asset.id === assetId);
    return row && canEditPhoto(row) ? { layerId: selected.id, row, url: images.get(row.id) } : null;
  }, [selected, assets.data, images]);

  // Ediciones de foto de la capa elegida que crean una foto nueva (quitar el fondo…) y, si el
  // servidor tiene IA para ello, «Cambiar el fondo con IA». Sin IA configurada, ese botón no sale.
  const aiPhotoOptions = useAiEditOptions(brand.id, Boolean(editablePhoto) && canEditWithAi(editablePhoto!.row));
  const aiBackgroundAvailable = Boolean(aiPhotoOptions.data?.some((choice) => choice.operation === 'replace_background'));
  const photoTools: PhotoToolsContext | undefined = editablePhoto
    ? {
        row: editablePhoto.row,
        url: editablePhoto.url,
        onUseResult: (row, fit) =>
          dispatch({
            type: 'update',
            id: editablePhoto.layerId,
            patch: { source: { kind: 'asset', assetId: row.id }, fit },
          }),
        onAiBackground:
          aiBackgroundAvailable && editablePhoto.url
            ? () => {
                setPhotoEditTab('ai');
                setPhotoEditing(true);
              }
            : undefined,
      }
    : undefined;

  // Marca de contenido generado con IA: la calcula la base de datos al guardar
  // (`item.ai_generated`); aquí se adelanta con lo que hay en pantalla.
  const aiReasons = useMemo(() => aiContentReasons(state.document, assets.data ?? []), [state.document, assets.data]);
  const aiLabel = aiReasons.length > 0 || (!dirty && item.ai_generated === true);

  // Avisar antes de cerrar la pestaña con cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Escape sin foco en ningún campo (p. ej. tras pulsar en el panel): quita la selección.
  // Lo que llega desde un diálogo (portal) o desde un campo de texto no cuenta.
  const hasSelection = state.selectedIds.length > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target)) return;
      const target = event.target as Node | null;
      if (target !== document.body && !rootRef.current?.contains(target)) return;
      dispatch({ type: 'select', id: null });
      setPanel('layer');
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [hasSelection]);

  // El foco se pone en el siguiente fotograma: si a la vez cambia la pestaña, su
  // contenido se monta después de este efecto.
  useEffect(() => {
    if (!focusText) return;
    const frame = requestAnimationFrame(() => textRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusText]);

  useEffect(() => {
    if (!focusCopy) return;
    const frame = requestAnimationFrame(() => {
      const field = rootRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-testid="${focusCopy.field}"]`,
      );
      if (!field) return;
      field.focus();
      if (focusCopy.range) field.setSelectionRange(focusCopy.range.start, focusCopy.range.end);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusCopy]);

  // ── Paleta de la imagen principal, para el verificador ──
  const paletteLayer = mainImageLayer(page);
  const palette = useImagePalette(imageUrlOf(paletteLayer, images));
  // Tono medio de esa imagen: el copiloto lo usa para que los textos se lean encima.
  const paletteAssetId = paletteLayer?.source.kind === 'asset' ? paletteLayer.source.assetId : null;
  const imageTones = useMemo(() => {
    const tone = palette.status === 'ready' ? toneOfPalette(palette.palette) : null;
    return tone && paletteAssetId ? new Map([[paletteAssetId, tone]]) : undefined;
  }, [palette, paletteAssetId]);

  /** Al pulsar un hallazgo del verificador: elegir la capa o llevar al campo señalado. */
  function selectTarget(target: FindingTarget) {
    if (target.part === 'textLayer' && target.layerId) {
      dispatch({ type: 'select', id: target.layerId, exact: true });
      setPanel('layer');
      setFocusText((n) => n + 1);
      return;
    }
    if (target.part === 'image' && paletteLayer) {
      dispatch({ type: 'select', id: paletteLayer.id });
      setPanel('layer');
      return;
    }
    const field = COPY_FIELD[target.part];
    if (field) {
      setPanel('copy');
      setFocusCopy((prev) => ({ field, range: target.range, n: (prev?.n ?? 0) + 1 }));
    }
  }

  // ── Lienzo (el envoltorio guarda estas funciones en una referencia: no hace falta memorizarlas) ──
  /** Quita la selección y enseña las opciones del documento (proporción, fondo) en el panel «Diseño». */
  const deselect = () => {
    dispatch({ type: 'select', id: null });
    setPanel('layer');
  };
  const onSelect: CanvasViewProps['onSelect'] = (id, options) =>
    id === null ? deselect() : dispatch({ type: 'select', id, toggle: options?.toggle });
  const onSelectMany: CanvasViewProps['onSelectMany'] = (ids, additive) =>
    dispatch({ type: 'selectMany', ids, additive });
  const onChange: CanvasViewProps['onChange'] = (changes) => dispatch({ type: 'updateMany', changes });
  /** Doble clic o Intro en un texto: se escribe encima del lienzo. Sin permiso de edición, se enseña su campo. */
  const onEditText = (id: string) => {
    dispatch({ type: 'select', id, exact: true });
    setPanel('layer');
    if (readOnly) setFocusText((n) => n + 1);
    else setEditingTextId(id);
  };
  const onTextCommit: CanvasViewProps['onTextCommit'] = (id, text) => {
    setEditingTextId(null);
    const layer = layers.find((l) => l.id === id);
    if (layer?.type === 'text' && layer.text !== text) dispatch({ type: 'update', id, patch: { text } });
    // El foco vuelve al lienzo, para seguir con el teclado.
    canvasRef.current?.focus();
  };
  const onTextCancel = () => {
    setEditingTextId(null);
    canvasRef.current?.focus();
  };

  // ── Teclado: deshacer, rehacer, guardar y, con una capa elegida, mover, borrar y soltar ──
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Lo que llega desde un diálogo (portal) no es del editor.
    if (!rootRef.current?.contains(event.target as Node)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && (key === 'z' || key === 'y')) {
      if (readOnly) return;
      event.preventDefault();
      dispatch({ type: key === 'y' || event.shiftKey ? 'redo' : 'undo' });
      return;
    }
    if (mod && key === 's') {
      event.preventDefault();
      if (!readOnly) setSaveOpen(true);
      return;
    }
    if (isTypingTarget(event.target)) return;
    if (mod && key === 'g') {
      event.preventDefault();
      if (!readOnly) dispatch({ type: event.shiftKey ? 'ungroup' : 'group' });
      return;
    }
    if (state.selectedIds.length === 0) return;
    if (event.key === 'Escape') {
      deselect();
      return;
    }
    if (readOnly) return;
    // Intro con un texto elegido, desde el lienzo: escribir encima (lo mismo que el doble clic).
    if (event.key === 'Enter' && event.target === canvasRef.current && selected?.type === 'text' && !selected.locked) {
      event.preventDefault();
      onEditText(selected.id);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      dispatch({ type: 'removeSelection' });
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      dispatch({ type: 'nudgeSelection', dx: move[0], dy: move[1] });
    }
  }

  // ── Guardar, restaurar y estados ──
  function handleConflictOr(error: unknown) {
    if (isVersionConflict(error)) {
      setConflict(true);
      toast.error('Otra persona guardó una versión más reciente. Tus cambios siguen aquí.');
    } else {
      toast.error(translateError(error));
    }
  }

  /** Guarda una versión nueva. Devuelve su número, o null si no se ha podido guardar (ya se ha avisado). */
  function save(note: string, expected = expectedVersion): Promise<number | null> {
    const document = state.document;
    setSaveIssues([]);
    return mutations.saveVersion.mutateAsync({ contentId, document, note, expectedVersion: expected }).then(
      (row) => {
        setBaseline(JSON.stringify(document));
        setExpectedVersion(row.version);
        setConflict(false);
        setSaveOpen(false);
        toast.success(`Versión ${row.version} guardada`);
        return row.version;
      },
      (error: unknown) => {
        if (error instanceof DocumentError) {
          setSaveIssues(error.issues.length ? error.issues : [{ path: '', message: error.message }]);
          return null;
        }
        setSaveOpen(false);
        handleConflictOr(error);
        return null;
      },
    );
  }

  /** Tras un conflicto: guardar lo mío encima de la última versión (la otra sigue en el historial). */
  async function saveOverLatest() {
    try {
      const fresh = await fetchContent(contentId);
      await save('', fresh.item.current_version);
    } catch (error) {
      toast.error(translateError(error));
    }
  }

  /** Tras un conflicto: descartar lo mío y abrir la última versión guardada. */
  async function loadLatest() {
    try {
      const fresh = await fetchContent(contentId);
      const document = fresh.current?.document ?? startingDocument(spec);
      dispatch({ type: 'load', document });
      setBaseline(JSON.stringify(document));
      setExpectedVersion(fresh.item.current_version);
      setConflict(false);
      toast.success('Abierta la última versión');
    } catch (error) {
      toast.error(translateError(error));
    }
  }

  function restore(version: LoadedVersion) {
    const document = version.document;
    if (!document) return;
    setPendingRestore(null);
    mutations.restore
      .mutateAsync({
        contentId,
        version: version.row.version,
        note: `Restaurada la versión ${version.row.version}`,
        expectedVersion,
      })
      .then(
        (row) => {
          dispatch({ type: 'load', document });
          setBaseline(JSON.stringify(document));
          setExpectedVersion(row.version);
          setHistoryOpen(false);
          toast.success(`Versión ${version.row.version} restaurada como versión ${row.version}`);
        },
        (error: unknown) => {
          setHistoryOpen(false);
          handleConflictOr(error);
        },
      );
  }

  function changeStatus(to: ContentStatus) {
    setBusyStatus(to);
    mutations.setStatus
      .mutateAsync({ contentId, status: to, expectedVersion })
      .then(
        () => toast.success(statusChangedMessage(to)),
        (error: unknown) => handleConflictOr(error),
      )
      .finally(() => setBusyStatus(null));
  }

  function toggleArchive() {
    const archived = !item.archived_at;
    mutations.archive.mutateAsync({ contentId, archived }).then(
      () => {
        setConfirmArchive(false);
        toast.success(archived ? 'Contenido archivado' : 'Contenido recuperado');
      },
      (error: unknown) => {
        setConfirmArchive(false);
        toast.error(translateError(error));
      },
    );
  }

  /** Renombrar la pieza o cambiar su red y formato. Devuelve el mensaje de error, o null si ha ido bien. */
  async function saveSettings(changes: { title?: string; target?: { network: string; format: string } }) {
    try {
      const row = await mutations.update.mutateAsync({ contentId, ...changes });
      setSettingsOpen(false);
      const backToDraft = changes.target && item.status === 'approved' && row.status === 'draft';
      toast.success(backToDraft ? 'Guardado. Ha vuelto a borrador: hay que aprobarla otra vez.' : 'Guardado');
      return null;
    } catch (error) {
      return translateError(error);
    }
  }

  function leave(event: MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return;
    event.preventDefault();
    setConfirmLeave(true);
  }

  const canvas = state.document.canvas;
  const full = layers.length >= MAX_LAYERS;
  const actions = statusActions(item, { edit: canEdit, approve: canApprove });
  const allowed = spec ? allowedCanvasRatios(spec, spec.media.includes('image') ? 'image' : spec.media[0]) : null;
  const publishingOn = useFeature('publishing');
  const canPublishNow =
    publishingOn &&
    canEdit &&
    !item.archived_at &&
    item.status === 'approved' &&
    PUBLISHABLE_TARGETS.has(`${item.network}:${item.format}`);
  const BrandCheck = BRAND_CHECK_PANEL;
  const videoOnly = spec !== undefined && !spec.media.includes('image');
  const canSchedule = publishingOn && canEdit && !item.archived_at && item.status === 'approved';
  const primary = editorPrimaryAction(item, actions, {
    edit: canEdit,
    publishNow: canPublishNow,
    schedule: canSchedule,
  });

  /** Por qué no se puede cambiar de estado ahora (o undefined si se puede). */
  const statusBlocked = (action: StatusAction) =>
    dirty
      ? 'Guarda los cambios antes'
      : action.needsVersion && expectedVersion === 0
        ? 'Hace falta guardar una versión antes'
        : undefined;

  const primaryButton = (() => {
    if (!primary) return null;
    switch (primary.kind) {
      case 'restore':
        return (
          <Button size="sm" onClick={toggleArchive} loading={mutations.archive.isPending} data-testid="editor-archive">
            <ArchiveRestore className="h-4 w-4" aria-hidden />
            Recuperar
          </Button>
        );
      case 'publishNow':
        return (
          <Button
            size="sm"
            disabled={dirty || busyStatus !== null}
            title={dirty ? 'Guarda los cambios antes' : 'Pide confirmación antes de publicar'}
            onClick={() => setPublishNowOpen(true)}
            data-testid="editor-publish-now"
          >
            <Send className="h-4 w-4" aria-hidden />
            Publicar ahora
          </Button>
        );
      case 'schedule':
        return (
          <Button size="sm" disabled={dirty} onClick={() => setScheduleOpen(true)} data-testid="editor-schedule">
            <CalendarPlus className="h-4 w-4" aria-hidden />
            Programar
          </Button>
        );
      case 'status': {
        const { action } = primary;
        const blocked = statusBlocked(action);
        return (
          <Button
            size="sm"
            disabled={Boolean(blocked) || busyStatus !== null}
            loading={busyStatus === action.to}
            title={blocked}
            onClick={() => changeStatus(action.to)}
            data-testid={`status-${action.to}`}
          >
            {action.to === 'approved' ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden />
            ) : (
              <SendHorizontal className="h-4 w-4" aria-hidden />
            )}
            {action.label}
          </Button>
        );
      }
    }
  })();

  // Lo que no es la acción principal, en «⋯», por grupos: ver, avanzar, ajustar y, al final, lo que deshace.
  const primaryStatus = primary?.kind === 'status' ? primary.action.to : null;
  const forward = actions.filter((a) => a.to !== primaryStatus && FORWARD_STATUSES.has(a.to));
  const backward = actions.filter((a) => a.to !== primaryStatus && !FORWARD_STATUSES.has(a.to));
  const statusItem = (action: StatusAction): MoreAction => {
    const blocked = statusBlocked(action);
    return {
      id: `status-${action.to}`,
      label: action.label,
      icon: FORWARD_STATUSES.has(action.to) ? SendHorizontal : Undo2,
      onSelect: () => changeStatus(action.to),
      disabled: Boolean(blocked) || busyStatus !== null,
      hint: blocked,
      testId: `status-${action.to}`,
    };
  };
  const when = <T,>(condition: boolean, item: T): T[] => (condition ? [item] : []);
  const moreActions: MoreMenuItem[] = [
    {
      id: 'preview',
      label: 'Vista previa',
      icon: ScanEye,
      onSelect: () => setPreviewOpen(true),
      testId: 'editor-preview',
    },
    {
      id: 'history',
      label: 'Historial',
      icon: History,
      onSelect: () => setHistoryOpen(true),
      testId: 'editor-history',
    },
    {
      id: 'export',
      label: 'Exportar imagen',
      icon: Download,
      onSelect: () => setExportOpen(true),
      testId: 'editor-export',
    },
    null,
    ...forward.map(statusItem),
    ...when<MoreAction>(canPublishNow && primary?.kind !== 'publishNow', {
      id: 'publish-now',
      label: 'Publicar ahora',
      icon: Send,
      onSelect: () => setPublishNowOpen(true),
      disabled: dirty || busyStatus !== null,
      hint: dirty ? 'Guarda los cambios antes' : undefined,
      testId: 'editor-publish-now',
    }),
    ...when<MoreAction>(canSchedule && primary?.kind !== 'schedule', {
      id: 'schedule',
      label: 'Programar',
      icon: CalendarPlus,
      onSelect: () => setScheduleOpen(true),
      disabled: dirty,
      hint: dirty ? 'Guarda los cambios antes' : undefined,
      testId: 'editor-schedule',
    }),
    null,
    ...when<MoreAction>(canEdit && !item.archived_at, {
      id: 'settings',
      label: 'Nombre y red',
      icon: PencilLine,
      onSelect: () => setSettingsOpen(true),
      hint: 'Cambiar el nombre, la red o el formato',
      testId: 'editor-settings',
    }),
    ...when<MoreAction>(!readOnly, {
      id: 'template',
      label: 'Desde una plantilla',
      icon: LayoutTemplate,
      onSelect: () => setTemplateOpen(true),
      hint: 'Sustituir el diseño por una plantilla de la marca',
      testId: 'editor-from-template',
    }),
    null,
    ...backward.map(statusItem),
    ...when<MoreAction>(canEdit && !item.archived_at, {
      id: 'archive',
      label: 'Archivar',
      icon: Archive,
      onSelect: () => setConfirmArchive(true),
      destructive: true,
      testId: 'editor-archive',
    }),
  ];

  if (unreadable) {
    return (
      <div className="space-y-4">
        <Link to={paths.list} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Contenidos
        </Link>
        <h1 className="text-2xl">{item.title}</h1>
        <Notice tone="warning">
          No se puede abrir la versión vigente: {unreadable.documentError} Puedes restaurar otra desde el historial.
        </Notice>
        <Button variant="secondary" onClick={() => setHistoryOpen(true)}>
          <History className="h-4 w-4" aria-hidden />
          Historial
        </Button>
        <VersionsDialog
          brandId={brand.id}
          contentId={contentId}
          currentVersion={expectedVersion}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          canRestore={canEdit && !item.archived_at}
          restoring={mutations.restore.isPending}
          images={images}
          onRestore={(version) => {
            mutations.restore
              .mutateAsync({ contentId, version: version.row.version, expectedVersion })
              .then(onReopen, handleConflictOr);
          }}
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="flex flex-col gap-3 lg:h-[calc(100dvh-6rem)]">
      {/* Cabecera: dónde estoy, estado y UNA acción principal; lo demás, en «⋯» */}
      <PageHeader
        compact
        back={
          <Link
            to={paths.list}
            onClick={leave}
            className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
            data-testid="editor-back"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Contenidos
          </Link>
        }
        title={item.title}
        titleTestId="editor-title"
        meta={
          <>
            <span>{targetLabel(item.network, item.format)}</span>
            <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
            {item.archived_at && <Badge tone="warning">Archivada</Badge>}
            {aiLabel && (
              <span
                title={describeAiReasons(aiReasons) || 'Lleva contenido generado con IA.'}
                data-testid="editor-ai-label"
              >
                <Badge tone="primary">Generado con IA</Badge>
              </span>
            )}
            <ContentRequestOrigin item={item} />
            <span data-testid="editor-version">
              {expectedVersion > 0 ? `Versión ${expectedVersion}` : 'Sin guardar todavía'}
            </span>
            {dirty && (
              <span className="font-medium text-warning" data-testid="editor-dirty">
                · Cambios sin guardar
              </span>
            )}
          </>
        }
        secondary={
          !readOnly && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSaveOpen(true)}
              disabled={!dirty && expectedVersion > 0}
              title={!dirty && expectedVersion > 0 ? 'No hay cambios que guardar' : undefined}
              data-testid="editor-save"
            >
              <Save className="h-4 w-4" aria-hidden />
              Guardar<span className="max-sm:sr-only"> versión</span>
            </Button>
          )
        }
        action={primaryButton}
        more={moreActions}
        moreLabel="Más acciones de la pieza"
        moreTestId="editor-more"
      />

      {conflict && (
        <div
          role="alert"
          className="rounded-lg bg-warning-soft px-3.5 py-3 text-sm text-warning"
          data-testid="editor-conflict"
        >
          <p className="font-medium">Otra persona ha guardado una versión más reciente mientras editabas.</p>
          <p>Tus cambios siguen aquí, sin guardar. Elige qué hacer:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void saveOverLatest()}
              loading={mutations.saveVersion.isPending}
              data-testid="conflict-save-mine"
            >
              Guardar la mía como versión nueva
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void loadLatest()} data-testid="conflict-load-latest">
              Descartar mis cambios y abrir la última
            </Button>
          </div>
          <p className="mt-2 text-xs">
            La versión de la otra persona no se pierde en ningún caso: queda en el historial.
          </p>
        </div>
      )}
      {item.archived_at && (
        <Notice tone="warning">Está archivada: se puede ver, pero no cambiar hasta recuperarla.</Notice>
      )}
      {!canEdit && (
        <Notice>
          {canApprove
            ? 'Puedes revisarla y cambiar su estado, pero no editarla.'
            : `Solo lectura: con tu rol (${role === 'viewer' ? 'solo lectura' : role}) no se puede editar.`}
        </Notice>
      )}
      {videoOnly && (
        <Notice>
          Es un formato de vídeo. Aquí se prepara la imagen (portada o fotograma); el vídeo llegará más adelante.
        </Notice>
      )}

      {/* Barra de herramientas */}
      {!readOnly && (
        <div
          className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0 [&>*]:shrink-0"
          role="toolbar"
          aria-label="Herramientas del editor"
        >
          <span className="mr-1 text-xs font-medium text-muted">Añadir</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={full}
            onClick={() =>
              dispatch({
                type: 'add',
                layer: newTextLayer(canvas, everyLayer, {
                  fontFamily: brandStyle.fonts[0],
                  color: brandStyle.palette[0]?.hex,
                }),
              })
            }
            data-testid="add-text"
          >
            <Type className="h-4 w-4" aria-hidden />
            Texto
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={full}
            onClick={() => setImagePicker(true)}
            data-testid="add-image"
          >
            <ImageIcon className="h-4 w-4" aria-hidden />
            Imagen
          </Button>
          {aiImage && (
            <Button
              variant="secondary"
              size="sm"
              disabled={full}
              onClick={() => setImageAi(true)}
              data-testid="add-image-ai"
              title="Generar una imagen con IA"
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              Con IA
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={full}
            onClick={() => setLogoPicker(true)}
            data-testid="add-logo"
          >
            <Stamp className="h-4 w-4" aria-hidden />
            Logotipo
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={full}
            onClick={() =>
              dispatch({
                type: 'add',
                layer: newShapeLayer(canvas, everyLayer, 'rectangle', brandStyle.palette[1]?.hex),
              })
            }
            data-testid="add-rectangle"
          >
            <Square className="h-4 w-4" aria-hidden />
            Rectángulo
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={full}
            onClick={() =>
              dispatch({
                type: 'add',
                layer: newShapeLayer(canvas, everyLayer, 'ellipse', brandStyle.palette[1]?.hex),
              })
            }
            data-testid="add-ellipse"
          >
            <Circle className="h-4 w-4" aria-hidden />
            Elipse
          </Button>
          <AddStickerSelect
            disabled={full}
            onAdd={(shape) =>
              dispatch({
                type: 'add',
                layer: newShapeLayer(canvas, everyLayer, shape, brandStyle.palette[1]?.hex),
              })
            }
          />
          {voiceCopilot && (
            <Button
              variant={copilotOpen ? 'primary' : 'secondary'}
              size="sm"
              aria-pressed={copilotOpen}
              onClick={() => setCopilotOpen((open) => !open)}
              data-testid="copilot-open"
              title="Monta el diseño hablando: foto de fondo, logotipo y textos"
            >
              <Mic className="h-4 w-4" aria-hidden />
              Dictar
            </Button>
          )}
          <span className="mx-1 h-6 w-px bg-border" aria-hidden />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Deshacer"
            title="Deshacer (Ctrl+Z)"
            disabled={state.past.length === 0}
            onClick={() => dispatch({ type: 'undo' })}
            data-testid="undo"
          >
            <Undo2 className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Rehacer"
            title="Rehacer (Ctrl+Mayús+Z)"
            disabled={state.future.length === 0}
            onClick={() => dispatch({ type: 'redo' })}
            data-testid="redo"
          >
            <Redo2 className="h-4 w-4" aria-hidden />
          </Button>
          {full && (
            <span className="text-xs text-muted">
              Has llegado al máximo de {MAX_LAYERS} capas{state.document.pages.length > 1 ? ' en esta página' : ''}.
            </span>
          )}
        </div>
      )}
      {!readOnly && voiceCopilot && copilotOpen && (
        <Suspense fallback={<Spinner label="Preparando el copiloto…" />}>
          <VoiceCopilot
            orgId={org.id}
            brandId={brand.id}
            document={state.document}
            pageIndex={pageIndex}
            brand={{
              palette: (profile?.visual.colors ?? []).map((c) => ({ hex: c.hex.toUpperCase(), role: c.role })),
              fonts: brandStyle.fonts,
            }}
            imageTones={imageTones}
            logoIds={logoIds}
            selectedImage={selectedImage}
            libraryPath={`${brandBase}/biblioteca`}
            onApply={(document, touched) => {
              // Una orden dictada = un paso de deshacer.
              dispatch({ type: 'replace', document, select: touched });
              setPanel('layer');
            }}
            onClose={() => setCopilotOpen(false)}
          />
        </Suspense>
      )}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section
          ref={canvasRef}
          tabIndex={0}
          // Un clic en el margen del lienzo (fuera del documento) quita la selección.
          onPointerDown={(event) => event.target === event.currentTarget && deselect()}
          aria-label="Lienzo. Con capas elegidas, usa las flechas para moverlas y Supr para borrarlas; con un texto elegido, Intro para escribir en él."
          className="flex h-[55dvh] min-h-[16rem] flex-col rounded-xl bg-subtle p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary lg:h-auto"
        >
          {safeZone && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="safe-zone-bar">
              <Button
                variant={showSafeZone ? 'primary' : 'secondary'}
                size="sm"
                aria-pressed={showSafeZone}
                onClick={() => setShowSafeZone((on) => !on)}
                data-testid="safe-zone-toggle"
              >
                <ShieldAlert className="h-4 w-4" aria-hidden />
                Zonas seguras
              </Button>
              {showSafeZone && (
                <span data-testid="safe-zone-note">
                  En rojo, lo que puede tapar la interfaz de {networkLabel(item.network)}.
                  {safeZone.provenance === 'unverified' ? ' Orientativo: la red no publica la cifra.' : ''}
                </span>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1" onPointerDown={(event) => event.target === event.currentTarget && deselect()}>
            {brandFonts.status === 'loading' ? (
              <Spinner label="Cargando las tipografías de la marca…" />
            ) : (
              <Suspense fallback={<Spinner label="Preparando el lienzo…" />}>
                <CanvasView
                  document={page}
                  selectedIds={state.selectedIds}
                  readOnly={readOnly}
                  images={images}
                  onSelect={onSelect}
                  onSelectMany={onSelectMany}
                  onChange={onChange}
                  onEditText={onEditText}
                  editingTextId={editingTextId}
                  onTextCommit={onTextCommit}
                  onTextCancel={onTextCancel}
                  safeZone={safeZoneOverlay}
                  label={
                    state.document.pages.length > 1
                      ? `Diseño de ${item.title}, página ${pageIndex + 1} de ${state.document.pages.length}, ${layers.length} capas`
                      : `Diseño de ${item.title}, ${layers.length} capas`
                  }
                />
              </Suspense>
            )}
          </div>
          {showPages && (
            <PageStrip
              document={state.document}
              activePageId={state.activePageId}
              limits={pageRange}
              readOnly={readOnly}
              images={stripImages}
              dispatch={dispatch}
            />
          )}
        </section>

        <aside
          className="min-h-0 overflow-y-auto rounded-xl border border-border bg-surface p-4"
          aria-label="Paneles del editor"
        >
          <Tabs value={panel} onValueChange={setPanel}>
            <TabsList label="Paneles del editor">
              <TabsTrigger value="layer">Diseño</TabsTrigger>
              <TabsTrigger value="layers">Capas ({layers.length})</TabsTrigger>
              <TabsTrigger value="copy">Publicación</TabsTrigger>
              {BrandCheck && <TabsTrigger value="brand">Marca</TabsTrigger>}
            </TabsList>
            <TabsContent value="layer" className="space-y-5 pt-4">
              {selectedLayers.length > 1 ? (
                readOnly ? (
                  <p className="text-sm text-muted">{selectedLayers.length} capas elegidas.</p>
                ) : (
                  <MultiSelectionPanel layers={selectedLayers} dispatch={dispatch} />
                )
              ) : (
                <>
                  <PropertiesPanel
                    layer={selected}
                    canvas={canvas}
                    readOnly={readOnly}
                    dispatch={dispatch}
                    brandStyle={brandStyle}
                    allowedRatios={allowed?.ratios ?? null}
                    textRef={textRef}
                    onEditPhoto={
                      editablePhoto?.url
                        ? () => {
                            setPhotoEditTab('enhance');
                            setPhotoEditing(true);
                          }
                        : undefined
                    }
                    photoTools={photoTools}
                  />
                  {selected && !readOnly && !selected.locked && (
                    <ArrangeControls layers={[selected]} dispatch={dispatch} />
                  )}
                </>
              )}
            </TabsContent>
            <TabsContent value="layers" className="pt-4">
              <LayersPanel layers={layers} selectedIds={state.selectedIds} readOnly={readOnly} dispatch={dispatch} />
            </TabsContent>
            <TabsContent value="copy" className="space-y-4 pt-4">
              <AskAgencyButton item={item} />
              {aiEnabled && !readOnly && (
                <GenerateCaptionDialog
                  brandId={brand.id}
                  network={item.network}
                  format={item.format}
                  currentCopy={state.document.copy}
                  // Un solo paso de deshacer: el texto anterior vuelve con Ctrl+Z.
                  onApply={(copy) => {
                    // Marca de contenido generado con IA (ver content/aiLabel.ts).
                    dispatch({ type: 'setCopy', patch: { ...copy, aiGenerated: true } });
                    toast.success('Texto aplicado. Puedes deshacerlo con Ctrl+Z.');
                  }}
                />
              )}
              <CopyPanel
                copy={state.document.copy}
                spec={spec}
                networkName={networkLabel(item.network)}
                readOnly={readOnly}
                dispatch={dispatch}
              />
            </TabsContent>
            {BrandCheck && (
              <TabsContent value="brand" className="pt-4">
                <Suspense fallback={<Spinner label="Cargando el verificador…" />}>
                  <BrandCheck
                    document={state.document}
                    network={item.network}
                    format={item.format}
                    brandId={brand.id}
                    imagePalette={palette.status === 'ready' ? palette.palette : undefined}
                    onSelectTarget={selectTarget}
                  />
                </Suspense>
                {palette.status === 'unavailable' && (
                  <div className="mt-3" data-testid="brandcheck-palette-unavailable">
                    <Notice tone="warning">
                      No se han podido leer los colores de la imagen (el navegador no lo permite para este archivo): la
                      comparación con la paleta de la marca se omite.
                    </Notice>
                  </div>
                )}
                {aiEnabled && (
                  <div className="mt-6 space-y-2 border-t border-border pt-4">
                    <h2 className="text-base font-semibold">Tono con IA</h2>
                    <p className="text-xs text-muted">
                      Revisa el tono y los temas vetados del texto de la publicación. Ayuda a revisar; no aprueba.
                    </p>
                    <AiBrandCheck
                      brandId={brand.id}
                      text={publishedText(state.document.copy.caption, state.document.copy.hashtags)}
                    />
                  </div>
                )}
              </TabsContent>
            )}
          </Tabs>
        </aside>
      </div>

      {previewOpen && (
        <NetworkPreviewDialog
          open
          onOpenChange={setPreviewOpen}
          document={state.document}
          images={images}
          spec={spec}
          targetName={targetLabel(item.network, item.format)}
          accountName={brand.name}
        />
      )}
      {settingsOpen && (
        <PieceSettingsDialog
          open
          onOpenChange={setSettingsOpen}
          current={{ title: item.title, network: item.network, format: item.format }}
          status={item.status}
          canvasRatio={canvas.aspectRatio}
          saving={mutations.update.isPending}
          onSave={saveSettings}
        />
      )}
      <SaveVersionDialog
        open={saveOpen}
        onOpenChange={(open) => {
          setSaveOpen(open);
          if (!open) setSaveIssues([]);
        }}
        saving={mutations.saveVersion.isPending}
        issues={saveIssues}
        onSave={(note) => void save(note)}
      />
      {canSchedule && scheduleOpen && (
        <ScheduleDialog brandId={brand.id} open onOpenChange={setScheduleOpen} initialContentId={contentId} />
      )}
      {canPublishNow && (
        <PublishNowDialog
          brandId={brand.id}
          open={publishNowOpen}
          onOpenChange={setPublishNowOpen}
          contentId={contentId}
          exportVersion={
            (item.format === 'post' || item.format === 'carousel') && !dirty
              ? () =>
                  exportForPublishing({
                    document: state.document,
                    images,
                    title: item.title,
                    contentId,
                    orgId: org.id,
                    brandId: brand.id,
                    version: expectedVersion,
                    prepareFonts: () => loadBrandFonts(brandFonts.fonts).then(() => undefined),
                  })
              : undefined
          }
        />
      )}
      <ExportImageDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        document={state.document}
        images={images}
        title={item.title}
        contentId={contentId}
        orgId={org.id}
        brandId={brand.id}
        version={expectedVersion}
        dirty={dirty}
        canSaveToLibrary={canEdit}
        canSaveVersion={!readOnly}
        onSaveVersion={(note) => save(note)}
        prepareFonts={() => loadBrandFonts(brandFonts.fonts).then(() => undefined)}
        libraryPath={`${brandBase}/biblioteca`}
      />
      <VersionsDialog
        brandId={brand.id}
        contentId={contentId}
        currentVersion={expectedVersion}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        canRestore={!readOnly}
        restoring={mutations.restore.isPending}
        images={images}
        onRestore={(version) => (dirty ? setPendingRestore(version) : restore(version))}
      />
      {!readOnly && (
        <ApplyTemplateDialog
          orgId={org.id}
          brandId={brand.id}
          open={templateOpen}
          onOpenChange={setTemplateOpen}
          target={{ network: item.network, format: item.format }}
          hasDesign={allLayers(state.document).length > 0}
          onApply={(document, template) => {
            dispatch({ type: 'replace', document });
            toast.success(`Plantilla «${template.name}» aplicada. Sustituye las fotos y ajusta el texto.`);
          }}
        />
      )}
      {!readOnly && (
        <>
          <ImagePickerDialog
            brandId={brand.id}
            libraryPath={`${brandBase}/biblioteca`}
            open={imagePicker}
            onOpenChange={setImagePicker}
            onPick={(asset) => {
              setImagePicker(false);
              dispatch({
                type: 'add',
                layer: newImageLayer(canvas, everyLayer, { id: asset.id, name: asset.file_name }),
              });
            }}
          />
          {aiImage && (
            <GenerateImageDialog
              brandId={brand.id}
              open={imageAi}
              onOpenChange={setImageAi}
              canvasRatio={canvas.aspectRatio}
              // Una capa más: se deshace con Ctrl+Z como cualquier otra; la imagen queda en la biblioteca.
              onGenerated={(image) => {
                setImageAi(false);
                dispatch({ type: 'add', layer: newImageLayer(canvas, everyLayer, image) });
                toast.success('Imagen generada y añadida al diseño. Está también en la biblioteca.');
              }}
            />
          )}
          {photoEditing && editablePhoto && (
            <PhotoEditDialog
              initialTab={photoEditTab}
              asset={editablePhoto.row}
              url={editablePhoto.url}
              open
              onOpenChange={setPhotoEditing}
              resultLabel="Usar en el diseño"
              // Cambia la imagen de la capa por la editada (se deshace con Ctrl+Z); la original sigue en la biblioteca.
              onResult={(row) => {
                dispatch({
                  type: 'update',
                  id: editablePhoto.layerId,
                  patch: { source: { kind: 'asset', assetId: row.id } },
                });
                setPhotoEditing(false);
                toast.success('La capa usa ahora la foto editada. La original sigue en la biblioteca.');
              }}
            />
          )}
          <LogoPickerDialog
            brandId={brand.id}
            logoIds={logoIds}
            profilePath={`${brandBase}/marca`}
            open={logoPicker}
            onOpenChange={setLogoPicker}
            onPick={(asset) => {
              setLogoPicker(false);
              dispatch({
                type: 'add',
                layer: newLogoLayer(canvas, everyLayer, {
                  id: asset.id,
                  name: asset.file_name,
                  width: asset.width,
                  height: asset.height,
                }),
              });
            }}
          />
        </>
      )}
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`¿Archivar «${item.title}»?`}
        description="No se borra: queda en «Archivadas», con su historial, y se puede recuperar."
        confirmLabel="Archivar"
        loading={mutations.archive.isPending}
        onConfirm={toggleArchive}
      />
      <ConfirmDialog
        open={pendingRestore !== null}
        onOpenChange={(open) => !open && setPendingRestore(null)}
        title="¿Restaurar y descartar tus cambios?"
        description="Tienes cambios sin guardar que se perderán. La versión restaurada se guarda como versión nueva."
        confirmLabel="Restaurar"
        loading={mutations.restore.isPending}
        onConfirm={() => pendingRestore && restore(pendingRestore)}
      />
      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="¿Salir sin guardar?"
        description="Los cambios que no has guardado como versión se perderán."
        confirmLabel="Salir sin guardar"
        onConfirm={() => {
          setConfirmLeave(false);
          navigate(paths.list);
        }}
      />
    </div>
  );
}
