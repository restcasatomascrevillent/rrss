// Lectura de webs: robots.txt, enlaces internos, topes, HTML a texto y
// protección contra SSRF, contra un servidor HTTP local de la prueba.
//
// El servidor escucha en 127.0.0.1, que la política por defecto prohíbe: las
// pruebas de lectura usan una política que admite SOLO esa dirección y
// cualquier puerto; las de SSRF, la política por defecto (o esa misma, para
// ver que una redirección a otra dirección privada se corta).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentError } from '../src/errors.ts';
import { htmlToText } from '../src/extract/html.ts';
import { assertFetchableUrl, BlockedUrlError, isPublicAddress, safeFetch, type NetPolicy } from '../src/extract/net.ts';
import { crawlWebsite, DEFAULT_CRAWL, internalLinks } from '../src/extract/web.ts';
import { createSourceExtractHandler } from '../src/handlers/source-extract.ts';
import { createBucket, runHandler, type Bucket } from './helpers/media.ts';

const LOOPBACK_ONLY: NetPolicy = { isAllowedAddress: (ip) => ip === '127.0.0.1', allowedPorts: 'any' };

type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let routes: Record<string, Route> = {};
const hits: string[] = [];
let server: http.Server;
let base: string;
let bucket: Bucket;

const html =
  (body: string, head = '') =>
  (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="es"><head>${head}</head><body>${body}</body></html>`);
  };
const robots =
  (text: string): Route =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(text);
  };

beforeAll(async () => {
  bucket = await createBucket();
  server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    hits.push(path);
    const route = routes[path];
    if (route) return route(req, res);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no existe');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await bucket?.cleanup();
});

const crawl = (path = '/', overrides: Partial<typeof DEFAULT_CRAWL> = {}) =>
  crawlWebsite(`${base}${path}`, { ...DEFAULT_CRAWL, policy: LOOPBACK_ONLY, timeoutPerRequestMs: 3000, ...overrides });

describe('HTML a texto', () => {
  it('se queda con el texto visible, el título y la descripción, sin scripts ni estilos', () => {
    const doc = htmlToText(`<html lang="es-ES"><head><title> Panadería  Sol </title>
      <meta name="description" content="Pan de masa madre"><style>body{color:red}</style>
      <script>alert('hola')</script></head><body><h1>Bienvenidos</h1><p>Horno de leña&nbsp;desde 1987.</p>
      <div hidden>texto oculto</div><p style="display: none">también oculto</p><noscript>activa JS</noscript>
      <img src="a.jpg" alt="Barra de pan"><ul><li>Pan</li><li>Bollería</li></ul>
      <a href="/carta">Carta</a><a href="/externo" rel="nofollow">Fuera</a></body></html>`);
    expect(doc).toMatchObject({ title: 'Panadería Sol', description: 'Pan de masa madre', lang: 'es-ES' });
    expect(doc.links).toEqual(['/carta']);
    expect(doc.text).toContain('Bienvenidos');
    expect(doc.text).toContain('Horno de leña');
    expect(doc.text).toContain('Barra de pan');
    for (const hidden of ['alert', 'color:red', 'texto oculto', 'también oculto', 'activa JS']) {
      expect(doc.text).not.toContain(hidden);
    }
  });

  it('enlaces internos de primer nivel: mismo origen, sin repetir y sin archivos', () => {
    const page = new URL('https://marca.example/inicio');
    expect(
      internalLinks(
        [
          '/carta',
          '/carta#postres',
          'https://otra.example/',
          '/menu.pdf',
          'mailto:hola@marca.example',
          'contacto',
          '/inicio',
        ],
        page,
        10,
      ),
    ).toEqual(['https://marca.example/carta', 'https://marca.example/contacto']);
  });
});

describe('lectura de una web', () => {
  it('lee la página y sus enlaces internos, respetando robots.txt y el máximo de páginas', async () => {
    routes = {
      '/robots.txt': robots('User-agent: *\nDisallow: /privado\n'),
      '/': html(
        '<h1>Inicio</h1><p>Somos un estudio de yoga.</p><a href="/clases">Clases</a><a href="/privado/admin">Admin</a>' +
          '<a href="/equipo">Equipo</a><a href="/precios">Precios</a><a href="https://otra.example/">Fuera</a>',
        '<title>Estudio</title>',
      ),
      '/clases': html('<p>Hatha y vinyasa por la mañana.</p>', '<title>Clases</title>'),
      '/equipo': html('<p>Cuatro profesoras certificadas.</p>'),
      '/precios': html('<p>Bono de diez clases.</p>'),
      '/privado/admin': html('<p>NO DEBE LEERSE</p>'),
    };
    hits.length = 0;
    const result = await crawl('/', { maxPages: 3 });
    expect(result.pages.map((p) => new URL(p.url).pathname)).toEqual(['/', '/clases', '/equipo']);
    expect(result.skipped).toEqual([{ url: `${base}/privado/admin`, reason: 'robots.txt no permite leerla' }]);
    expect(result.text).toContain('Somos un estudio de yoga.');
    expect(result.text).toContain('Hatha y vinyasa');
    expect(result.text).not.toContain('NO DEBE LEERSE');
    expect(result.text).not.toContain('Bono de diez');
    expect(hits).not.toContain('/privado/admin');
    expect(hits.filter((h) => h === '/robots.txt')).toHaveLength(1);
    expect(result.lang).toBe('es');
  });

  it('si robots.txt prohíbe la página, no la descarga y falla sin reintento', async () => {
    routes = { '/robots.txt': robots('User-agent: rrss-fuentes\nDisallow: /\n'), '/': html('<p>secreto</p>') };
    hits.length = 0;
    await expect(crawl('/')).rejects.toThrow(/robots\.txt no permite/);
    expect(hits).toEqual(['/robots.txt']);
  });

  it('sin robots.txt (404) se puede leer; si robots.txt da error 5xx, no se lee (y se reintentará)', async () => {
    routes = { '/': html('<p>Abierto</p>') };
    await expect(crawl('/')).resolves.toMatchObject({ text: 'Abierto' });
    routes = {
      '/robots.txt': (_req, res) => {
        res.writeHead(503);
        res.end();
      },
      '/': html('<p>Abierto</p>'),
    };
    const error = await crawl('/').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentError);
    expect((error as Error).message).toMatch(/robots\.txt no responde/);
  });

  it('respeta <meta name="robots" content="nofollow">', async () => {
    routes = { '/': html('<p>Portada</p><a href="/otra">Otra</a>', '<meta name="robots" content="nofollow">') };
    const result = await crawl('/');
    expect(result.pages).toHaveLength(1);
  });

  it('rechaza lo que no es HTML y las páginas que pasan del tope de tamaño (también comprimidas)', async () => {
    routes = {
      '/foto': (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end('xx');
      },
      '/grande': html(`<p>${'a'.repeat(5000)}</p>`),
      '/bomba': (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.alloc(200_000, 0x61)));
      },
    };
    await expect(crawl('/foto')).rejects.toThrow(/No es una página web \(image\/jpeg\)/);
    await expect(crawl('/grande', { maxBytesPerPage: 1000 })).rejects.toThrow(/pesa más/);
    await expect(crawl('/bomba', { maxBytesPerPage: 50_000 })).rejects.toThrow(/pesa más/);
  });

  it('lee una página en gzip y en ISO-8859-1', async () => {
    routes = {
      '/latin': (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.from('<p>Año de fundación</p>', 'latin1')));
      },
    };
    expect((await crawl('/latin')).text).toBe('Año de fundación');
  });

  it('un servidor que no responde a tiempo da un error pasajero', async () => {
    routes = { '/lenta': () => undefined };
    const error = await crawl('/lenta', { timeoutPerRequestMs: 300 }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/Tiempo agotado/);
    expect(error).not.toBeInstanceOf(PermanentError);
  });

  it('el manejador guarda el detalle: páginas leídas y omitidas', async () => {
    routes = {
      '/robots.txt': robots('User-agent: *\nDisallow: /no\n'),
      '/': html('<p>Hola</p><a href="/no">No</a>', '<title>Marca</title>'),
    };
    const handler = createSourceExtractHandler({ crawl: { policy: LOOPBACK_ONLY, timeoutPerRequestMs: 3000 } });
    const result = await runHandler(handler, bucket, {
      source_id: '44444444-4444-4444-8444-444444444444',
      format: 'website',
      url: `${base}/`,
    });
    expect(result.text).toBe('Marca\n\nHola\nNo');
    expect(result.meta).toMatchObject({
      format: 'website',
      pages: [{ url: `${base}/`, title: 'Marca', chars: 14 }],
      skipped: [{ url: `${base}/no`, reason: 'robots.txt no permite leerla' }],
    });
  });
});

describe('protección contra SSRF', () => {
  it('solo direcciones públicas', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '255.255.255.255',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      'no-es-ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('rechaza protocolos, credenciales, puertos y nombres que no son públicos', () => {
    const blocked = [
      'ftp://marca.example/',
      'file:///etc/passwd',
      'http://usuario:clave@marca.example/',
      'http://marca.example:22/',
      'http://localhost/',
      'http://api.localhost/',
      'http://intranet/',
      'http://127.0.0.1/',
      'http://2130706433/', // 127.0.0.1 en decimal: la URL lo normaliza
      'http://0x7f.1/',
      'http://[::1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://169.254.169.254/latest/meta-data/',
    ];
    for (const url of blocked) expect(() => assertFetchableUrl(url), url).toThrow(BlockedUrlError);
    expect(assertFetchableUrl('https://marca.example/inicio').hostname).toBe('marca.example');
  });

  it('con la política por defecto no se conecta al servidor local', async () => {
    hits.length = 0;
    routes = { '/': html('<p>interno</p>') };
    await expect(crawlWebsite(`${base}/`)).rejects.toThrow(BlockedUrlError);
    expect(hits).toEqual([]);
  });

  it('un nombre que resuelve a una dirección prohibida se corta al conectar', async () => {
    // «localtest.me» y similares resuelven a 127.0.0.1; aquí se simula con una
    // política que prohíbe incluso esa dirección y un nombre del sistema.
    const none: NetPolicy = { isAllowedAddress: () => false, allowedPorts: 'any' };
    const port = new URL(base).port;
    await expect(
      safeFetch(`http://loopback.rrss.test:${port}/`, {
        policy: none,
        userAgent: 'prueba',
        accept: '*/*',
        maxBytes: 1000,
        timeoutMs: 2000,
      }),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it('una redirección a una dirección privada se corta antes de seguirla', async () => {
    routes = {
      '/robots.txt': robots(''),
      '/salto': (_req, res) => {
        res.writeHead(302, { location: 'http://10.0.0.5/admin' });
        res.end();
      },
      '/salto-local': (_req, res) => {
        res.writeHead(301, { location: 'http://localhost/' });
        res.end();
      },
    };
    await expect(crawl('/salto')).rejects.toThrow(/10\.0\.0\.5 no es pública/);
    await expect(crawl('/salto-local')).rejects.toThrow(/no es un nombre de dominio público/);
  });

  it('demasiadas redirecciones', async () => {
    routes = {
      '/robots.txt': robots(''),
      '/bucle': (_req, res) => {
        res.writeHead(302, { location: '/bucle' });
        res.end();
      },
    };
    await expect(crawl('/bucle')).rejects.toThrow(/Demasiadas redirecciones/);
  });
});
