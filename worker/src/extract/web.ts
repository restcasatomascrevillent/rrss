// Texto de la web de una marca: la página dada y, como mucho, unos pocos
// enlaces internos de primer nivel (mismo origen), respetando robots.txt.
// Sin ejecutar JavaScript, con topes de tamaño y tiempo y protegido contra
// SSRF (net.ts).
import robotsParserModule from 'robots-parser';
import { PermanentError } from '../errors.ts';
import { decodeBody, detectCharset, htmlToText } from './html.ts';
import { DEFAULT_NET_POLICY, safeFetch, TransientFetchError, type NetPolicy } from './net.ts';
import { normalizeText } from './text.ts';

/** Nombre con el que el trabajador se presenta y con el que se busca en robots.txt. */
export const CRAWLER_TOKEN = 'rrss-fuentes';
export const CRAWLER_USER_AGENT = `Mozilla/5.0 (compatible; ${CRAWLER_TOKEN}/1.0; lectura de la web de la propia marca)`;

export interface CrawlOptions {
  policy?: NetPolicy;
  /** Páginas en total, contando la primera. */
  maxPages: number;
  maxBytesPerPage: number;
  timeoutPerRequestMs: number;
  /** Tiempo total de la lectura; al agotarse se devuelve lo leído. */
  totalTimeMs: number;
  signal?: AbortSignal;
}

export const DEFAULT_CRAWL: CrawlOptions = {
  maxPages: 5,
  maxBytesPerPage: 2 * 1024 * 1024,
  timeoutPerRequestMs: 15_000,
  totalTimeMs: 60_000,
};

export interface PageRead {
  url: string;
  title: string;
  chars: number;
}

export interface PageSkipped {
  url: string;
  reason: string;
}

export interface CrawlResult {
  text: string;
  pages: PageRead[];
  skipped: PageSkipped[];
  lang: string;
}

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;
/** Enlaces que no son páginas. */
const NOT_A_PAGE =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|mp4|webm|mov|mp3|wav|zip|rar|7z|gz|docx?|xlsx?|pptx?|css|js|json|xml|rss|woff2?|ttf|otf)$/i;

interface Robots {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
// Los tipos de robots-parser declaran el módulo de forma que TypeScript no ve la función.
const robotsParser = robotsParserModule as unknown as (url: string, contents: string) => Robots;

/**
 * robots.txt del origen, según RFC 9309: si no existe (4xx) se puede leer
 * todo; si el servidor falla (5xx) o no responde, no se lee nada.
 */
async function loadRobots(origin: string, options: CrawlOptions): Promise<Robots | 'unreachable'> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const response = await safeFetch(robotsUrl, {
      policy: options.policy,
      userAgent: CRAWLER_USER_AGENT,
      accept: 'text/plain,*/*;q=0.5',
      maxBytes: 512 * 1024,
      timeoutMs: options.timeoutPerRequestMs,
      maxRedirects: 5,
      signal: options.signal,
    });
    if (response.status >= 500) return 'unreachable';
    const contents = response.status >= 200 && response.status < 300 ? decodeBody(response.body, 'utf-8') : '';
    return robotsParser(robotsUrl, contents);
  } catch (error) {
    if (error instanceof TransientFetchError) return 'unreachable';
    throw error;
  }
}

