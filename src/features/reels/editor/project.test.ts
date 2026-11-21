import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateDuration, type ReelPiece } from '../plan';
import { REEL_TEMPLATES } from '../templates';
import {
  applyTemplate,
  buildRenderRequest,
  emptyProject,
  finalizeProject,
  isReelProject,
  migratePlanV1,
  parseProject,
  planSchema,
  planTimeline,
  projectProblems,
  ProjectError,
  textLayout,
  timelineSubtitles,
  wrapText,
  type ReelProject,
} from './project';

const template = (id: string) => REEL_TEMPLATES.find((t) => t.id === id)!;
/** Ejemplo compartido con el trabajador: los dos lados tienen que entenderlo igual. */
const fixture = JSON.parse(readFileSync(path.resolve(process.cwd(), 'worker/tests/fixtures/plan-v2.json'), 'utf8'));
const project = (plan: unknown = fixture): ReelProject =>
  ({ kind: 'reel', template: { id: 'fundido-suave' }, plan }) as ReelProject;

describe('plan v2: el ejemplo compartido con el trabajador', () => {
  it('es válido y su línea de tiempo coincide con la del motor', () => {
    expect(planSchema.safeParse(fixture).success).toBe(true);
    const timeline = planTimeline(project().plan.clips, template('fundido-suave'));
    // Foto 2 s · clip 0,5–2,5 (2 s) que entra deslizándose 0,4 s · foto 1,5 s con corte seco.
    expect(timeline).toEqual({ durations: [2, 2, 1.5], transitions: [0, 0.4, 0], starts: [0, 1.6, 3.6], total: 5.1 });
  });

  it('los subtítulos del clip se pasan al reel y lo que queda fuera del tramo no sale', () => {
    const p = project();
    const cues = timelineSubtitles(p.plan.clips, planTimeline(p.plan.clips, template('fundido-suave')));
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [1.7, 2.7, 'Hola desde la cocina'],
      [2.9, 3.5, 'Sale el arroz'],
    ]);
  });

  it('una transición nunca pasa de la mitad del elemento más corto que une', () => {
    const clips = [
      { id: 'a', type: 'photo' as const, path: 'o/m/a/x.jpg', seconds: 0.6 },
      {
        id: 'b',
        type: 'photo' as const,
        path: 'o/m/a/y.jpg',
        seconds: 3,
        transition: { type: 'fade' as const, seconds: 2 },
      },
    ];
    expect(planTimeline(clips, template('fundido-suave')).transitions).toEqual([0, 0.3]);
  });

  it('recorta el tramo de un clip a lo que dura el archivo', () => {
    const clips = [{ id: 'v', type: 'video' as const, path: 'o/m/a/v.mp4', in: 1, out: 9, volume: 1 }];
    expect(planTimeline(clips, template('corte-ritmico'), () => 4).durations).toEqual([3]);
  });
});

describe('migración del plan v1', () => {
  const v1 = {
    media: [
      { type: 'photo' as const, path: 'o/m/media/a.jpg', seconds: 2, blur: 20 },
      { type: 'video' as const, path: 'o/m/media/b.mp4', startAt: 0.5 },
      { type: 'photo' as const, path: 'o/m/media/c.jpg' },
    ],
    texts: [{ text: 'Hola', start: 0, end: 2 }],
    music: { path: 'o/m/media/m.m4a' },
  };

  it('pasa a v2 con la transición, el estilo y los volúmenes de la plantilla', () => {
    const t = template('fundido-suave');
    const plan = migratePlanV1(v1, t);
    expect(planSchema.safeParse(plan).success).toBe(true);
    expect(plan.clips[0]).toMatchObject({
      type: 'photo',
      seconds: 2,
      blur: 20,
      transition: { type: 'fade', seconds: 0.5 },
    });
    expect(plan.clips[1]).toMatchObject({ type: 'video', in: 0.5, out: 4.5, volume: 0 });
    expect(plan.clips[2]).toMatchObject({ type: 'photo', seconds: 2.5 });
    expect(plan.texts[0]).toMatchObject({ position: 'bottom', style: { sizeRatio: 0.06, box: { opacity: 0.55 } } });
    expect(plan.music).toEqual({
      path: 'o/m/media/m.m4a',
      startAt: 0,
      volume: 0.35,
      fadeInSeconds: 0.5,
      fadeOutSeconds: 1,
    });
  });

  it('da la misma duración que el cálculo de la pantalla de reels v1', () => {
    for (const t of REEL_TEMPLATES) {
      const pieces: ReelPiece[] = [
        { key: 'a', assetId: 'a', path: 'o/m/a.jpg', fileName: 'a', type: 'photo', seconds: 2, clipSeconds: null },
        { key: 'b', assetId: 'b', path: 'o/m/b.mp4', fileName: 'b', type: 'video', seconds: null, clipSeconds: 10 },
        { key: 'c', assetId: 'c', path: 'o/m/c.jpg', fileName: 'c', type: 'photo', seconds: null, clipSeconds: null },
      ];
      const plan = migratePlanV1(
        { media: pieces.map((p) => ({ type: p.type, path: p.path, ...(p.seconds ? { seconds: p.seconds } : {}) })) },
        t,
      );
      expect(planTimeline(plan.clips, t, () => 10).total).toBeCloseTo(estimateDuration(t, pieces).total, 3);
    }
  });
});

