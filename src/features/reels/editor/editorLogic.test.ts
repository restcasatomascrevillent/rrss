import { describe, expect, it } from 'vitest';
import { REEL_TEMPLATES } from '../templates';
import { fadeAlpha, frameAt, musicGain, photoMotions, previewWarnings } from './compose';
import { editorReducer, initEditor } from './history';
import { addClip, addCue, moveClip, removeMusic, setMusic, trimClip, trimText, updateClip } from './ops';
import { emptyProject, planTimeline, type ReelProject } from './project';
import { encodeWav, speechSegments, splitCue } from './subtitles';

const template = (id: string) => REEL_TEMPLATES.find((t) => t.id === id)!;
const fundido = template('fundido-suave');
const asset = (id: string, kind: 'image' | 'video' | 'audio', durationMs: number | null = null) => ({
  id,
  kind,
  storage_path: `o/m/media/${id}`,
  file_name: id,
  mime_type: kind === 'image' ? 'image/jpeg' : 'video/mp4',
  duration_ms: durationMs,
});

function sample(): ReelProject {
  let p = emptyProject(fundido);
  p = addClip(p, asset('a.jpg', 'image'), fundido);
  p = addClip(p, asset('b.mp4', 'video', 10_000), fundido);
  p = addClip(p, asset('c.jpg', 'image'), fundido);
  return p;
}

