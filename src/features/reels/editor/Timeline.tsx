// Línea de tiempo del editor de reels: pistas de vídeo y fotos, textos,
// subtítulos y música, con cabezal, zoom, arrastrar para ordenar y recortar
// por los extremos. Se maneja con ratón, dedo (eventos de puntero) y teclado
// (Alt + flechas mueve el elemento elegido; los recortes exactos, en el panel).
import { Film, Image as ImageIcon, Music2, Type } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from '@/lib/utils';
import { musicGain } from './compose';
import type { Selection } from './history';
import { timelineSubtitles, type DraftPlan, type PlanTimeline } from './project';

export const ZOOM_LEVELS = [20, 40, 60, 90, 140, 200] as const;

export interface TimelineProps {
  plan: DraftPlan;
  timeline: PlanTimeline;
  /** Píxeles por segundo. */
  pxPerSecond: number;
  playhead: number;
  selection: Selection;
  readOnly: boolean;
  labelOf: (path: string) => string;
  /** Duración real del archivo de un clip, si se sabe. */
  fileSecondsOf: (path: string) => number | null;
  onSeek: (seconds: number) => void;
  onSelect: (selection: Selection) => void;
  onMoveClip: (from: number, to: number) => void;
  /** Recorte en curso: se llama varias veces durante el arrastre con la misma clave. */
  onTrimClip: (id: string, edge: 'start' | 'end', value: number, dragKey: string) => void;
  onMoveText: (id: string, start: number, dragKey: string) => void;
  onTrimText: (id: string, edge: 'start' | 'end', value: number, dragKey: string) => void;
  /** Fin de un arrastre: el siguiente cambio ya es otro paso del historial. */
  onDragEnd: () => void;
}

type Drag =
  | { kind: 'clip'; index: number; x: number; dx: number; left: number }
  | { kind: 'trim-clip'; id: string; edge: 'start' | 'end'; x: number; origin: number; key: string }
  | { kind: 'text'; id: string; x: number; origin: number; key: string }
  | { kind: 'trim-text'; id: string; edge: 'start' | 'end'; x: number; origin: number; key: string }
  | { kind: 'seek' };

let dragSeed = 0;

/** Posición de destino de un elemento arrastrado al segundo `t`: cuántos centros de los demás quedan a su izquierda. */
export function clipTarget(from: number, t: number, timeline: Pick<PlanTimeline, 'starts' | 'durations'>): number {
  let target = 0;
  timeline.starts.forEach((start, i) => {
    if (i !== from && start + timeline.durations[i]! / 2 < t) target += 1;
  });
  return target;
}
const fmt = (n: number) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(n);

