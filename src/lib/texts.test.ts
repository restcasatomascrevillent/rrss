// Vigila que lo que ve el usuario no lleve jerga técnica: nombres de tablas,
// siglas (UTC, JSON), «undefined»/«null», zonas horarias en inglés, etc.
// Recorre (1) el diccionario de src/lib/texts.ts, (2) las frases de la actividad
// para todas las acciones conocidas y (3) los textos visibles de las pantallas
// (.tsx): contenido de las etiquetas y atributos title, label, description…
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeAudit } from '@/features/audit/describe';
import {
  ACTIVITY_NOUN,
  ACTIVITY_VERB,
  CAMPAIGN_STATUS_TEXT,
  CONTENT_STATUS_TEXT,
  TEXT,
  cleanText,
  describeUnknownActivity,
  sortTimeZones,
  timeZoneLabel,
} from './texts';

/** Patrones que no pueden aparecer en un texto visible. */
export const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['nombre de tabla o campo (snake_case)', /\b[a-z]{2,}(?:_[a-z0-9]+)+\b/],
  ['UTC', /\bUTC\b/],
  ['JSON', /\bJSON\b/i],
  ['undefined / null / NaN', /\b(?:undefined|null|NaN)\b|\[object /],
  ['zona horaria en inglés', /\b(?:Europe|Africa|America|Asia|Atlantic|Pacific|Indian|Australia)\/[A-Z]/],
  ['IANA', /\bIANA\b/],
  ['unidades de cuenta', /unidades? de cuenta/i],
  ['IG User ID', /\bIG User ID\b/],
  ['nombre de la fórmula de legibilidad', /Fernández/],
  ['errata «ciónes»', /ciónes\b/i],
  ['token', /\btoken\b/i],
];

const violations = (text: string) => FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

describe('diccionario de textos', () => {
  it('ninguno lleva jerga prohibida', () => {
    const values = [
      ...Object.values(ACTIVITY_VERB),
      ...Object.values(ACTIVITY_NOUN),
      ...Object.values(CONTENT_STATUS_TEXT),
      ...Object.values(CAMPAIGN_STATUS_TEXT),
      TEXT.exportConfig,
      TEXT.importConfig,
      TEXT.configNotReadable,
      TEXT.creditUnit.one,
      TEXT.creditUnit.other,
    ];
    for (const value of values) expect(violations(value), value).toEqual([]);
  });

  it('las zonas horarias salen en español, sin «Europe/…»', () => {
    const zones = (
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
    ).concat(['Europe/Madrid', 'UTC']);
    expect(zones.length).toBeGreaterThan(0);
    for (const zone of zones) expect(violations(timeZoneLabel(zone)), zone).toEqual([]);
    expect(timeZoneLabel('Europe/Madrid')).toBe('España peninsular y Baleares');
    expect(timeZoneLabel('Atlantic/Canary')).toBe('Canarias');
    expect(timeZoneLabel('Africa/Abidjan')).toBe('Abidjan (África)');
  });

  it('en el selector, España va la primera', () => {
    const list = sortTimeZones(['Africa/Abidjan', 'Europe/Madrid', 'Asia/Tokyo'], 'Europe/Madrid');
    expect(list[0]).toBe('Europe/Madrid');
    expect(sortTimeZones(['Asia/Tokyo'], 'Pacific/Fiji')[0]).toBe('Pacific/Fiji');
  });

  it('una acción sin frase propia no enseña la tabla', () => {
    expect(describeUnknownActivity('insert', 'content_comments')).toBe('añadió un comentario de una publicación');
    expect(describeUnknownActivity('update', 'tabla_futura')).toBe('hizo un cambio');
    expect(describeUnknownActivity('truncate', 'campaigns')).toBe('hizo un cambio');
  });

  it('corrige las erratas conocidas', () => {
    expect(cleanText('Sin publicaciónes y Publicaciónes')).toBe('Sin publicaciones y Publicaciones');
  });
});

