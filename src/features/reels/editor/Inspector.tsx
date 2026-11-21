// Panel de propiedades del elemento elegido en la línea de tiempo: foto o
// clip (duración, recortes exactos, volumen, transición, desenfoque y sus
// subtítulos), texto (contenido, momento, posición y estilo con la tipografía
// y los colores de la marca), música y estilo de los subtítulos.
import { ArrowLeft, ArrowRight, Captions, Copy, Plus, Trash2, VolumeX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button, Dialog, Input, Select, Textarea } from '@/components/ui';
import { formatMicros } from '@/features/ai/money';
import { cn } from '@/lib/utils';
import type { ReelTemplateSummary } from '../templates';
import type { Selection } from './history';
import {
  addCue,
  duplicateClip,
  moveClip,
  removeClip,
  removeCue,
  removeMusic,
  removeText,
  setClipCues,
  setSubtitleSettings,
  setTransition,
  trimClip,
  updateClip,
  updateCue,
  updateMusic,
  updateText,
  updateTextStyle,
} from './ops';
import {
  defaultSubtitleSettings,
  PHOTO_MOTIONS,
  TEXT_POSITIONS,
  TRANSITION_TYPES,
  type Clip,
  type ReelProject,
  type TextStyle,
  type VideoClip,
} from './project';
import { extractClipAudio, transcribeSamples, transcriptionOptions } from './subtitles';

export type Apply = (change: (project: ReelProject) => ReelProject, merge?: string) => void;

export interface BrandFontOption {
  path: string;
  family: string;
  label: string;
}

export interface InspectorProps {
  project: ReelProject;
  selection: Selection;
  template: ReelTemplateSummary;
  readOnly: boolean;
  apply: Apply;
  onSelect: (selection: Selection) => void;
  labelOf: (path: string) => string;
  fileSecondsOf: (path: string) => number | null;
  urlOf: (path: string) => string | undefined;
  /** Colores del perfil de la marca. */
  palette: Array<{ hex: string; name: string }>;
  /** Tipografías .ttf/.otf de la marca. */
  fonts: BrandFontOption[];
  /** Subtítulos automáticos disponibles (interruptor y OpenAI en el servidor). */
  autoSubtitles: boolean;
  brandId: string;
}

const TRANSITION_LABEL: Record<(typeof TRANSITION_TYPES)[number], string> = {
  cut: 'Corte seco',
  fade: 'Fundido',
  fadeblack: 'Fundido a negro',
  dissolve: 'Disolver',
  slideleft: 'Deslizar a la izquierda',
  slideup: 'Deslizar hacia arriba',
};
const MOTION_LABEL: Record<(typeof PHOTO_MOTIONS)[number], string> = {
  none: 'Quieta',
  'zoom-in': 'Acercar',
  'zoom-out': 'Alejar',
  'pan-right': 'Recorrer a la derecha',
  'pan-left': 'Recorrer a la izquierda',
};
const POSITION_LABEL = { top: 'Arriba', center: 'Centro', bottom: 'Abajo' } as const;