describe('lectura y comprobaciones del proyecto', () => {
  it('distingue un montaje de reel de un documento por capas', () => {
    expect(isReelProject(project())).toBe(true);
    expect(isReelProject({ schemaVersion: 4, pages: [] })).toBe(false);
    expect(() => parseProject({ schemaVersion: 4 })).toThrow(ProjectError);
    expect(() => parseProject({ kind: 'reel', template: { id: 'x' }, plan: { version: 3 } })).toThrow(/más nueva/);
    expect(() =>
      parseProject({ kind: 'reel', template: { id: 'fundido-suave' }, plan: { version: 2, clips: [] } }),
    ).toThrow(/no es válido/);
    expect(parseProject(project()).plan.clips).toHaveLength(3);
  });

  it('pide licencia de la música, al menos un elemento y no pasar de 90 s', () => {
    const t = template('fundido-suave');
    expect(projectProblems(emptyProject(t), t)).toContain('Añade al menos una foto o un clip.');
    const noLicense = project({ ...fixture, music: { ...fixture.music, license: undefined } });
    expect(projectProblems(noLicense, t)).toContain(
      'Confirma que la marca tiene licencia para usar la música elegida.',
    );
    const long = project({
      ...fixture,
      clips: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, type: 'photo', path: 'o/m/a/x.jpg', seconds: 10 })),
    });
    expect(projectProblems(long, t).join(' ')).toMatch(/máximo es 90 s/);
    expect(projectProblems(project(), t)).toEqual([]);
  });

  it('aplicar una plantilla cambia transiciones, duración de fotos y estilo, pero conserva tipografía y color', () => {
    const p = applyTemplate(project(), template('corte-ritmico'));
    expect(p.template.id).toBe('corte-ritmico');
    expect(p.plan.clips.map((c) => c.transition?.type)).toEqual(['cut', 'cut', 'cut']);
    expect(p.plan.clips[0]).toMatchObject({ seconds: 1.5 });
    expect(p.plan.clips[1]).toMatchObject({ volume: 0.6, in: 0.5, out: 2.5 });
    expect(p.plan.texts[0]!.style).toMatchObject({ color: '#FFD400', fontFamily: 'Prueba', sizeRatio: 0.085 });
    expect(p.plan.music).toMatchObject({ volume: 0.45, fadeInSeconds: 0.2, license: { confirmed: true } });
  });

  it('el encargo lleva la plantilla, el plan validado y la pieza', () => {
    const request = buildRenderRequest(project(), { id: '0b5c1f7e-0000-4000-8000-000000000001', version: 3 }) as {
      plan: { version: number };
      content: unknown;
    };
    expect(request.plan.version).toBe(2);
    expect(request.content).toEqual({ id: '0b5c1f7e-0000-4000-8000-000000000001', version: 3 });
    expect(() => finalizeProject(project({ ...fixture, clips: [] }))).toThrow(ProjectError);
  });
});

describe('texto: mismas cuentas que el motor', () => {
  it('corta las líneas y coloca el bloque como FFmpeg', () => {
    const style = { sizeRatio: 0.06, lineHeight: 1.3, maxWidthRatio: 0.84, marginRatio: 0.2 };
    expect(textLayout(style, 'bottom', 2, 270, 480)).toEqual({ fontSize: 16, lineStep: 21, maxChars: 25, top: 347 });
    expect(wrapText('Hoy, menú del día con arroz y postre casero', 16)).toEqual([
      'Hoy, menú del',
      'día con arroz y',
      'postre casero',
    ]);
  });
});