describe('actividad', () => {
  const names = (id: string) => (id === 'u1' ? 'Ana' : '');
  const entities = Object.keys(ACTIVITY_NOUN);
  const data = {
    user_id: 'u1',
    role: 'editor',
    name: 'Casa',
    title: 'Chuletón',
    status: 'accepted',
    kind: 'comment',
    body: 'Cambia la foto',
    file_name: 'foto.jpg',
    email: 'a@b.es',
    version: 2,
  };

  it('ninguna frase, para ninguna tabla ni acción, lleva jerga', () => {
    for (const entity of [...entities, 'tabla_futura']) {
      for (const action of ['insert', 'update', 'delete', 'truncate']) {
        for (const payload of [data, {}, null, []]) {
          const text = describeAudit({ action, entity_type: entity, data: payload as never }, names);
          if (text === null) continue;
          expect(violations(text), `${action} ${entity}: ${text}`).toEqual([]);
        }
      }
    }
  });
});

// ───────────────────── Textos visibles de las pantallas ─────────────────────

/** Pantallas donde la jerga es legítima: la de la agencia (Plataforma) y los textos legales (nombres de cookies). */
const EXEMPT = [/[\\/]features[\\/]platform[\\/]/, /[\\/]features[\\/]legal[\\/]/];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.tsx') && !/\.(test|spec)\./.test(entry.name) && !EXEMPT.some((e) => e.test(full))) {
      out.push(full);
    }
  }
  return out;
}

/** Texto que ve el usuario en un componente: contenido entre etiquetas y atributos de texto. */
export function visibleTexts(source: string): string[] {
  const texts: string[] = [];
  const clean = (raw: string) =>
    raw
      .replace(/\$\{[^}]*\}/g, ' ')
      .replace(/\{[^{}]*\}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  // Lo que no es texto: código que se parece a una etiqueta (genéricos, flechas, operadores).
  const looksLikeCode = (s: string) =>
    /=>|&&|\|\||\?\?|[;=]|\b(?:const|return|import|export)\b/.test(s) ||
    // Trozos de una expresión JSX partida por las etiquetas: «) : null}», «{x ? (», «cond ? (».
    /^\s*[)}\]]/.test(s) ||
    // Llamadas de función pegadas al paréntesis («setOpen(true)», «.map(item)»): código, no texto.
    /[A-Za-z_]\w*\(/.test(s) ||
    /[({]\s*$/.test(s) ||
    /\s[?:]\s|\?\./.test(s);
  for (const m of source.matchAll(/>([^<>]*[A-Za-zÁ-ú][^<>]*)</g)) {
    const raw = m[1]!;
    if (looksLikeCode(raw.replace(/\{[^{}]*\}/g, ''))) continue;
    const text = clean(raw);
    if (/[A-Za-zÁ-ú]{3,}/.test(text)) texts.push(text);
  }
  for (const m of source.matchAll(
    /\b(?:title|description|label|hint|placeholder|aria-label|alt|emptyText)=(?:"([^"]+)"|\{`([^`]+)`\}|\{'([^']+)'\})/g,
  )) {
    texts.push(clean(m[1] ?? m[2] ?? m[3] ?? ''));
  }
  return texts;
}

describe('textos visibles de las pantallas', () => {
  it('el extractor distingue texto de código', () => {
    expect(visibleTexts('<p>Hola mundo</p>')).toEqual(['Hola mundo']);
    expect(visibleTexts('<Foo title="Exportar JSON" />')).toEqual(['Exportar JSON']);
    expect(visibleTexts('const a = x => y<string>(z) > 3;')).toEqual([]);
    expect(visibleTexts('<p>{`Hola ${user_name}`}</p>')).toEqual([]);
  });

  it('el detector salta cuando aparece jerga', () => {
    expect(violations('Exportar JSON')).toEqual(['JSON']);
    expect(violations('insert en content_comments')).toEqual(['nombre de tabla o campo (snake_case)']);
    expect(violations('días en hora UTC')).toEqual(['UTC']);
    expect(violations('Zona Europe/Madrid')).toEqual(['zona horaria en inglés']);
    expect(violations('valor undefined')).toEqual(['undefined / null / NaN']);
  });

  it('ninguna pantalla enseña nombres de tablas, siglas ni valores vacíos', () => {
    const root = path.join(process.cwd(), 'src');
    const found: string[] = [];
    for (const file of sourceFiles(root)) {
      for (const text of visibleTexts(readFileSync(file, 'utf8'))) {
        for (const name of violations(text))
          found.push(`${path.relative(root, file)} · ${name} · «${text.slice(0, 80)}»`);
      }
    }
    expect(found).toEqual([]);
  });
});