const num = (value: string) => {
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

export function Inspector(props: InspectorProps) {
  const { project, selection } = props;
  if (!selection) {
    return (
      <p className="text-sm text-muted" data-testid="reel-inspector-empty">
        Elige un elemento de la línea de tiempo para cambiarlo.
      </p>
    );
  }
  if (selection.kind === 'clip') {
    const index = project.plan.clips.findIndex((c) => c.id === selection.id);
    const clip = project.plan.clips[index];
    return clip ? <ClipPanel {...props} clip={clip} index={index} /> : null;
  }
  if (selection.kind === 'text') {
    const index = project.plan.texts.findIndex((t) => t.id === selection.id);
    return index >= 0 ? <TextPanel {...props} index={index} /> : null;
  }
  if (selection.kind === 'music') return <MusicPanel {...props} />;
  return <SubtitlesPanel {...props} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

function ClipPanel(props: InspectorProps & { clip: Clip; index: number }) {
  const { clip, index, project, apply, readOnly, template } = props;
  const count = project.plan.clips.length;
  const fileSeconds = clip.type === 'video' ? props.fileSecondsOf(clip.path) : null;
  const transition = clip.transition ?? { type: template.transition.type, seconds: template.transition.seconds };
  return (
    <div className="space-y-3" data-testid="reel-inspector-clip">
      <p className="truncate text-sm font-medium">
        {index + 1}. {clip.type === 'video' ? 'Clip' : 'Foto'} · {props.labelOf(clip.path)}
      </p>
      <fieldset disabled={readOnly} className="space-y-3">
        <Section title="Tiempo">
          {clip.type === 'photo' ? (
            <Row label="Duración (s)">
              <Input
                type="number"
                inputMode="decimal"
                min={0.5}
                max={10}
                step={0.1}
                value={clip.seconds}
                onChange={(e) => {
                  const v = num(e.target.value);
                  if (v !== null) apply((p) => trimClip(p, clip.id, 'end', v), `seconds:${clip.id}`);
                }}
                aria-label="Duración de la foto en segundos"
                data-testid="reel-photo-seconds"
              />
            </Row>
          ) : (
            <>
              <Row label="Entrada (s)">
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.1}
                  value={clip.in}
                  onChange={(e) => {
                    const v = num(e.target.value);
                    if (v !== null) apply((p) => trimClip(p, clip.id, 'start', v, fileSeconds), `in:${clip.id}`);
                  }}
                  aria-label="Segundo del clip en el que empieza"
                  data-testid="reel-clip-in"
                />
              </Row>
              <Row label="Salida (s)">
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0.5}
                  step={0.1}
                  value={clip.out}
                  onChange={(e) => {
                    const v = num(e.target.value);
                    if (v !== null) apply((p) => trimClip(p, clip.id, 'end', v, fileSeconds), `out:${clip.id}`);
                  }}
                  aria-label="Segundo del clip en el que acaba"
                  data-testid="reel-clip-out"
                />
              </Row>
              {fileSeconds !== null && (
                <p className="text-xs text-muted">El clip dura {fileSeconds.toLocaleString('es-ES')} s.</p>
              )}
            </>
          )}
        </Section>

        {index > 0 && (
          <Section title="Transición de entrada">
            <Row label="Tipo">
              <Select
                value={transition.type}
                onChange={(e) =>
                  apply((p) =>
                    setTransition(p, clip.id, {
                      type: e.target.value as (typeof TRANSITION_TYPES)[number],
                      seconds: transition.seconds || 0.4,
                    }),
                  )
                }
                aria-label="Transición desde el elemento anterior"
                data-testid="reel-transition-type"
              >
                {TRANSITION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TRANSITION_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Row>
            {transition.type !== 'cut' && (
              <Row label="Duración (s)">
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0.1}
                  max={2}
                  step={0.1}
                  value={transition.seconds}
                  onChange={(e) => {
                    const v = num(e.target.value);
                    if (v !== null)
                      apply(
                        (p) =>
                          setTransition(p, clip.id, { type: transition.type, seconds: Math.min(2, Math.max(0, v)) }),
                        `transition:${clip.id}`,
                      );
                  }}
                  aria-label="Duración de la transición"
                />
              </Row>
            )}
          </Section>
        )}

        <Section title="Imagen">
          {clip.type === 'photo' && (
            <Row label="Movimiento">
              <Select
                value={clip.motion ?? ''}
                onChange={(e) =>
                  apply((p) =>
                    updateClip(p, clip.id, {
                      motion: (e.target.value || undefined) as (typeof PHOTO_MOTIONS)[number] | undefined,
                    }),
                  )
                }
                aria-label="Movimiento de la foto"
              >
                <option value="">El de la plantilla</option>
                {PHOTO_MOTIONS.map((m) => (
                  <option key={m} value={m}>
                    {MOTION_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Row>
          )}
          <Row label="Desenfoque">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={clip.blur ?? 0}
              onChange={(e) =>
                apply((p) => updateClip(p, clip.id, { blur: Number(e.target.value) || undefined }), `blur:${clip.id}`)
              }
              aria-label="Desenfoque"
            />
          </Row>
        </Section>

        {clip.type === 'video' && (
          <Section title="Sonido del clip">
            <Row label="Volumen">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(clip.volume * 100)}
                  onChange={(e) =>
                    apply((p) => updateClip(p, clip.id, { volume: Number(e.target.value) / 100 }), `volume:${clip.id}`)
                  }
                  aria-label="Volumen del clip"
                  data-testid="reel-clip-volume"
                />
                <span className="w-10 text-right text-xs tabular-nums">{Math.round(clip.volume * 100)} %</span>
              </div>
            </Row>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => apply((p) => updateClip(p, clip.id, { volume: clip.volume === 0 ? 1 : 0 }))}
              data-testid="reel-clip-mute"
            >
              <VolumeX className="h-4 w-4" aria-hidden />
              {clip.volume === 0 ? 'Recuperar el sonido' : 'Silenciar'}
            </Button>
          </Section>
        )}
      </fieldset>

      {clip.type === 'video' && <ClipSubtitles {...props} clip={clip} />}

      {!readOnly && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={index === 0}
            onClick={() => apply((p) => moveClip(p, index, index - 1))}
            aria-label="Mover antes"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Antes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={index === count - 1}
            onClick={() => apply((p) => moveClip(p, index, index + 1))}
            aria-label="Mover después"
          >
            Después
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => apply((p) => duplicateClip(p, clip.id))}>
            <Copy className="h-4 w-4" aria-hidden />
            Duplicar
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => apply((p) => removeClip(p, clip.id))}
            data-testid="reel-clip-remove"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Quitar
          </Button>
        </div>
      )}
    </div>
  );
}

