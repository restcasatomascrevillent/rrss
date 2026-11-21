// Plan v2 del editor de reels: esquema, migración del v1 y línea de tiempo
// (sin FFmpeg), y montaje real con recortes, textos con estilo propio,
// subtítulos quemados, mezcla de sonido y transiciones mixtas (con FFmpeg).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReel, planTimeline, timelineSubtitles, type ResolvedClip } from '../src/reel/build.ts';
import {
  migratePlanV1,
  planAsV2,
  reelPayloadSchema,
  reelPlanSchema,
  reelPlanV2Schema,
  type ReelPlanV2,
} from '../src/reel/schema.ts';
import { loadTemplates } from '../src/reel/templates.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Ejemplo compartido con la aplicación (src/features/reels/editor/project.test.ts). */
export const FIXTURE = JSON.parse(readFileSync(path.join(here, 'fixtures/plan-v2.json'), 'utf8')) as ReelPlanV2;
const templates = loadTemplates();
const fundido = templates.get('fundido-suave')!;

/** Clips del ejemplo como si ya estuvieran bajados (el vídeo dura 3 s y trae sonido). */
function resolved(plan: ReelPlanV2): ResolvedClip[] {
  return plan.clips.map((clip, index) =>
    clip.type === 'photo'
      ? { ...clip, file: `media-${index}.jpg`, orientation: 1 }
      : { ...clip, file: `media-${index}.mp4`, durationSeconds: 3, hasAudio: true },
  );
}

describe('plan v2 (sin FFmpeg)', () => {
  it('el ejemplo compartido es válido y su línea de tiempo es la misma que calcula la aplicación', () => {
    const plan = reelPlanV2Schema.parse(FIXTURE);
    const timeline = planTimeline(resolved(plan), fundido);
    expect(timeline).toEqual({ durations: [2, 2, 1.5], transitions: [0, 0.4, 0], starts: [0, 1.6, 3.6], total: 5.1 });
    expect(timelineSubtitles(resolved(plan), timeline).map((c) => [c.start, c.end, c.text])).toEqual([
      [1.7, 2.7, 'Hola desde la cocina'],
      [2.9, 3.5, 'Sale el arroz'],
    ]);
  });

  it('la carga admite v1 y v2, y rechaza un v2 con tramos imposibles o campos de más', () => {
    const output = { path: 'o/m/reels/x.mp4' };
    expect(reelPayloadSchema.safeParse({ template: { id: 'fundido-suave' }, plan: FIXTURE, output }).success).toBe(
      true,
    );
    const v1 = { media: [{ type: 'photo', path: 'o/m/media/a.jpg' }] };
    expect(reelPayloadSchema.safeParse({ template: { id: 'fundido-suave' }, plan: v1, output }).success).toBe(true);
    const short = { ...FIXTURE, clips: [{ ...FIXTURE.clips[1], in: 1, out: 1.2 }] };
    expect(reelPlanV2Schema.safeParse(short).success).toBe(false);
    expect(reelPlanV2Schema.safeParse({ ...FIXTURE, cliente: 'x' }).success).toBe(false);
    expect(
      reelPayloadSchema.safeParse({
        template: { id: 'fundido-suave' },
        plan: FIXTURE,
        content: { id: 'no-es-un-uuid', version: 1 },
        output,
      }).success,
    ).toBe(false);
  });

  it('migra el plan v1 a v2 con lo que decidía la plantilla, y el motor da la misma línea de tiempo', () => {
    const v1 = reelPlanSchema.parse({
      media: [
        { type: 'photo', path: 'o/m/media/a.jpg', seconds: 2 },
        { type: 'video', path: 'o/m/media/b.mp4', startAt: 0.5, seconds: 2 },
        { type: 'photo', path: 'o/m/media/c.jpg', seconds: 2, blur: 40 },
      ],
      texts: [{ text: 'Hola', start: 0.3, end: 2.5 }],
      music: { path: 'o/m/media/m.m4a' },
      fontPath: 'o/m/fonts/marca.ttf',
    });
    const v2 = migratePlanV1(v1, fundido);
    expect(reelPlanV2Schema.safeParse(v2).success).toBe(true);
    expect(planAsV2(v1, fundido)).toEqual(v2);
    expect(v2.clips[1]).toMatchObject({ type: 'video', in: 0.5, out: 2.5, volume: 0 });
    expect(v2.music).toMatchObject({ volume: 0.35, fadeInSeconds: 0.5, fadeOutSeconds: 1 });
    expect(v2.fontPath).toBe('o/m/fonts/marca.ttf');

    // Mismo resultado por los dos caminos del motor.
    const legacy = buildReel({
      template: fundido,
      media: [
        { type: 'photo', file: 'a.jpg', orientation: 1, seconds: 2 },
        { type: 'video', file: 'b.mp4', startAt: 0.5, seconds: 2, durationSeconds: 3, hasAudio: true },
        { type: 'photo', file: 'c.jpg', orientation: 1, seconds: 2, blur: 40 },
      ],
      texts: [{ text: 'Hola', start: 0.3, end: 2.5 }],
      fontFile: 'font.ttf',
      outputFile: 'r.mp4',
    });
    const migrated = buildReel({
      template: fundido,
      plan: {
        clips: resolved(v2),
        texts: v2.texts,
      },
      fontFile: 'font.ttf',
      maxTotalSeconds: fundido.timing.maxTotalSeconds,
      outputFile: 'r.mp4',
    });
    expect(migrated.filterGraph).toBe(legacy.filterGraph);
    expect(migrated.timeline).toEqual(legacy.timeline);
  });

  it('une con concat los cortes y con xfade las transiciones, y quema los subtítulos con drawtext', () => {
    const build = buildReel({
      template: fundido,
      plan: { clips: resolved(FIXTURE), texts: FIXTURE.texts, subtitles: FIXTURE.subtitles },
      fontFile: 'font.ttf',
      outputFile: 'r.mp4',
      outputWidth: 270,
    });
    expect(build.durationSeconds).toBe(5.1);
    expect(build.filterGraph).toContain('[v0][v1]xfade=transition=slideleft:duration=0.4:offset=1.6[x1]');
    expect(build.filterGraph).toContain('[x1][v2]concat=n=2:v=1:a=0[x2]');
    expect(build.subtitles).toEqual([
      { start: 1.7, end: 2.7, text: 'Hola desde la cocina' },
      { start: 2.9, end: 3.5, text: 'Sale el arroz' },
    ]);
    expect(build.textFiles.map((f) => f.name)).toEqual(['text-0-0.txt', 'sub-0-0.txt', 'sub-1-0.txt']);
    // El texto amarillo con su tamaño; el clip arranca en su punto de entrada y suena al 80 %.
    expect(build.filterGraph).toContain('fontcolor=0xFFD400');
    expect(build.args.join(' ')).toContain('-ss 0.5 -t 3');
    expect(build.filterGraph).toMatch(/\[1:a\]atrim=duration=2,.*volume=0\.8/);
    expect(build.filterGraph).toContain('adelay=1600:all=1');
    // Con los subtítulos apagados no se dibuja ninguno.
    const off = buildReel({
      template: fundido,
      plan: { clips: resolved(FIXTURE), texts: [], subtitles: { ...FIXTURE.subtitles!, enabled: false } },
      outputFile: 'r.mp4',
    });
    expect(off.textFiles).toEqual([]);
  });

  it('un clip silenciado no entra en la mezcla y los 90 s son el máximo de un plan v2', () => {
    const muted = FIXTURE.clips.map((c) => (c.type === 'video' ? { ...c, volume: 0 } : c));
    const build = buildReel({
      template: fundido,
      plan: { clips: resolved({ ...FIXTURE, clips: muted }), texts: [] },
      outputFile: 'r.mp4',
    });
    expect(build.filterGraph).not.toContain('aclip');
    const long = Array.from({ length: 10 }, (_, i) => ({
      type: 'photo' as const,
      file: `f${i}.jpg`,
      orientation: 1,
      seconds: 10,
    }));
    expect(() => buildReel({ template: fundido, plan: { clips: long, texts: [] }, outputFile: 'r.mp4' })).toThrow(
      /90 s como máximo/,
    );
  });
});