describe('cambios sobre el proyecto', () => {
  it('añade fotos y clips con los valores de la plantilla, y los ordena', () => {
    const p = sample();
    expect(p.plan.clips.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(p.plan.clips[0]).toMatchObject({ type: 'photo', seconds: 2.5, transition: { type: 'fade', seconds: 0.5 } });
    expect(p.plan.clips[1]).toMatchObject({ type: 'video', in: 0, out: 4, volume: 0 });
    expect(moveClip(p, 0, 2).plan.clips.map((c) => c.id)).toEqual(['c2', 'c3', 'c1']);
    expect(moveClip(p, 2, 0).plan.clips.map((c) => c.id)).toEqual(['c3', 'c1', 'c2']);
    expect(moveClip(p, 1, 1)).toBe(p);
  });

  it('recorta sin bajar de 0,5 s, sin pasar de 60 s y sin salirse del archivo', () => {
    const p = sample();
    expect(trimClip(p, 'c2', 'start', 3.8).plan.clips[1]).toMatchObject({ in: 3.5, out: 4 });
    expect(trimClip(p, 'c2', 'end', 99, 10).plan.clips[1]).toMatchObject({ out: 10 });
    expect(trimClip(p, 'c2', 'end', 0.1).plan.clips[1]).toMatchObject({ out: 0.5 });
    expect(trimClip(p, 'c2', 'start', -2).plan.clips[1]).toMatchObject({ in: 0 });
    expect(trimClip(p, 'c1', 'end', 12).plan.clips[0]).toMatchObject({ seconds: 10 });
    // Los campos que no son de su tipo se ignoran.
    expect(updateClip(p, 'c1', { volume: 1 }).plan.clips[0]).not.toHaveProperty('volume');
    expect(updateClip(p, 'c1', { blur: undefined, motion: 'zoom-in' }).plan.clips[0]).toMatchObject({
      motion: 'zoom-in',
    });
  });

  it('textos, música y subtítulos escritos a mano', () => {
    let p = setMusic(sample(), 'o/m/media/m.m4a', fundido, ' Biblioteca de la marca ');
    expect(p.plan.music).toEqual({
      path: 'o/m/media/m.m4a',
      startAt: 0,
      volume: 0.35,
      fadeInSeconds: 0.5,
      fadeOutSeconds: 1,
      license: { confirmed: true, note: 'Biblioteca de la marca' },
    });
    expect(removeMusic(p).plan).not.toHaveProperty('music');
    p = addCue(p, 'c2', 1);
    expect(p.plan.clips[1]).toMatchObject({ subtitles: [{ start: 1, end: 3, text: 'Subtítulo' }] });
    const withText = { ...p, plan: { ...p.plan, texts: [{ ...textOf(), start: 1, end: 3 }] } };
    expect(trimText(withText, 't1', 'start', 5).plan.texts[0]).toMatchObject({ start: 2.8, end: 3 });
  });
});

function textOf() {
  return {
    id: 't1',
    text: 'Hola',
    start: 0,
    end: 2,
    position: 'bottom' as const,
    style: {
      sizeRatio: 0.06,
      color: '#FFFFFF',
      marginRatio: 0.2,
      maxWidthRatio: 0.84,
      lineHeight: 1.3,
      box: null,
      outline: null,
      fadeSeconds: 0.25,
    },
  };
}

describe('deshacer y rehacer', () => {
  it('cada cambio es un paso; los seguidos con la misma clave se juntan en uno', () => {
    let state = initEditor(sample());
    state = editorReducer(state, { type: 'change', change: (p) => moveClip(p, 0, 2) });
    state = editorReducer(state, { type: 'change', change: (p) => trimClip(p, 'c2', 'end', 3), merge: 'drag:1' });
    state = editorReducer(state, { type: 'change', change: (p) => trimClip(p, 'c2', 'end', 2.5), merge: 'drag:1' });
    state = editorReducer(state, { type: 'change', change: (p) => trimClip(p, 'c2', 'end', 2), merge: 'drag:1' });
    expect(state.past).toHaveLength(2);
    expect(state.project.plan.clips[0]).toMatchObject({ id: 'c2', out: 2 });
    state = editorReducer(state, { type: 'undo' });
    expect(state.project.plan.clips[0]).toMatchObject({ id: 'c2', out: 4 });
    state = editorReducer(state, { type: 'undo' });
    expect(state.project.plan.clips.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(editorReducer(state, { type: 'undo' })).toBe(state);
    state = editorReducer(state, { type: 'redo' });
    expect(state.project.plan.clips.map((c) => c.id)).toEqual(['c2', 'c3', 'c1']);
    // Un cambio nuevo borra lo que se podía rehacer.
    state = editorReducer(state, { type: 'change', change: (p) => moveClip(p, 0, 1) });
    expect(state.future).toEqual([]);
  });

  it('al soltar un arrastre, el siguiente cambio con la misma clave ya es otro paso; la selección sigue viva', () => {
    let state = initEditor(sample());
    state = editorReducer(state, { type: 'select', selection: { kind: 'clip', id: 'c2' } });
    state = editorReducer(state, { type: 'change', change: (p) => trimClip(p, 'c2', 'end', 3), merge: 'x' });
    state = editorReducer(state, { type: 'commit' });
    state = editorReducer(state, { type: 'change', change: (p) => trimClip(p, 'c2', 'end', 2), merge: 'x' });
    expect(state.past).toHaveLength(2);
    expect(state.selection).toEqual({ kind: 'clip', id: 'c2' });
    state = editorReducer(state, {
      type: 'change',
      change: (p) => ({ ...p, plan: { ...p.plan, clips: p.plan.clips.slice(0, 1) } }),
    });
    expect(state.selection).toBeNull();
  });
});

describe('vista previa', () => {
  it('compone cada instante como el motor: transiciones, movimiento de fotos y textos con su aparición', () => {
    const p = sample();
    const timeline = planTimeline(p.plan.clips, fundido, () => 10);
    // 2,5 + 4 + 2,5 − 2 fundidos de 0,5.
    expect(timeline.total).toBe(8);
    const size = { width: 360, height: 640 };
    const at = (t: number) => frameAt(t, p.plan, timeline, fundido, size);
    expect(at(1).layers.map((l) => [l.clip, l.alpha])).toEqual([[0, 1]]);
    // A mitad del fundido (2,25 s): el clip entra con media opacidad.
    expect(at(2.25).layers.map((l) => [l.clip, Number(l.alpha.toFixed(2))])).toEqual([
      [0, 1],
      [1, 0.5],
    ]);
    expect(at(3).layers[0]).toMatchObject({ clip: 1, sourceTime: 1 });
    expect(photoMotions(p.plan.clips, fundido)).toEqual(['zoom-in', null, 'pan-right']);
    const slide = {
      ...p,
      plan: {
        ...p.plan,
        clips: p.plan.clips.map((c) => ({ ...c, transition: { type: 'slideleft' as const, seconds: 0.5 } })),
      },
    };
    const s = frameAt(2.25, slide.plan, timeline, fundido, size);
    expect(s.layers.map((l) => [l.clip, l.dx])).toEqual([
      [0, -0.5],
      [1, 0.5],
    ]);
    expect(fadeAlpha(0.1, 0, 2, 0.25)).toBeCloseTo(0.4);
    expect(fadeAlpha(1, 0, 2, 0.25)).toBe(1);
    expect(musicGain(0.25, 8, { volume: 0.4, fadeInSeconds: 0.5, fadeOutSeconds: 1 })).toBeCloseTo(0.2);
    expect(musicGain(7.5, 8, { volume: 0.4, fadeInSeconds: 0.5, fadeOutSeconds: 1 })).toBeCloseTo(0.2);
  });

  it('avisa de lo que se verá distinto en el vídeo', () => {
    let p = sample();
    p = { ...p, plan: { ...p.plan, texts: [{ ...textOf(), style: { ...textOf().style, fontFamily: 'Titular' } }] } };
    p = updateClip(p, 'c1', { blur: 40 });
    const warnings = previewWarnings(p.plan, template('pase-lateral'), {
      loadedFamilies: [],
      brandReelFont: false,
      mimeOf: () => 'image/jpeg',
    });
    expect(warnings.join(' ')).toMatch(/desenfoque/);
    expect(warnings.join(' ')).toMatch(/«Titular» no se ha cargado/);
    expect(warnings.join(' ')).toMatch(/DejaVu Sans/);
  });
});

describe('subtítulos automáticos (sin red)', () => {
  const RATE = 16000;
  /** Tono entre `from` y `to` segundos dentro de `total` de silencio. */
  const signal = (total: number, spans: Array<[number, number]>) => {
    const s = new Float32Array(Math.round(total * RATE));
    for (const [from, to] of spans) {
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i += 1)
        s[i] = 0.3 * Math.sin((i / RATE) * 2 * Math.PI * 220);
    }
    return s;
  };

  it('corta la voz por las pausas y parte lo que pasa de 8 s', () => {
    const segments = speechSegments(
      signal(10, [
        [0.5, 2],
        [3, 4.2],
      ]),
      RATE,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]!.start).toBeCloseTo(0.5, 1);
    expect(segments[0]!.end).toBeCloseTo(2, 1);
    expect(segments[1]!.start).toBeCloseTo(3, 1);
    expect(speechSegments(signal(4, []), RATE)).toEqual([]);
    const long = speechSegments(signal(20, [[0, 19]]), RATE);
    expect(long.length).toBeGreaterThan(2);
    expect(Math.max(...long.map((s) => s.end - s.start))).toBeLessThanOrEqual(8.05);
  });

  it('escribe un WAV de 16 kHz mono y reparte un texto largo en subtítulos de dos líneas', () => {
    const wav = encodeWav(new Float32Array(1600), RATE);
    expect(wav.length).toBe(44 + 3200);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16000);
    const cues = splitCue('uno dos tres cuatro cinco seis siete ocho', 1, 3, 20);
    expect(cues.map((c) => c.text)).toEqual(['uno dos tres cuatro', 'cinco seis siete', 'ocho']);
    expect(cues[0]!.start).toBe(1);
    expect(cues[cues.length - 1]!.end).toBe(3);
  });
});