/** Subtítulos de un clip: automáticos (si hay OpenAI) o escritos a mano, y corregibles antes de montar. */
function ClipSubtitles(props: InspectorProps & { clip: VideoClip; index: number }) {
  const { clip, apply, readOnly, project } = props;
  const [confirming, setConfirming] = useState<{ microsPerSecond: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const cues = clip.subtitles ?? [];
  const seconds = Math.max(0, Math.min(clip.out, props.fileSecondsOf(clip.path) ?? clip.out) - clip.in);

  const ask = async () => {
    try {
      const options = await transcriptionOptions(props.brandId);
      if (!options.available || options.microsPerSecond === null) {
        toast.error('Los subtítulos automáticos no están disponibles ahora.');
        return;
      }
      setConfirming({ microsPerSecond: options.microsPerSecond });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se ha podido consultar el precio.');
    }
  };

  const run = async () => {
    setConfirming(null);
    const url = props.urlOf(clip.path);
    if (!url) {
      toast.error('Todavía no se puede leer el clip. Espera un momento y vuelve a probar.');
      return;
    }
    setBusy(true);
    try {
      const samples = await extractClipAudio(url, clip.in, clip.in + seconds);
      const result = await transcribeSamples(props.brandId, samples, clip.in);
      if (result.cues.length === 0) {
        toast.info('No se ha oído nada que transcribir en este tramo.');
        return;
      }
      apply((p) => {
        const withCues = setClipCues(p, clip.id, result.cues);
        return withCues.plan.subtitles
          ? withCues
          : setSubtitleSettings(withCues, defaultSubtitleSettings(props.template));
      });
      toast.success(`${result.cues.length} subtítulos. Revísalos antes de montar.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se ha podido transcribir el clip.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Subtítulos de este clip">
      {!project.plan.subtitles?.enabled && cues.length > 0 && (
        <p className="text-xs text-muted">Los subtítulos están apagados: actívalos en «Subtítulos» para que salgan.</p>
      )}
      {cues.length > 0 && (
        <ul className="space-y-2" data-testid="reel-cues">
          {cues.map((cue, i) => (
            <li key={i} className="grid grid-cols-[4rem_4rem_minmax(0,1fr)_auto] items-center gap-1">
              <Input
                type="number"
                step={0.1}
                value={cue.start}
                disabled={readOnly}
                aria-label={`Entrada del subtítulo ${i + 1}`}
                onChange={(e) => {
                  const v = num(e.target.value);
                  if (v !== null) apply((p) => updateCue(p, clip.id, i, { start: v }), `cue-start:${clip.id}:${i}`);
                }}
              />
              <Input
                type="number"
                step={0.1}
                value={cue.end}
                disabled={readOnly}
                aria-label={`Salida del subtítulo ${i + 1}`}
                onChange={(e) => {
                  const v = num(e.target.value);
                  if (v !== null) apply((p) => updateCue(p, clip.id, i, { end: v }), `cue-end:${clip.id}:${i}`);
                }}
              />
              <Input
                value={cue.text}
                maxLength={200}
                disabled={readOnly}
                aria-label={`Texto del subtítulo ${i + 1}`}
                onChange={(e) =>
                  apply((p) => updateCue(p, clip.id, i, { text: e.target.value }), `cue-text:${clip.id}:${i}`)
                }
                data-testid="reel-cue-text"
              />
              {!readOnly && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Quitar el subtítulo ${i + 1}`}
                  onClick={() => apply((p) => removeCue(p, clip.id, i))}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          {props.autoSubtitles && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void ask()}
              loading={busy}
              data-testid="reel-auto-subtitles"
            >
              <Captions className="h-4 w-4" aria-hidden />
              {cues.length ? 'Volver a transcribir' : 'Subtítulos automáticos'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              apply((p) => {
                const withCue = addCue(p, clip.id, clip.in);
                return withCue.plan.subtitles
                  ? withCue
                  : setSubtitleSettings(withCue, defaultSubtitleSettings(props.template));
              })
            }
          >
            <Plus className="h-4 w-4" aria-hidden />
            Escribir uno
          </Button>
        </div>
      )}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="Subtítulos automáticos"
        description="Se envía el sonido del tramo usado del clip a OpenAI para transcribirlo. Cuenta en el cupo de IA de la organización."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void run()} data-testid="reel-auto-subtitles-confirm">
              Transcribir
            </Button>
          </>
        }
      >
        {confirming && (
          <p className="text-sm" data-testid="reel-auto-subtitles-cost">
            Tramo de {seconds.toLocaleString('es-ES', { maximumFractionDigits: 1 })} s. Coste máximo:{' '}
            {formatMicros(Math.ceil(seconds + 1) * confirming.microsPerSecond)} (se cobra solo la voz que se oiga).
          </p>
        )}
      </Dialog>
    </Section>
  );
}

