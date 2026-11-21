// Informe mensual de analítica en PDF (Fase 5). El trabajo `media.report.pdf`
// lo encola la base de datos (`analytics_report_render`) con el documento ya
// redactado por la función `social-insights`: textos, cifras formateadas y
// series de los gráficos. Aquí solo se dibuja; nada se decide ni se calcula.
//
// Biblioteca: pdf-lib 1.17.1 (licencia MIT; sus dependencias son MIT, 0BSD y
// MIT+Zlib), en JavaScript puro, sin binarios. Tipografía Helvetica de las 14
// estándar de PDF (codificación WinAnsi: admite las letras del español; lo que
// no cabe —emojis— se sustituye por «?»).
//
// Portada con los colores y el logotipo de la marca (si es PNG o JPEG), cifras
// principales, gráficos de barras diarios, mejores y peores publicaciones,
// datos, hipótesis, avisos y lo que no se puede medir.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import { z } from 'zod';
import type { Handler } from '../handler.ts';
import { assertOutputPaths, fetchInput, parsePayload, storagePathSchema, storeOutput } from './shared.ts';

export const REPORT_PDF_KIND = 'media.report.pdf';

const text = (max: number) => z.string().max(max);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const reportDocumentSchema = z.object({
  version: z.literal(1),
  brandName: text(200),
  colors: z.object({ primary: hex, secondary: hex }),
  title: text(200),
  periodLabel: text(100),
  previousLabel: text(100),
  generatedAt: text(40),
  kpis: z
    .array(z.object({ label: text(80), value: text(40), change: text(120).nullable(), note: text(200).nullable() }))
    .max(12),
  charts: z
    .array(
      z.object({
        title: text(120),
        points: z.array(z.object({ label: text(10), value: z.number().nonnegative().nullable() })).max(62),
      }),
    )
    .max(4),
  posts: z
    .array(
      z.object({
        title: text(120),
        columns: z.array(text(40)).max(6),
        rows: z.array(z.array(text(120)).max(6)).max(10),
      }),
    )
    .max(4),
  sections: z
    .array(
      z.object({
        title: text(120),
        kind: z.enum(['facts', 'hypotheses', 'caveats', 'unmeasurable']),
        items: z.array(text(700)).max(80),
      }),
    )
    .max(8),
  footer: text(300),
});
export type ReportDocument = z.infer<typeof reportDocumentSchema>;

export const reportPdfPayloadSchema = z.object({
  report_id: z.string().uuid(),
  revision: z.number().int().positive(),
  document: reportDocumentSchema,
  logo: z
    .object({ path: storagePathSchema, mime_type: z.enum(['image/png', 'image/jpeg']) })
    .nullable()
    .optional(),
  output: z.strictObject({ path: storagePathSchema }),
});

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const INK = rgb(0.12, 0.13, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.85, 0.87, 0.9);