/** Enlaces internos de primer nivel, normalizados y sin repetir. */
export function internalLinks(hrefs: string[], base: URL, limit: number): string[] {
  const seen = new Set<string>([stripHash(base)]);
  const out: string[] = [];
  for (const href of hrefs) {
    if (out.length >= limit) break;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) continue;
    if (NOT_A_PAGE.test(url.pathname)) continue;
    const key = stripHash(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function stripHash(url: URL): string {
  const copy = new URL(url);
  copy.hash = '';
  return copy.toString();
}

async function readPage(url: string, options: CrawlOptions) {
  const response = await safeFetch(url, {
    policy: options.policy,
    userAgent: CRAWLER_USER_AGENT,
    accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
    maxBytes: options.maxBytesPerPage,
    timeoutMs: options.timeoutPerRequestMs,
    signal: options.signal,
  });
  if (response.status >= 500) throw new TransientFetchError(`El servidor respondió ${response.status}`);
  if (response.status !== 200) throw new PermanentError(`La página respondió ${response.status}`);
  if (!HTML_TYPES.test(response.contentType)) {
    throw new PermanentError(`No es una página web (${response.contentType.split(';')[0] || 'tipo desconocido'})`);
  }
  const body = decodeBody(response.body, detectCharset(response.contentType, response.body));
  if (/^text\/plain/i.test(response.contentType)) {
    return {
      finalUrl: new URL(response.url),
      doc: { title: '', description: '', lang: '', text: body, links: [], nofollow: true },
    };
  }
  return { finalUrl: new URL(response.url), doc: htmlToText(body) };
}

function pageText(doc: { title: string; description: string; text: string }): string {
  return normalizeText([doc.title, doc.description, doc.text].filter((part) => part.trim()).join('\n\n'));
}

export async function crawlWebsite(startUrl: string, options: CrawlOptions = DEFAULT_CRAWL): Promise<CrawlResult> {
  const deadline = Date.now() + options.totalTimeMs;
  const policy = options.policy ?? DEFAULT_NET_POLICY;
  const opts = { ...options, policy };
  const robotsByOrigin = new Map<string, Robots | 'unreachable'>();
  const robotsFor = async (url: URL) => {
    if (!robotsByOrigin.has(url.origin)) robotsByOrigin.set(url.origin, await loadRobots(url.origin, opts));
    return robotsByOrigin.get(url.origin)!;
  };
  const allowed = async (url: URL): Promise<string | null> => {
    const robots = await robotsFor(url);
    if (robots === 'unreachable') return 'robots.txt no responde: no se lee la web';
    return robots.isAllowed(url.toString(), CRAWLER_TOKEN) === false ? 'robots.txt no permite leerla' : null;
  };

  const first = new URL(startUrl);
  const firstBlocked = await allowed(first);
  if (firstBlocked) {
    // Sin robots.txt alcanzable puede ser un fallo pasajero; un «no» explícito, no.
    if (firstBlocked.startsWith('robots.txt no responde')) throw new TransientFetchError(firstBlocked);
    throw new PermanentError(`La web no deja leer ${first.toString()}: ${firstBlocked}`);
  }
  const { finalUrl, doc } = await readPage(first.toString(), opts);
  // Si hubo redirección a otro origen, la página final también debe estar permitida.
  if (finalUrl.origin !== first.origin) {
    const reason = await allowed(finalUrl);
    if (reason) throw new PermanentError(`La web no deja leer ${finalUrl.toString()}: ${reason}`);
  }

  const texts = [pageText(doc)];
  const pages: PageRead[] = [{ url: finalUrl.toString(), title: doc.title, chars: texts[0]!.length }];
  const skipped: PageSkipped[] = [];
  // Candidatos de sobra: los que robots.txt prohíbe o fallan no gastan hueco.
  const links = doc.nofollow ? [] : internalLinks(doc.links, finalUrl, Math.max(0, options.maxPages - 1) * 4);
  if (doc.nofollow && doc.links.length > 0)
    skipped.push({ url: finalUrl.toString(), reason: 'la página pide no seguir sus enlaces' });

  for (const link of links) {
    if (pages.length >= options.maxPages) break;
    if (Date.now() > deadline) {
      skipped.push({ url: link, reason: 'se acabó el tiempo de lectura' });
      continue;
    }
    try {
      const reason = await allowed(new URL(link));
      if (reason) {
        skipped.push({ url: link, reason });
        continue;
      }
      const page = await readPage(link, opts);
      const text = pageText(page.doc);
      texts.push(text);
      pages.push({ url: page.finalUrl.toString(), title: page.doc.title, chars: text.length });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      skipped.push({ url: link, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const text = pages.length === 1 ? texts[0]! : texts.map((t, i) => `## ${pages[i]!.url}\n\n${t}`).join('\n\n');
  return { text, pages, skipped, lang: doc.lang };
}