function StyleFields({
  style,
  onChange,
  palette,
  fonts,
  readOnly,
  idPrefix,
}: {
  style: TextStyle;
  onChange: (patch: Partial<TextStyle>, merge?: string) => void;
  palette: InspectorProps['palette'];
  fonts: BrandFontOption[];
  readOnly: boolean;
  idPrefix: string;
}) {
  return (
    <fieldset disabled={readOnly} className="space-y-2">
      <Row label="Tipografía">
        <Select
          value={style.fontPath ?? ''}
          onChange={(e) => {
            const font = fonts.find((f) => f.path === e.target.value);
            onChange(
              font ? { fontPath: font.path, fontFamily: font.family } : { fontPath: undefined, fontFamily: undefined },
            );
          }}
          aria-label="Tipografía"
          data-testid={`${idPrefix}-font`}
        >
          <option value="">La de la marca por defecto</option>
          {fonts.map((f) => (
            <option key={f.path} value={f.path}>
              {f.label}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Color">
        <div className="flex flex-wrap items-center gap-1">
          {palette.map((c) => (
            <button
              key={c.hex}
              type="button"
              title={c.name || c.hex}
              aria-label={`Color ${c.name || c.hex}`}
              className={cn(
                'h-6 w-6 rounded-full border border-border',
                style.color.toUpperCase() === c.hex.toUpperCase() && 'ring-2 ring-primary',
              )}
              style={{ background: c.hex }}
              onClick={() => onChange({ color: c.hex.toUpperCase() })}
            />
          ))}
          <input
            type="color"
            value={style.color}
            onChange={(e) => onChange({ color: e.target.value.toUpperCase() }, `${idPrefix}-color`)}
            aria-label="Otro color"
            className="h-7 w-9"
          />
        </div>
      </Row>
      <Row label="Tamaño">
        <input
          type="range"
          min={2}
          max={15}
          step={0.5}
          value={style.sizeRatio * 100}
          onChange={(e) => onChange({ sizeRatio: Number(e.target.value) / 100 }, `${idPrefix}-size`)}
          aria-label="Tamaño de la letra"
        />
      </Row>
      <Row label="Margen">
        <input
          type="range"
          min={0}
          max={40}
          step={1}
          value={style.marginRatio * 100}
          onChange={(e) => onChange({ marginRatio: Number(e.target.value) / 100 }, `${idPrefix}-margin`)}
          aria-label="Distancia al borde"
        />
      </Row>
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={style.box !== null}
            onChange={(e) =>
              onChange({ box: e.target.checked ? { color: '#000000', opacity: 0.55, paddingRatio: 0.35 } : null })
            }
          />
          Franja detrás
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={style.outline !== null}
            onChange={(e) => onChange({ outline: e.target.checked ? { color: '#000000', widthRatio: 0.06 } : null })}
          />
          Contorno
        </label>
      </div>
      <Row label="Aparición (s)">
        <Input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={style.fadeSeconds}
          onChange={(e) => {
            const v = num(e.target.value);
            if (v !== null) onChange({ fadeSeconds: Math.min(1, Math.max(0, v)) }, `${idPrefix}-fade`);
          }}
          aria-label="Duración de la aparición y la desaparición"
        />
      </Row>
    </fieldset>
  );
}

function TextPanel(props: InspectorProps & { index: number }) {
  const { project, index, apply, readOnly } = props;
  const text = project.plan.texts[index]!;
  return (
    <div className="space-y-3" data-testid="reel-inspector-text">
      <Section title={`Texto ${index + 1}`}>
        <Textarea
          value={text.text}
          maxLength={200}
          rows={2}
          disabled={readOnly}
          onChange={(e) => apply((p) => updateText(p, text.id, { text: e.target.value }), `text:${text.id}`)}
          aria-label="Lo que se lee en el vídeo"
          data-testid="reel-text-content"
        />
        <fieldset disabled={readOnly} className="space-y-2">
          <Row label="Entra (s)">
            <Input
              type="number"
              min={0}
              step={0.1}
              value={text.start}
              onChange={(e) => {
                const v = num(e.target.value);
                if (v !== null) apply((p) => updateText(p, text.id, { start: Math.max(0, v) }), `start:${text.id}`);
              }}
              aria-label="Segundo en que aparece"
              data-testid="reel-text-start"
            />
          </Row>
          <Row label="Sale (s)">
            <Input
              type="number"
              min={0.2}
              step={0.1}
              value={text.end}
              onChange={(e) => {
                const v = num(e.target.value);
                if (v !== null) apply((p) => updateText(p, text.id, { end: v }), `end:${text.id}`);
              }}
              aria-label="Segundo en que se va"
              data-testid="reel-text-end"
            />
          </Row>
          <Row label="Posición">
            <Select
              value={text.position}
              onChange={(e) =>
                apply((p) => updateText(p, text.id, { position: e.target.value as (typeof TEXT_POSITIONS)[number] }))
              }
              aria-label="Posición"
            >
              {TEXT_POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {POSITION_LABEL[p]}
                </option>
              ))}
            </Select>
          </Row>
        </fieldset>
      </Section>
      <Section title="Estilo">
        <StyleFields
          style={text.style}
          onChange={(patch, merge) => apply((p) => updateTextStyle(p, text.id, patch), merge && `${merge}:${text.id}`)}
          palette={props.palette}
          fonts={props.fonts}
          readOnly={readOnly}
          idPrefix="reel-text"
        />
      </Section>
      {!readOnly && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => apply((p) => removeText(p, text.id))}
          data-testid="reel-text-remove"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          Quitar el texto
        </Button>
      )}
    </div>
  );
}

