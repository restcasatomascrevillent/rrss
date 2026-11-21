// Texto de una fuente de conocimiento de la marca (`source.extract`): PDF,
// Word (.docx), texto plano o web. Determinista, sin IA. El texto va en el
// resultado y la base de datos lo mueve a la fuente al cerrar el trabajo
// (migración 20261119210000_source_text_extraction).
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { PermanentError } from '../errors.ts';
import { extractDocxText, extractPdfText } from '../extract/documents.ts';
import { assertFetchableUrl } from '../extract/net.ts';
import { capText, decodePlainText, normalizeText } from '../extract/text.ts';
import { crawlWebsite, DEFAULT_CRAWL, type CrawlOptions } from '../extract/web.ts';
import type { Handler } from '../handler.ts';
import { fetchInput, parsePayload, storagePathSchema } from './shared.ts';

export const SOURCE_EXTRACT_KIND = 'source.extract';

/** Tamaño máximo de un archivo de fuente que se analiza (el del cubo). */
export const MAX_SOURCE_FILE_BYTES = 50 * 1024 * 1024;

export const sourceExtractPayloadSchema = z
  .strictObject({
    source_id: z.uuid(),
    format: z.enum(['pdf', 'docx', 'text', 'website']),
    path: storagePathSchema.optional(),
    url: z.string().max(2000).optional(),
  })
  .refine((p) => (p.format === 'website' ? Boolean(p.url) && !p.path : Boolean(p.path) && !p.url), {
    message: 'Una web lleva `url`; un archivo, `path`',
  });

export interface SourceExtractDeps {
  /** Opciones de la lectura de webs (en pruebas, la política de red y los topes). */
  crawl?: Partial<CrawlOptions>;
}

export function createSourceExtractHandler(deps: SourceExtractDeps = {}): Handler {
  return {
    kind: SOURCE_EXTRACT_KIND,
    async run(context) {
      const payload = parsePayload(sourceExtractPayloadSchema, context.job.payload);
      let raw: string;
      let meta: Record<string, unknown> = { format: payload.format };

      if (payload.format === 'website') {
        const crawl = { ...DEFAULT_CRAWL, ...deps.crawl, signal: context.signal };
        assertFetchableUrl(payload.url!, crawl.policy);
        const result = await crawlWebsite(payload.url!, crawl);
        raw = result.text;
        meta = {
          ...meta,
          lang: result.lang || undefined,
          pages: result.pages.slice(0, 20),
          skipped: result.skipped
            .slice(0, 20)
            .map((s) => ({ url: s.url.slice(0, 500), reason: s.reason.slice(0, 200) })),
        };
      } else {
        const file = await fetchInput(context, payload.path!, 'source');
        if ((await stat(file)).size > MAX_SOURCE_FILE_BYTES) throw new PermanentError('El archivo es demasiado grande');
        const bytes = new Uint8Array(await readFile(file));
        if (payload.format === 'pdf') {
          const pdf = await extractPdfText(bytes);
          raw = pdf.text;
          meta = { ...meta, pages: pdf.pages, pagesRead: pdf.pagesRead };
        } else if (payload.format === 'docx') {
          raw = await extractDocxText(bytes);
        } else {
          raw = decodePlainText(bytes);
        }
      }

      const { text, truncated } = capText(normalizeText(raw));
      if (!text) {
        throw new PermanentError(
          payload.format === 'pdf'
            ? 'El PDF no tiene texto que leer (¿es un escaneo? No se hace reconocimiento de caracteres).'
            : 'No se ha encontrado texto en la fuente.',
        );
      }
      context.log.info('source.extracted', { format: payload.format, chars: text.length, truncated });
      return { text, meta: { ...meta, chars: text.length, truncated } };
    },
  };
}
