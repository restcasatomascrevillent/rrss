import { CheckCircle2, ImagePlus, Loader2, Mic, MicOff, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { AiErrorNotice } from '@/features/ai/AiErrorNotice';
import { requestEditorCopilot, toAiError } from '@/features/ai/api';
import { useAssetsByIds } from '@/features/library/api';
import { pageView, type ContentDocument } from '../document';
import { ImagePickerDialog } from '../editor/AssetPickerDialog';
import {
  applyCopilotOperations,
  needsPhotoPick,
  withPickedPhoto,
  type CopilotAssetInfo,
  type CopilotBrandStyle,
} from './apply';
import { keepDictated, parseCopilotResponse, summarizeDocument } from './operations';
import { useDictation } from './speech';

// Copiloto por voz del editor (docs/copiloto-voz.md). La persona dicta; cada
// frase terminada es una ORDEN que se manda a la IA (`editor.copilot`), y sus
// operaciones, ya validadas, se aplican al documento como un solo paso de
// deshacer. Las órdenes van de una en una y en el orden en que se dicen, cada
// una sobre el documento que dejó la anterior.

type OrderStatus = 'pending' | 'sending' | 'photo' | 'applied' | 'nothing' | 'failed';

interface Order {
  id: number;
  transcript: string;
  status: OrderStatus;
  changes?: string[];
  notes?: string[];
  error?: unknown;
}

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'En espera',
  sending: 'Interpretando…',
  photo: 'Elige la foto',
  applied: 'Aplicada',
  nothing: 'Sin cambios',
  failed: 'No aplicada',
};

export interface VoiceCopilotProps {
  orgId: string;
  brandId: string;
  document: ContentDocument;
  /** Página activa del editor: el copiloto solo ve y cambia esa página. */
  pageIndex: number;
  brand: CopilotBrandStyle;
  logoIds: string[];
  /** Tono medio de las fotos ya analizadas, por id de recurso (para que los textos se lean encima). */
  imageTones?: ReadonlyMap<string, string>;
  /** La foto elegida en el lienzo, si la hay: cuenta como «esta foto». */
  selectedImage: CopilotAssetInfo | null;
  libraryPath: string;
  /** Aplica el documento nuevo como un paso de deshacer y deja elegidas las capas tocadas. */
  onApply: (document: ContentDocument, touched: string[]) => void;
  onClose: () => void;
}

let orderCounter = 0;