function MusicPanel(props: InspectorProps) {
  const { project, apply, readOnly } = props;
  const music = project.plan.music;
  if (!music) return null;
  return (
    <div className="space-y-3" data-testid="reel-inspector-music">
      <Section title="Música">
        <p className="truncate text-sm font-medium">{props.labelOf(music.path)}</p>
        <p className="text-xs text-muted">
          Licencia confirmada por la marca{music.license?.note ? `: ${music.license.note}` : ''}. Queda en la
          procedencia del vídeo.
        </p>
        <fieldset disabled={readOnly} className="space-y-2">
          <Row label="Volumen">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(music.volume * 100)}
              onChange={(e) => apply((p) => updateMusic(p, { volume: Number(e.target.value) / 100 }), 'music-volume')}
              aria-label="Volumen de la música"
              data-testid="reel-music-volume"
            />
          </Row>
          <Row label="Entrada suave (s)">
            <Input
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={music.fadeInSeconds}
              onChange={(e) => {
                const v = num(e.target.value);
                if (v !== null)
                  apply((p) => updateMusic(p, { fadeInSeconds: Math.min(5, Math.max(0, v)) }), 'music-in');
              }}
              aria-label="Entrada suave de la música"
            />
          </Row>
          <Row label="Salida suave (s)">
            <Input
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={music.fadeOutSeconds}
              onChange={(e) => {
                const v = num(e.target.value);
                if (v !== null)
                  apply((p) => updateMusic(p, { fadeOutSeconds: Math.min(5, Math.max(0, v)) }), 'music-out');
              }}
              aria-label="Salida suave de la música"
            />
          </Row>
          <Row label="Empieza en (s)">
            <Input
              type="number"
              min={0}
              step={0.5}
              value={music.startAt}
              onChange={(e) => {
                const v = num(e.target.value);
                if (v !== null) apply((p) => updateMusic(p, { startAt: Math.max(0, v) }), 'music-start');
              }}
              aria-label="Segundo de la canción en el que empieza"
            />
          </Row>
        </fieldset>
      </Section>
      {!readOnly && (
        <Button variant="ghost" size="sm" onClick={() => apply((p) => removeMusic(p))} data-testid="reel-music-remove">
          <Trash2 className="h-4 w-4" aria-hidden />
          Quitar la música
        </Button>
      )}
    </div>
  );
}