export function Timeline(props: TimelineProps) {
  const { plan, timeline, pxPerSecond: pps, playhead, selection, readOnly } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const width = Math.max(timeline.total, 5) * pps + 48;

  /** Segundo del reel bajo el puntero. */
  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const scroll = trackRef.current?.parentElement?.scrollLeft ?? 0;
    return Math.max(0, (clientX - left + scroll) / latest.current.pxPerSecond);
  };

  /** Origen de la pista en pantalla (con lo desplazado): para pasar del puntero a segundos. */
  const trackLeft = () =>
    (trackRef.current?.getBoundingClientRect().left ?? 0) - (trackRef.current?.parentElement?.scrollLeft ?? 0);

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const p = latest.current;
      const delta = (event.clientX - ('x' in drag ? drag.x : 0)) / p.pxPerSecond;
      if (drag.kind === 'seek') p.onSeek(Math.min(timeAt(event.clientX), p.timeline.total));
      else if (drag.kind === 'clip') setDrag({ ...drag, dx: event.clientX - drag.x });
      else if (drag.kind === 'trim-clip') p.onTrimClip(drag.id, drag.edge, drag.origin + delta, drag.key);
      else if (drag.kind === 'text') p.onMoveText(drag.id, drag.origin + delta, drag.key);
      else if (drag.kind === 'trim-text') p.onTrimText(drag.id, drag.edge, drag.origin + delta, drag.key);
    };
    const up = (event: PointerEvent) => {
      const p = latest.current;
      if (drag.kind === 'clip' && Math.abs(event.clientX - drag.x) > 4) {
        const to = clipTarget(drag.index, (event.clientX - drag.left) / p.pxPerSecond, p.timeline);
        if (to !== drag.index) p.onMoveClip(drag.index, to);
      }
      setDrag(null);
      p.onDragEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [drag]);

  const start = (event: ReactPointerEvent, next: Drag) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.stopPropagation();
    event.preventDefault();
    // Recortar un elemento también lo elige: el panel enseña sus valores exactos.
    if (next.kind === 'trim-clip') props.onSelect({ kind: 'clip', id: next.id });
    if (next.kind === 'trim-text') props.onSelect({ kind: 'text', id: next.id });
    setDrag(next);
  };

  const onClipKey = (event: KeyboardEvent, index: number) => {
    if (readOnly || !event.altKey) return;
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      props.onMoveClip(index, index - 1);
    } else if (event.key === 'ArrowRight' && index < plan.clips.length - 1) {
      event.preventDefault();
      props.onMoveClip(index, index + 1);
    }
  };

  const ticks: number[] = [];
  const tickStep = pps >= 90 ? 0.5 : pps >= 40 ? 1 : 2;
  for (let s = 0; s <= Math.max(timeline.total, 5) + 1e-6; s += tickStep) ticks.push(Number(s.toFixed(2)));
  const cues = timelineSubtitles(plan.clips, timeline);
  const music = plan.music;
  const dropTarget =
    drag?.kind === 'clip' && Math.abs(drag.dx) > 4
      ? clipTarget(drag.index, (drag.x + drag.dx - drag.left) / pps, timeline)
      : null;

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface" data-testid="reel-timeline">
      <div ref={trackRef} className="relative select-none" style={{ width }}>
        {/* Regla: pulsar o arrastrar mueve el cabezal. */}
        <div
          className="relative h-7 cursor-pointer border-b border-border bg-subtle text-[10px] text-muted"
          onPointerDown={(e) => {
            props.onSeek(Math.min(timeAt(e.clientX), timeline.total));
            start(e, { kind: 'seek' });
          }}
          data-testid="reel-ruler"
        >
          {ticks.map((s) => (
            <span key={s} className="absolute top-0 h-full border-l border-border pl-1" style={{ left: s * pps }}>
              {Number.isInteger(s) ? `${s}s` : ''}
            </span>
          ))}
        </div>

        <Lane label="Vídeo y fotos">
          {plan.clips.map((clip, index) => {
            const left = timeline.starts[index]! * pps;
            const w = Math.max(16, timeline.durations[index]! * pps);
            const selected = selection?.kind === 'clip' && selection.id === clip.id;
            const dragging = drag?.kind === 'clip' && drag.index === index;
            const fileSeconds = clip.type === 'video' ? props.fileSecondsOf(clip.path) : null;
            return (
              <div
                key={clip.id}
                className={cn(
                  'absolute top-1 bottom-1 overflow-hidden rounded-md border text-xs',
                  clip.type === 'video' ? 'border-primary/40 bg-primary-soft' : 'border-border bg-subtle',
                  selected && 'ring-2 ring-primary',
                  dragging && 'z-20 opacity-80 shadow-pop',
                )}
                style={{ left, width: w, transform: dragging ? `translateX(${drag.dx}px)` : undefined }}
                data-testid="reel-clip"
              >
                <button
                  type="button"
                  className="flex h-full w-full cursor-grab items-center gap-1 px-2 text-left active:cursor-grabbing"
                  onPointerDown={(e) => {
                    props.onSelect({ kind: 'clip', id: clip.id });
                    if (!readOnly) start(e, { kind: 'clip', index, x: e.clientX, dx: 0, left: trackLeft() });
                  }}
                  onClick={() => props.onSelect({ kind: 'clip', id: clip.id })}
                  onKeyDown={(e) => onClipKey(e, index)}
                  aria-label={`${index + 1}. ${clip.type === 'video' ? 'Clip' : 'Foto'} ${props.labelOf(clip.path)}, ${fmt(
                    timeline.durations[index]!,
                  )} s`}
                  aria-pressed={selected}
                >
                  {clip.type === 'video' ? (
                    <Film className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  ) : (
                    <ImageIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  )}
                  <span className="truncate">{props.labelOf(clip.path)}</span>
                  {clip.type === 'video' && clip.volume === 0 && (
                    <span className="ml-auto text-[10px] text-muted">mudo</span>
                  )}
                </button>
                {!readOnly && clip.type === 'video' && (
                  <Handle
                    side="start"
                    label={`Recortar el principio del clip ${index + 1}`}
                    onPointerDown={(e) =>
                      start(e, {
                        kind: 'trim-clip',
                        id: clip.id,
                        edge: 'start',
                        x: e.clientX,
                        origin: clip.in,
                        key: `trim:${++dragSeed}`,
                      })
                    }
                  />
                )}
                {!readOnly && (
                  <Handle
                    side="end"
                    label={
                      clip.type === 'video'
                        ? `Recortar el final del clip ${index + 1}`
                        : `Duración de la foto ${index + 1}`
                    }
                    onPointerDown={(e) =>
                      start(e, {
                        kind: 'trim-clip',
                        id: clip.id,
                        edge: 'end',
                        x: e.clientX,
                        origin: clip.type === 'video' ? Math.min(clip.out, fileSeconds ?? clip.out) : clip.seconds,
                        key: `trim:${++dragSeed}`,
                      })
                    }
                  />
                )}
              </div>
            );
          })}
          {/* Transiciones: dónde se solapan dos elementos. */}
          {plan.clips.map((clip, index) =>
            index > 0 && timeline.transitions[index]! > 0 ? (
              <span
                key={`tr-${clip.id}`}
                className="pointer-events-none absolute top-0 z-10 h-2 rounded-b bg-warning/70"
                style={{ left: timeline.starts[index]! * pps, width: timeline.transitions[index]! * pps }}
                title={`Transición: ${clip.transition?.type ?? ''}`}
              />
            ) : null,
          )}
          {dropTarget !== null && (
            <span
              className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 bg-primary"
              style={{
                left:
                  dropTarget >= plan.clips.length - 1
                    ? timeline.total * pps
                    : timeline.starts[dropTarget + (dropTarget > (drag as { index: number }).index ? 1 : 0)]! * pps,
              }}
              data-testid="reel-drop-indicator"
            />
          )}
        </Lane>

        <Lane label="Textos">
          {plan.texts.map((text, index) => {
            const selected = selection?.kind === 'text' && selection.id === text.id;
            return (
              <div
                key={text.id}
                className={cn(
                  'absolute top-1 bottom-1 overflow-hidden rounded-md border border-border bg-surface text-xs shadow-card',
                  selected && 'ring-2 ring-primary',
                )}
                style={{ left: text.start * pps, width: Math.max(12, (text.end - text.start) * pps) }}
                data-testid="reel-text-block"
              >
                <button
                  type="button"
                  className="flex h-full w-full cursor-grab items-center gap-1 px-2 text-left"
                  onPointerDown={(e) => {
                    props.onSelect({ kind: 'text', id: text.id });
                    if (!readOnly)
                      start(e, {
                        kind: 'text',
                        id: text.id,
                        x: e.clientX,
                        origin: text.start,
                        key: `text:${++dragSeed}`,
                      });
                  }}
                  onClick={() => props.onSelect({ kind: 'text', id: text.id })}
                  aria-label={`Texto ${index + 1}: ${text.text}`}
                  aria-pressed={selected}
                >
                  <Type className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{text.text}</span>
                </button>
                {!readOnly && (
                  <>
                    <Handle
                      side="start"
                      label={`Cuándo entra el texto ${index + 1}`}
                      onPointerDown={(e) =>
                        start(e, {
                          kind: 'trim-text',
                          id: text.id,
                          edge: 'start',
                          x: e.clientX,
                          origin: text.start,
                          key: `tt:${++dragSeed}`,
                        })
                      }
                    />
                    <Handle
                      side="end"
                      label={`Cuándo sale el texto ${index + 1}`}
                      onPointerDown={(e) =>
                        start(e, {
                          kind: 'trim-text',
                          id: text.id,
                          edge: 'end',
                          x: e.clientX,
                          origin: text.end,
                          key: `tt:${++dragSeed}`,
                        })
                      }
                    />
                  </>
                )}
              </div>
            );
          })}
        </Lane>

        {(cues.length > 0 || plan.clips.some((c) => c.type === 'video')) && (
          <Lane label="Subtítulos" muted={!plan.subtitles?.enabled}>
            {cues.map((cue) => (
              <button
                key={`${cue.clip}:${cue.cue}`}
                type="button"
                className="absolute top-1 bottom-1 truncate rounded border border-border bg-subtle px-1 text-left text-[10px]"
                style={{ left: cue.start * pps, width: Math.max(8, (cue.end - cue.start) * pps) }}
                onClick={() => props.onSelect({ kind: 'subtitles' })}
                title={cue.text}
                data-testid="reel-cue-block"
              >
                {cue.text}
              </button>
            ))}
          </Lane>
        )}

        <Lane label="Música">
          {music && (
            <button
              type="button"
              className={cn(
                'absolute top-1 bottom-1 flex items-center gap-1 overflow-hidden rounded-md border border-success/40 bg-success/10 px-2 text-left text-xs',
                selection?.kind === 'music' && 'ring-2 ring-primary',
              )}
              style={{
                left: 0,
                width: Math.max(16, timeline.total * pps),
                // La rampa de volumen (entrada y salida suaves), como fondo.
                backgroundImage: `linear-gradient(to right, ${[0, 0.1, 0.5, 0.9, 1]
                  .map(
                    (f) =>
                      `rgba(34,197,94,${(musicGain(f * timeline.total, timeline.total, music) * 0.6).toFixed(2)}) ${f * 100}%`,
                  )
                  .join(', ')})`,
              }}
              onClick={() => props.onSelect({ kind: 'music' })}
              aria-label={`Música: ${props.labelOf(music.path)}`}
              data-testid="reel-music-block"
            >
              <Music2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{props.labelOf(music.path)}</span>
            </button>
          )}
        </Lane>

        {/* Cabezal de reproducción. */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 z-40 w-0.5 bg-danger"
          style={{ left: Math.min(playhead, timeline.total) * pps }}
          data-testid="reel-playhead"
        />
      </div>
    </div>
  );
}

function Lane({ label, muted = false, children }: { label: string; muted?: boolean; children?: React.ReactNode }) {
  return (
    <div className={cn('relative h-11 border-b border-border last:border-b-0', muted && 'opacity-50')}>
      <span className="pointer-events-none absolute left-1 top-0 z-0 text-[10px] uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

function Handle({
  side,
  label,
  onPointerDown,
}: {
  side: 'start' | 'end';
  label: string;
  onPointerDown: (event: ReactPointerEvent) => void;
}) {
  return (
    <span
      role="slider"
      aria-label={label}
      aria-valuenow={0}
      tabIndex={-1}
      className={cn(
        'absolute top-0 bottom-0 z-10 w-2 cursor-ew-resize bg-fg/20 hover:bg-primary',
        side === 'start' ? 'left-0' : 'right-0',
      )}
      onPointerDown={onPointerDown}
      data-testid={`reel-handle-${side}`}
    />
  );
}