describe('plan v2 tal como lo guarda la base de datos', () => {
  it('acepta un texto sin contorno ni franja: request_media_job quita los null (jsonb_strip_nulls)', () => {
    // Encargo real que falló en staging el 21/11/2026 con «plan: Invalid input».
    const payload = {
      plan: {
        version: 2,
        clips: [
          { id: 'c1', type: 'photo', path: 'org/brand/media/foto.jpg', seconds: 2.5, transition: { type: 'fade', seconds: 0.5 } },
        ],
        texts: [
          {
            id: 't1',
            text: 'Texto',
            start: 0,
            end: 2,
            position: 'bottom',
            style: {
              color: '#394147',
              sizeRatio: 0.06,
              lineHeight: 1.45,
              fadeSeconds: 0.3,
              marginRatio: 0.22,
              maxWidthRatio: 0.8,
              box: { color: '#000000', opacity: 0.55, paddingRatio: 0.35 },
            },
          },
        ],
      },
      output: { path: 'org/brand/reels/salida.mp4' },
      content: { id: '3f9f60de-72da-479e-98dc-0ce92e4056cd', version: 1 },
      template: { id: 'fundido-suave' },
    };
    const parsed = reelPayloadSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const plan = parsed.data!.plan as { texts: Array<{ style: { outline: unknown; box: unknown } }> };
    expect(plan.texts[0]!.style.outline).toBeNull();
    const sinFranja = structuredClone(payload);
    delete (sinFranja.plan.texts[0]!.style as { box?: unknown }).box;
    const parsed2 = reelPayloadSchema.safeParse(sinFranja);
    expect(parsed2.success).toBe(true);
    expect((parsed2.data!.plan as typeof plan).texts[0]!.style.box).toBeNull();
  });
});