export function VoiceCopilot({
  orgId,
  brandId,
  document,
  pageIndex,
  brand,
  logoIds,
  imageTones,
  selectedImage,
  libraryPath,
  onApply,
  onClose,
}: VoiceCopilotProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [photos, setPhotos] = useState<CopilotAssetInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const logos = useAssetsByIds(brandId, logoIds);

  // Lo último de cada cosa, para las órdenes que se procesan en cola (fuera del ciclo de React).
  const latest = useRef({ document, pageIndex, photos, selectedImage, brand, logoIds, imageTones, logos: logos.data ?? [], onApply });
  useEffect(() => {
    latest.current = { document, pageIndex, photos, selectedImage, brand, logoIds, imageTones, logos: logos.data ?? [], onApply };
  });
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** Quien espera a que la persona elija una foto («esta foto» sin ninguna elegida). */
  const waitingPhoto = useRef<((asset: CopilotAssetInfo | null) => void) | null>(null);

  const update = (id: number, change: Partial<Order>) =>
    setOrders((list) => list.map((order) => (order.id === id ? { ...order, ...change } : order)));

  const askPhoto = () =>
    new Promise<CopilotAssetInfo | null>((resolve) => {
      waitingPhoto.current = resolve;
      setPickerOpen(true);
    });

  async function process(order: Order) {
    update(order.id, { status: 'sending' });
    const now = latest.current;
    // «Esta foto»: la elegida en el lienzo y, después, las elegidas para el copiloto.
    const chosen = [...(now.selectedImage ? [now.selectedImage] : []), ...now.photos].filter(
      (asset, index, all) => all.findIndex((a) => a.id === asset.id) === index,
    );
    try {
      const raw = await requestEditorCopilot(brandId, {
        transcript: order.transcript,
        document: summarizeDocument(pageView(now.document, now.pageIndex)),
        assets: chosen.map((asset) => ({ id: asset.id, name: asset.name })),
      });
      const response = parseCopilotResponse(raw);
      if (!response) {
        update(order.id, { status: 'failed', notes: ['La respuesta de la IA no es válida: no se ha cambiado nada.'] });
        return;
      }
      const dictated = keepDictated(response.operations, order.transcript);
      let operations = dictated.operations;
      let photo: CopilotAssetInfo | null = chosen[0] ?? null;
      if (needsPhotoPick(operations) && !photo) {
        update(order.id, { status: 'photo' });
        photo = await askPhoto();
        if (photo) setPhotos((list) => (list.some((p) => p.id === photo!.id) ? list : [...list, photo!]));
        update(order.id, { status: 'sending' });
      }
      operations = withPickedPhoto(operations, photo?.id ?? null);

      const current = latest.current;
      const assets = new Map<string, CopilotAssetInfo>();
      for (const logo of current.logos) {
        assets.set(logo.id, { id: logo.id, name: logo.file_name, width: logo.width, height: logo.height });
      }
      for (const asset of [...chosen, ...(photo ? [photo] : [])]) assets.set(asset.id, asset);
      const result = applyCopilotOperations(current.document, operations, {
        brand: current.brand,
        assets,
        logoIds: current.logoIds,
        imageTones: current.imageTones,
        pageIndex: current.pageIndex,
      });
      const notes = [
        ...(response.note ? [response.note] : []),
        ...response.discarded.map((item) => item.reason),
        ...(dictated.removed > 0 ? ['Se ha quitado un texto que no estaba en lo dictado.'] : []),
      ];
      if (!result.ok) {
        update(order.id, {
          status: 'failed',
          notes: ['El diseño resultante no sería válido: no se ha cambiado nada.', ...notes],
        });
        return;
      }
      if (result.changes.length === 0) {
        update(order.id, { status: 'nothing', notes: [...notes, ...result.skipped] });
        return;
      }
      current.onApply(result.document, result.touched);
      latest.current = { ...latest.current, document: result.document };
      update(order.id, { status: 'applied', changes: result.changes, notes: [...notes, ...result.skipped] });
    } catch (error) {
      update(order.id, { status: 'failed', error: await toAiError(error) });
    }
  }

  const onPhrase = useCallback((transcript: string) => {
    orderCounter += 1;
    const order: Order = { id: orderCounter, transcript, status: 'pending' };
    setOrders((list) => [...list, order]);
    // Una detrás de otra: cada orden parte del documento que dejó la anterior.
    queue.current = queue.current.then(() => process(order));
    // `process` solo lee lo último a través de `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dictation = useDictation(onPhrase);
  const { start, stop } = dictation;

  // Al abrir el copiloto se empieza a escuchar; al cerrarlo, se para.
  useEffect(() => {
    start();
    return () => stop();
  }, [start, stop]);

  const lastOrders = useMemo(() => orders.slice(-6).reverse(), [orders]);

  function closePicker(asset: CopilotAssetInfo | null) {
    setPickerOpen(false);
    const resolve = waitingPhoto.current;
    waitingPhoto.current = null;
    if (resolve) resolve(asset);
    else if (asset) setPhotos((list) => (list.some((p) => p.id === asset.id) ? list : [...list, asset]));
  }

  return (
    <section
      className="w-full basis-full space-y-3 rounded-xl border border-border bg-surface p-3"
      aria-label="Copiloto por voz"
      data-testid="copilot-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Copiloto por voz</h2>
        <Button
          size="sm"
          variant={dictation.listening ? 'primary' : 'secondary'}
          aria-pressed={dictation.listening}
          onClick={dictation.listening ? dictation.stop : dictation.start}
          data-testid="copilot-mic"
        >
          {dictation.listening ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
          {dictation.listening ? 'Parar' : 'Seguir dictando'}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setPickerOpen(true)} data-testid="copilot-pick-photo">
          <ImagePlus className="h-4 w-4" aria-hidden />
          Elegir foto
        </Button>
        <span className="text-xs text-muted">
          {dictation.listening ? 'Escuchando. Cada frase es una orden; se deshace con Ctrl+Z.' : 'En pausa.'}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label="Cerrar el copiloto"
          onClick={onClose}
          data-testid="copilot-close"
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {photos.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 text-xs" aria-label="Fotos para el copiloto" data-testid="copilot-photos">
          {photos.map((photo) => (
            <li key={photo.id} className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5">
              {photo.name}
              <button
                type="button"
                aria-label={`Quitar ${photo.name}`}
                onClick={() => setPhotos((list) => list.filter((p) => p.id !== photo.id))}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="min-h-[1.25rem] text-sm italic text-muted" aria-live="polite" data-testid="copilot-interim">
        {dictation.interim}
      </p>
      {dictation.error && (
        <p role="alert" className="text-sm text-danger" data-testid="copilot-speech-error">
          {dictation.error}
        </p>
      )}

      {lastOrders.length > 0 && (
        <ol className="max-h-48 space-y-2 overflow-y-auto" aria-label="Órdenes dictadas" data-testid="copilot-orders">
          {lastOrders.map((order) => (
            <li
              key={order.id}
              className="rounded-lg bg-subtle px-3 py-2 text-sm"
              data-testid="copilot-order"
              data-status={order.status}
            >
              <p className="flex items-start gap-2">
                {order.status === 'sending' || order.status === 'pending' ? (
                  <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden />
                ) : order.status === 'applied' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                ) : null}
                <span className="min-w-0 flex-1">«{order.transcript}»</span>
                <span className="shrink-0 text-xs text-muted">{STATUS_LABEL[order.status]}</span>
              </p>
              {order.changes && order.changes.length > 0 && (
                <ul className="mt-1 list-disc pl-6 text-xs" data-testid="copilot-changes">
                  {order.changes.map((change, index) => (
                    <li key={index}>{change}</li>
                  ))}
                </ul>
              )}
              {order.notes && order.notes.length > 0 && (
                <ul className="mt-1 space-y-0.5 pl-6 text-xs text-muted" data-testid="copilot-notes">
                  {order.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              )}
              {order.error !== undefined && (
                <div className="mt-2">
                  <AiErrorNotice error={order.error} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <ImagePickerDialog
        brandId={brandId}
        libraryPath={libraryPath}
        title="Foto para el copiloto"
        uploadTo={{ organizationId: orgId }}
        open={pickerOpen}
        onOpenChange={(open) => {
          if (!open) closePicker(null);
        }}
        onPick={(asset) => closePicker({ id: asset.id, name: asset.file_name, width: asset.width, height: asset.height })}
      />
    </section>
  );
}
