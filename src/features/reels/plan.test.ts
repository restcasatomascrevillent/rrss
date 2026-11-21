import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JobStatus } from '@/lib/database.types';
import {
  buildReelInput,
  describeJob,
  estimateDuration,
  jobPieceCount,
  jobTemplateName,
  reelProblems,
  type MediaJobSummary,
  type ReelPiece,
  type ReelText,
} from './plan';
import { parseTemplates, REEL_TEMPLATES } from './templates';

const template = (id: string) => REEL_TEMPLATES.find((t) => t.id === id)!;
let k = 0;
const photo = (seconds: number | null = null): ReelPiece => ({
  key: `p${++k}`,
  assetId: `a${k}`,
  path: `org/marca/media/foto-${k}.jpg`,
  fileName: `foto-${k}.jpg`,
  type: 'photo',
  seconds,
  clipSeconds: null,
});
const clip = (clipSeconds: number | null, seconds: number | null = null): ReelPiece => ({
  ...photo(seconds),
  type: 'video',
  clipSeconds,
});
const text = (overrides: Partial<ReelText> = {}): ReelText => ({
  key: `t${++k}`,
  text: 'Menú del día',
  start: 0.5,
  end: 3,
  position: null,
  ...overrides,
});

describe('plantillas: una sola fuente de verdad', () => {
  it('la aplicación ofrece exactamente las plantillas del trabajador (worker/templates)', () => {
    const files = readdirSync(path.resolve(process.cwd(), 'worker/templates'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(REEL_TEMPLATES.map((t) => t.id).sort()).toEqual(files);
    for (const t of REEL_TEMPLATES) {
      expect(t.name).not.toBe('');
      expect(t.description).not.toBe('');
      expect(t.timing.maxTotalSeconds).toBeGreaterThan(0);
    }
  });

  it('una plantilla mal formada no pasa en silencio', () => {
    expect(() => parseTemplates({ 'rota.json': { schemaVersion: 2, id: 'rota' } })).toThrow(/rota\.json/);
  });
});

describe('duración estimada (como la calcula el motor del trabajador)', () => {
  it('fotos con fundido: las transiciones solapan las piezas', () => {
    expect(estimateDuration(template('fundido-suave'), [photo(), photo()]).total).toBe(4.5);
    expect(estimateDuration(template('fundido-suave'), [photo()]).total).toBe(2.5);
    expect(estimateDuration(template('fundido-suave'), []).total).toBe(0);
  });

  it('un clip no pasa de lo que dura ni del máximo de la plantilla; la transición, de media pieza', () => {
    // Clip de 3 s (la plantilla toma hasta 4): 1 + 3 − 0,5.
    expect(estimateDuration(template('fundido-suave'), [photo(1), clip(3)]).total).toBe(3.5);
    // Sin duración conocida se supone el máximo de la plantilla.
    expect(estimateDuration(template('fundido-suave'), [clip(null)]).total).toBe(4);
  });

  it('corte seco: sin solapes', () => {
    expect(estimateDuration(template('corte-ritmico'), [photo(), photo(), photo()]).total).toBe(4.5);
  });
});

describe('comprobaciones antes de encargar', () => {
  it('sin piezas, con demasiadas o pasándose del máximo no se encarga', () => {
    expect(reelProblems(template('fundido-suave'), [], [])).toEqual(['Añade al menos una foto o un clip.']);
    const many = Array.from({ length: 14 }, () => photo());
    expect(reelProblems(template('corte-ritmico'), many, [])).toEqual([
      'El reel duraría 21 s y la plantilla admite 20 s como máximo.',
    ]);
    expect(reelProblems(undefined, [photo()], [])).toContain('Elige una plantilla.');
    expect(reelProblems(template('fundido-suave'), [photo()], [])).toEqual([]);
  });

  it('los textos tienen contenido y terminan después de empezar', () => {
    const t = template('fundido-suave');
    expect(reelProblems(t, [photo()], [text({ text: '  ' })])).toEqual(['El texto 1 está vacío.']);
    expect(reelProblems(t, [photo()], [text({ start: 2, end: 2 })])).toEqual([
      'El texto 1 debe terminar después de empezar.',
    ]);
  });
});

describe('petición a request_media_job', () => {
  it('solo plantilla y plan; segundos y posición solo si se han elegido; sin salida', () => {
    const pieces = [photo(2), clip(5)];
    const input = buildReelInput(
      template('pase-lateral'),
      pieces,
      [text({ text: ' Hola ', position: 'top' })],
      'm.m4a',
    );
    expect(input).toEqual({
      template: { id: 'pase-lateral' },
      plan: {
        media: [
          { type: 'photo', path: pieces[0]!.path, seconds: 2 },
          { type: 'video', path: pieces[1]!.path },
        ],
        texts: [{ text: 'Hola', start: 0.5, end: 3, position: 'top' }],
        music: { path: 'm.m4a' },
      },
    });
    expect(buildReelInput(template('pase-lateral'), [photo()], [], null)).not.toHaveProperty('plan.music');
  });

  it('el desenfoque solo viaja en fotos con valor mayor que 0 y no pasa de 100', () => {
    const blurred = { ...photo(), blur: 40 };
    const input = buildReelInput(
      template('pase-lateral'),
      [blurred, { ...photo(), blur: 0 }, { ...clip(5), blur: 50 }, { ...photo(), blur: 250 }],
      [],
      null,
    ) as { plan: { media: Array<Record<string, unknown>> } };
    expect(input.plan.media.map((m) => m.blur)).toEqual([40, undefined, undefined, 100]);
    expect(input.plan.media[1]).not.toHaveProperty('blur');
  });
});

describe('estado de un trabajo', () => {
  const job = (status: JobStatus, extra: Partial<MediaJobSummary> = {}): MediaJobSummary => ({
    id: 'j1',
    kind: 'media.reel.template',
    status,
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    result: null,
    payload: { template: { id: 'fundido-suave' }, plan: { media: [{}, {}, {}] } },
    created_at: '2026-11-18T10:00:00Z',
    ...extra,
  });

  it('en cola, montando, listo (con su recurso) y falló (con su motivo)', () => {
    expect(describeJob(job('queued'))).toMatchObject({ label: 'En cola', tone: 'progress', assetId: null });
    expect(describeJob(job('running', { attempts: 1 }))).toMatchObject({ label: 'Montando' });
    expect(describeJob(job('succeeded', { result: { assets: [{ id: 'asset-9', path: 'x' }] } }))).toMatchObject({
      label: 'Listo',
      tone: 'success',
      assetId: 'asset-9',
    });
    expect(describeJob(job('failed', { last_error: 'El reel pesa 61 MB' }))).toMatchObject({
      label: 'Falló',
      tone: 'danger',
      detail: 'El reel pesa 61 MB',
    });
    expect(describeJob(job('queued', { attempts: 1, last_error: 'Sin red' }))).toMatchObject({
      label: 'En cola (reintento)',
      detail: 'Sin red',
    });
  });

  it('nombre de la plantilla y número de piezas', () => {
    expect(jobTemplateName(job('queued'), REEL_TEMPLATES)).toBe('Fundido suave');
    expect(jobTemplateName(job('queued', { payload: { template: { id: 'retirada' } } }), REEL_TEMPLATES)).toBe(
      'retirada',
    );
    expect(jobPieceCount(job('queued'))).toBe(3);
  });
});
