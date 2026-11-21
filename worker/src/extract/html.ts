// HTML → texto legible, sin ejecutar nada: se analiza el marcado con
// htmlparser2 y se descartan scripts, estilos y lo que está oculto.
import { Parser } from 'htmlparser2';

/** Contenido que nunca es texto de la página. */
const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'object',
  'embed',
  'canvas',
  'video',
  'audio',
  'select',
  'button',
  'head',
]);

/** Elementos que separan bloques de texto. */
const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

export interface HtmlDocument {
  title: string;
  description: string;
  lang: string;
  text: string;
  /** Enlaces (`href` tal cual) que no llevan `rel="nofollow"`, en orden. */
  links: string[];
  /** La página pide no seguir sus enlaces (`<meta name="robots" content="nofollow">`). */
  nofollow: boolean;
}

export function htmlToText(html: string): HtmlDocument {
  const doc: HtmlDocument = { title: '', description: '', lang: '', text: '', links: [], nofollow: false };
  const parts: string[] = [];
  /** Por cada elemento abierto: si su contenido se descarta. */
  const stack: boolean[] = [];
  let skipping = 0;
  let inTitle = false;
  let ogDescription = '';

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const hidden =
          'hidden' in attrs ||
          attrs['aria-hidden'] === 'true' ||
          /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style ?? '');
        const skip = SKIP.has(name) || hidden;
        stack.push(skip);
        if (skip) skipping += 1;
        if (name === 'html' && attrs.lang) doc.lang = attrs.lang.slice(0, 20);
        if (name === 'title') inTitle = true;
        if (name === 'meta') {
          const key = (attrs.name ?? attrs.property ?? '').toLowerCase();
          const content = attrs.content ?? '';
          if (key === 'description') doc.description = content;
          if (key === 'og:description') ogDescription = content;
          if (key === 'robots' && /\b(nofollow|none)\b/i.test(content)) doc.nofollow = true;
        }
        if (name === 'a' && attrs.href && !/\bnofollow\b/i.test(attrs.rel ?? '')) doc.links.push(attrs.href);
        if (skipping === 0 && BLOCK.has(name)) parts.push('\n');
        if (skipping === 0 && name === 'img' && attrs.alt?.trim()) parts.push(` ${attrs.alt.trim()} `);
      },
      ontext(text) {
        if (inTitle) doc.title += text;
        else if (skipping === 0) parts.push(text);
      },
      onclosetag(name) {
        if (name === 'title') inTitle = false;
        const skip = stack.pop();
        if (skip) skipping -= 1;
        if (skipping === 0 && BLOCK.has(name)) parts.push('\n');
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  doc.title = doc.title.replace(/\s+/g, ' ').trim().slice(0, 300);
  doc.description = (doc.description || ogDescription).replace(/\s+/g, ' ').trim().slice(0, 1000);
  doc.text = parts.join('');
  return doc;
}

/** Codificación declarada: en la cabecera, o en `<meta charset>` del principio del documento. */
export function detectCharset(contentType: string | undefined, head: Uint8Array): string {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const ascii = new TextDecoder('latin1').decode(head.subarray(0, 2048));
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(ascii)?.[1] ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w.:-]+)/i.exec(ascii)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

export function decodeBody(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    // Codificación desconocida: UTF-8 sustituyendo lo que no encaje.
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}