function hexToRgb(value: string): RGB {
  const n = Number.parseInt(value.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Texto claro u oscuro según lo luminoso que sea el fondo. */
function onColor(value: string): RGB {
  const n = Number.parseInt(value.slice(1), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.6 ? INK : rgb(1, 1, 1);
}

/** Dibuja el informe y devuelve los bytes del PDF y su número de páginas. */
export async function renderReportPdf(
  document: ReportDocument,
  logo: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' } | null,
): Promise<{ bytes: Uint8Array; pages: number }> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${document.title} · ${document.brandName} · ${document.periodLabel}`);
  pdf.setAuthor(document.brandName);
  pdf.setSubject(`Analítica de ${document.periodLabel}`);
  pdf.setProducer('rrss');
  pdf.setCreationDate(new Date(document.generatedAt));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(regular.getCharacterSet());
  const clean = (s: string) =>
    [...s.normalize('NFC')].map((ch) => (charset.has(ch.codePointAt(0)!) ? ch : ch === '\n' ? ' ' : '?')).join('');

  const primary = hexToRgb(document.colors.primary);
  const secondary = hexToRgb(document.colors.secondary);

  let image: PDFImage | null = null;
  if (logo) {
    try {
      image = logo.mime === 'image/png' ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes);
    } catch {
      image = null; // Un logotipo ilegible no impide el informe.
    }
  }

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([A4.width, A4.height]);
    pages.push(page);
    page.drawRectangle({ x: 0, y: A4.height - 6, width: A4.width, height: 6, color: primary });
    y = A4.height - MARGIN;
  };
  const ensure = (height: number) => {
    if (y - height < MARGIN + 24) newPage();
  };
  const width = (s: string, font: PDFFont, size: number) => font.widthOfTextAtSize(clean(s), size);
  const wrap = (s: string, font: PDFFont, size: number, max: number): string[] => {
    const lines: string[] = [];
    let line = '';
    for (const word of clean(s).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= max) line = next;
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  };
  const write = (
    s: string,
    opts: { x?: number; size?: number; font?: PDFFont; color?: RGB; max?: number; gap?: number } = {},
  ) => {
    const size = opts.size ?? 10;
    const font = opts.font ?? regular;
    const x = opts.x ?? MARGIN;
    for (const line of wrap(s, font, size, opts.max ?? A4.width - x - MARGIN)) {
      ensure(size + 4);
      page.drawText(line, { x, y: y - size, size, font, color: opts.color ?? INK });
      y -= size + (opts.gap ?? 4);
    }
  };

  // ── Portada ──
  newPage();
  const bandHeight = 220;
  page.drawRectangle({ x: 0, y: A4.height - bandHeight, width: A4.width, height: bandHeight, color: primary });
  const fg = onColor(document.colors.primary);
  let titleX = MARGIN;
  if (image) {
    const box = 96;
    const scale = Math.min(box / image.width, box / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    page.drawRectangle({
      x: MARGIN - 6,
      y: A4.height - 60 - box - 6,
      width: box + 12,
      height: box + 12,
      color: rgb(1, 1, 1),
    });
    page.drawImage(image, { x: MARGIN + (box - w) / 2, y: A4.height - 60 - box + (box - h) / 2, width: w, height: h });
    titleX = MARGIN + box + 28;
  }
  const maxTitle = A4.width - titleX - MARGIN;
  let ty = A4.height - 80;
  for (const line of wrap(document.brandName, bold, 26, maxTitle).slice(0, 2)) {
    page.drawText(line, { x: titleX, y: ty, size: 26, font: bold, color: fg });
    ty -= 32;
  }
  page.drawText(clean(document.title), { x: titleX, y: ty, size: 14, font: regular, color: fg });
  ty -= 22;
  page.drawText(clean(document.periodLabel.charAt(0).toUpperCase() + document.periodLabel.slice(1)), {
    x: titleX,
    y: ty,
    size: 18,
    font: bold,
    color: fg,
  });
  page.drawRectangle({ x: 0, y: A4.height - bandHeight - 6, width: A4.width, height: 6, color: secondary });
  y = A4.height - bandHeight - 36;

  // Cifras principales (dos columnas).
  write('Cifras del mes', { size: 14, font: bold });
  y -= 6;
  const colW = (A4.width - 2 * MARGIN - 16) / 2;
  const cardH = 70;
  if (!document.kpis.length) write('Todavía no hay cifras de este mes.', { color: MUTED });
  for (let i = 0; i < document.kpis.length; i += 2) {
    ensure(cardH + 10);
    for (let c = 0; c < 2; c++) {
      const kpi = document.kpis[i + c];
      if (!kpi) continue;
      const x = MARGIN + c * (colW + 16);
      page.drawRectangle({ x, y: y - cardH, width: colW, height: cardH, borderColor: LINE, borderWidth: 1 });
      page.drawRectangle({ x, y: y - cardH, width: 4, height: cardH, color: primary });
      page.drawText(clean(kpi.label), { x: x + 14, y: y - 16, size: 9, font: regular, color: MUTED });
      page.drawText(clean(kpi.value), { x: x + 14, y: y - 38, size: 18, font: bold, color: INK });
      const extra = [kpi.change, kpi.note].filter(Boolean).join(' · ');
      if (extra) {
        const line = wrap(extra, regular, 8, colW - 24)[0]!;
        page.drawText(line, { x: x + 14, y: y - 56, size: 8, font: regular, color: MUTED });
      }
    }
    y -= cardH + 10;
  }

  // ── Gráficos de barras ──
  for (const chart of document.charts) {
    const values = chart.points.map((p) => p.value).filter((v): v is number => v !== null);
    const chartH = 150;
    ensure(chartH + 50);
    y -= 10;
    write(chart.title, { size: 12, font: bold });
    if (!values.length) {
      write('Sin cifras en este mes.', { color: MUTED });
      continue;
    }
    const max = Math.max(...values, 1);
    const left = MARGIN + 34;
    const innerW = A4.width - left - MARGIN;
    const base = y - chartH;
    page.drawLine({ start: { x: left, y: base }, end: { x: left + innerW, y: base }, thickness: 0.8, color: LINE });
    page.drawText(clean(String(Math.round(max))), {
      x: MARGIN,
      y: base + chartH - 8,
      size: 7,
      font: regular,
      color: MUTED,
    });
    page.drawText('0', { x: MARGIN, y: base, size: 7, font: regular, color: MUTED });
    const step = innerW / Math.max(1, chart.points.length);
    chart.points.forEach((p, i) => {
      const x = left + i * step + step * 0.15;
      if (p.value !== null) {
        const h = (p.value / max) * (chartH - 12);
        page.drawRectangle({ x, y: base, width: step * 0.7, height: Math.max(0.5, h), color: primary });
      }
      if (i % Math.ceil(chart.points.length / 10) === 0) {
        page.drawText(clean(p.label), { x, y: base - 10, size: 7, font: regular, color: MUTED });
      }
    });
    y = base - 18;
    if (chart.points.some((p) => p.value === null)) {
      write('Los días sin barra no tienen cifra (todavía no medidos o sin dato de Meta).', { size: 8, color: MUTED });
    }
  }

  // ── Tablas de publicaciones ──
  for (const table of document.posts) {
    ensure(40 + 18 * Math.min(3, table.rows.length));
    y -= 10;
    write(table.title, { size: 12, font: bold });
    const widths = [0.42, 0.12, 0.14, 0.15, 0.17].map((f) => f * (A4.width - 2 * MARGIN));
    const row = (cells: string[], font: PDFFont, color: RGB) => {
      ensure(18);
      let x = MARGIN;
      cells.forEach((cell, i) => {
        const w = widths[i] ?? 60;
        const fitted = wrap(cell, font, 8.5, w - 6)[0]!;
        page.drawText(fitted, { x, y: y - 10, size: 8.5, font, color });
        x += w;
      });
      y -= 16;
      page.drawLine({
        start: { x: MARGIN, y: y + 3 },
        end: { x: A4.width - MARGIN, y: y + 3 },
        thickness: 0.4,
        color: LINE,
      });
    };
    row(table.columns, bold, MUTED);
    for (const r of table.rows) row(r, regular, INK);
  }

  // ── Secciones de texto ──
  for (const section of document.sections) {
    ensure(50);
    y -= 14;
    write(section.title, { size: 12, font: bold, color: section.kind === 'hypotheses' ? secondary : INK });
    if (section.kind === 'hypotheses') {
      write('Son interpretaciones a partir de las cifras, no conclusiones demostradas.', { size: 8.5, color: MUTED });
    }
    y -= 2;
    for (const item of section.items) {
      ensure(14);
      const mark = section.kind === 'facts' ? 'Dato' : section.kind === 'hypotheses' ? 'Hipótesis' : '·';
      const markWidth = width(mark, bold, 8.5) + 6;
      page.drawText(clean(mark), {
        x: MARGIN,
        y: y - 9.5,
        size: 8.5,
        font: bold,
        color: section.kind === 'hypotheses' ? secondary : MUTED,
      });
      write(item, { x: MARGIN + Math.max(markWidth, 14), size: 9.5, gap: 3 });
      y -= 3;
    }
  }

  // Pie en todas las páginas.
  pages.forEach((p, i) => {
    const footer = `${clean(document.footer)}  ·  Página ${i + 1} de ${pages.length}`;
    const lines = wrap(footer, regular, 7, A4.width - 2 * MARGIN);
    lines
      .slice(0, 2)
      .forEach((line, j) => p.drawText(line, { x: MARGIN, y: 24 - j * 9, size: 7, font: regular, color: MUTED }));
  });

  return { bytes: await pdf.save(), pages: pages.length };
}

export function createReportPdfHandler(): Handler {
  return {
    kind: REPORT_PDF_KIND,
    async run(context) {
      const payload = parsePayload(reportPdfPayloadSchema, context.job.payload);
      assertOutputPaths(context, [payload.output.path]);
      let logo: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' } | null = null;
      if (payload.logo) {
        try {
          const file = await fetchInput(context, payload.logo.path, 'logo');
          logo = { bytes: await readFile(file), mime: payload.logo.mime_type };
        } catch (error) {
          // Sin logotipo el informe sigue siendo útil: se avisa en el registro y se sigue.
          context.log.warn('report.logo_unavailable', { error: (error as Error).message });
        }
      }
      const { bytes, pages } = await renderReportPdf(payload.document, logo);
      const file = path.join(context.workDir, 'informe.pdf');
      await writeFile(file, bytes);
      const size = await storeOutput(context, file, payload.output.path, 'application/pdf');
      return { output: { path: payload.output.path, bytes: size, pages } };
    },
  };
}