function SubtitlesPanel(props: InspectorProps) {
  const { project, apply, readOnly, template } = props;
  const settings = project.plan.subtitles ?? { ...defaultSubtitleSettings(template), enabled: false };
  const set = (patch: Partial<typeof settings>, merge?: string) =>
    apply((p) => setSubtitleSettings(p, { ...settings, ...patch }), merge);
  const total = project.plan.clips.reduce((sum, c) => sum + (c.type === 'video' ? (c.subtitles?.length ?? 0) : 0), 0);
  return (
    <div className="space-y-3" data-testid="reel-inspector-subtitles">
      <Section title="Subtítulos">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={readOnly}
            onChange={(e) => set({ enabled: e.target.checked })}
            data-testid="reel-subtitles-enabled"
          />
          Dibujar los subtítulos en el vídeo ({total})
        </label>
        <p className="text-xs text-muted">
          Se escriben o se corrigen en cada clip (elige el clip en la línea de tiempo).
        </p>
        <Row label="Posición">
          <Select
            value={settings.position}
            disabled={readOnly}
            onChange={(e) => set({ position: e.target.value as (typeof TEXT_POSITIONS)[number] })}
            aria-label="Posición de los subtítulos"
          >
            {TEXT_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {POSITION_LABEL[p]}
              </option>
            ))}
          </Select>
        </Row>
      </Section>
      <Section title="Estilo">
        <StyleFields
          style={settings.style}
          onChange={(patch, merge) => set({ style: { ...settings.style, ...patch } }, merge)}
          palette={props.palette}
          fonts={props.fonts}
          readOnly={readOnly}
          idPrefix="reel-subtitles"
        />
      </Section>
    </div>
  );
}
