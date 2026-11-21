// Informe mensual en PDF (Fase 5): se dibuja de verdad con pdf-lib y se
// vuelve a abrir para comprobarlo. El logotipo es una imagen real hecha con FFmpeg.
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentError } from '../src/errors.ts';
import { createReportPdfHandler, renderReportPdf, type ReportDocument } from '../src/handlers/report-pdf.ts';
import {
  BRAND,
  createBucket,
  inBrand,
  makePatternPhoto,
  ORG,
  OTHER_BRAND,
  runHandler,
  type Bucket,
} from './helpers/media.ts';

const DOCUMENT: ReportDocument = {
  version: 1,
  brandName: 'Marca de pruebas',
  colors: { primary: '#0F766E', secondary: '#B45309' },
  title: 'Informe de redes sociales',
  periodLabel: 'octubre de 2026',
  previousLabel: 'septiembre de 2026',
  generatedAt: '2026-11-03T06:17:00.000Z',
  kpis: [
    { label: 'Seguidores', value: '1.234', change: '+2 % frente al mes anterior', note: null },
    { label: 'Alcance', value: '15.300', change: '−12 % frente al mes anterior', note: 'estimación de Meta' },
    { label: 'Interacciones', value: '2.100', change: 'sin mes anterior', note: '28 de 31 días' },
  ],
  charts: [
    {
      title: 'Alcance diario (Instagram)',
      points: Array.from({ length: 31 }, (_, i) => ({
        label: String(i + 1),
        value: i % 7 === 3 ? null : 200 + ((i * 37) % 500),
      })),
    },
  ],
  posts: [
    {
      title: 'Mejores publicaciones del mes',
      columns: ['Pieza', 'Formato', 'Fecha', 'Alcance', 'Interacciones'],
      rows: [['Pan de otoño 🍞', 'Imagen', '04/10/2026', '800', '120']],
    },
  ],
  sections: [
    {
      title: 'Datos (cifras medidas)',
      kind: 'facts',
      items: Array.from(
        { length: 30 },
        (_, i) =>
          `Dato número ${i + 1}: una cifra medida con su comparación, larga para que haya que partir la línea en dos o más trozos.`,
      ),
    },
    { title: 'Hipótesis', kind: 'hypotheses', items: ['El alcance bajó: podría deberse a publicar menos.'] },
    { title: 'Lo que no se puede medir', kind: 'unmeasurable', items: ['Impresiones: Meta la retiró el 21/04/2025.'] },
  ],
  footer: 'Marca de pruebas · octubre de 2026 · Generado automáticamente.',
};

let bucket: Bucket;
beforeAll(async () => {
  bucket = await createBucket();
  await makePatternPhoto(bucket.file(inBrand('logo.png')), 320, 160);
});
afterAll(async () => {
  await bucket?.cleanup();
});

const payload = (extra: Record<string, unknown> = {}) => ({
  report_id: '44444444-4444-4444-8444-444444444444',
  revision: 1,
  document: DOCUMENT,
  logo: { path: inBrand('logo.png'), mime_type: 'image/png' },
  output: { path: `${ORG}/${BRAND}/informes/informe.pdf` },
  ...extra,
});

describe('informe en PDF', () => {
  it('dibuja varias páginas con el logotipo, los metadatos y caracteres que la tipografía no tiene', async () => {
    const result = (await runHandler(createReportPdfHandler(), bucket, payload())) as {
      output: { path: string; bytes: number; pages: number };
    };
    const bytes = await readFile(bucket.file(result.output.path));
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(result.output.bytes).toBe(bytes.length);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(result.output.pages);
    expect(result.output.pages).toBeGreaterThanOrEqual(2);
    expect(pdf.getTitle()).toBe('Informe de redes sociales · Marca de pruebas · octubre de 2026');
    expect(pdf.getAuthor()).toBe('Marca de pruebas');
    // El logotipo va incrustado como imagen.
    expect(bytes.toString('latin1')).toMatch(/\/Subtype \/Image/);
  });

  it('sin logotipo, o con uno que no existe, el informe sale igual', async () => {
    const sin = await renderReportPdf(DOCUMENT, null);
    expect(sin.pages).toBeGreaterThanOrEqual(2);
    const roto = await renderReportPdf(DOCUMENT, { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    expect(roto.pages).toBe(sin.pages);
    const result = (await runHandler(
      createReportPdfHandler(),
      bucket,
      payload({
        logo: { path: inBrand('no-existe.png'), mime_type: 'image/png' },
        output: { path: `${ORG}/${BRAND}/informes/otro.pdf` },
      }),
    )) as { output: { pages: number } };
    expect(result.output.pages).toBe(sin.pages);
  });

  it('un mes sin cifras también se dibuja', async () => {
    const vacio = await renderReportPdf(
      { ...DOCUMENT, kpis: [], charts: [{ title: 'Alcance', points: [] }], posts: [] },
      null,
    );
    expect(vacio.pages).toBeGreaterThanOrEqual(1);
  });

  it('rechaza sin reintento una carga inválida o una salida fuera de la marca', async () => {
    await expect(
      runHandler(createReportPdfHandler(), bucket, payload({ document: { ...DOCUMENT, version: 2 } })),
    ).rejects.toThrow(PermanentError);
    await expect(
      runHandler(
        createReportPdfHandler(),
        bucket,
        payload({ output: { path: `${ORG}/${OTHER_BRAND}/informes/x.pdf` } }),
      ),
    ).rejects.toThrow(/no pertenece a la marca/);
  });
});
