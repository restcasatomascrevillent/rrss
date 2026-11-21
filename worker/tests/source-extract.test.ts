// Texto de las fuentes de la marca (`source.extract`) con archivos REALES
// generados en la prueba: un PDF y un Word .docx mínimos, y texto plano.
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentError } from '../src/errors.ts';
import { extractDocxText, extractPdfText, zipUncompressedSize } from '../src/extract/documents.ts';
import { capText, normalizeText } from '../src/extract/text.ts';
import { createSourceExtractHandler, SOURCE_EXTRACT_KIND } from '../src/handlers/source-extract.ts';
import { makeDocx, makePdf } from './helpers/documents.ts';
import { BRAND, createBucket, inBrand, ORG, OTHER_BRAND, runHandler, type Bucket } from './helpers/media.ts';

const SOURCE_ID = '44444444-4444-4444-8444-444444444444';
let bucket: Bucket;

beforeAll(async () => {
  bucket = await createBucket();
});
afterAll(async () => {
  await bucket?.cleanup();
});

describe('normalizar el texto', () => {
  it('quita espacios sobrantes, controles y líneas en blanco repetidas', () => {
    expect(normalizeText('﻿  Hola  mundo \r\n\r\n\r\n\r\n\tAdiós\u0007  ')).toBe('Hola mundo\n\nAdiós');
  });

  it('recorta al tope sin partir palabras ni emojis', () => {
    const { text, truncated } = capText(`${'a'.repeat(95)} bbbbbbbbbb`, 100);
    expect(truncated).toBe(true);
    expect(text).toBe('a'.repeat(95));
    expect(capText('corto', 100)).toEqual({ text: 'corto', truncated: false });
    expect(capText('ab😀', 3).text).toBe('ab');
  });
});

describe('PDF', () => {
  it('saca el texto de cada página, con tildes', async () => {
    const pdf = makePdf(['Cocina mediterránea de mercado', 'Abrimos de martes a domingo\nReservas por teléfono']);
    const result = await extractPdfText(pdf);
    expect(result.pages).toBe(2);
    expect(result.pagesRead).toBe(2);
    const text = normalizeText(result.text);
    expect(text).toContain('Cocina mediterránea de mercado');
    expect(text).toContain('Abrimos de martes a domingo');
    expect(text).toContain('Reservas por teléfono');
    expect(text.indexOf('Cocina')).toBeLessThan(text.indexOf('Abrimos'));
  });

  it('lee como mucho las páginas del tope', async () => {
    const result = await extractPdfText(makePdf(['uno', 'dos', 'tres']), 2);
    expect(result).toMatchObject({ pages: 3, pagesRead: 2 });
    expect(result.text).not.toContain('tres');
  });

  it('un archivo que no es PDF falla sin reintento', async () => {
    await expect(extractPdfText(new TextEncoder().encode('no soy un pdf'))).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('Word (.docx)', () => {
  it('saca el texto de los párrafos', async () => {
    const docx = makeDocx(['Manual de marca', 'Tono cercano & sin tecnicismos <nunca>']);
    expect(zipUncompressedSize(docx)).toBeGreaterThan(100);
    const text = normalizeText(await extractDocxText(docx));
    expect(text).toBe('Manual de marca\n\nTono cercano & sin tecnicismos <nunca>');
  });

  it('rechaza un zip que dice descomprimirse en demasiado (zip bomba)', async () => {
    const bomb = makeDocx(['x'], 0xfffffff0);
    await expect(extractDocxText(bomb)).rejects.toThrow(/demasiado/);
  });

  it('rechaza lo que no es un zip', async () => {
    await expect(extractDocxText(new TextEncoder().encode('hola'))).rejects.toThrow(/no es un documento de Word/);
  });
});

describe(`manejador ${SOURCE_EXTRACT_KIND}`, () => {
  const handler = createSourceExtractHandler();

  it('PDF de la marca → texto y detalle en el resultado', async () => {
    await writeFile(bucket.file(inBrand('manual.pdf')), makePdf(['Somos una panadería de barrio', 'Desde 1987']));
    const result = await runHandler(handler, bucket, {
      source_id: SOURCE_ID,
      format: 'pdf',
      path: inBrand('manual.pdf'),
    });
    expect(result.text).toBe('Somos una panadería de barrio\n\nDesde 1987');
    expect(result.meta).toMatchObject({ format: 'pdf', pages: 2, pagesRead: 2, chars: 41, truncated: false });
  });

  it('Word y texto plano', async () => {
    await writeFile(bucket.file(inBrand('tono.docx')), makeDocx(['Hablamos de tú']));
    await writeFile(bucket.file(inBrand('notas.txt')), '﻿Notas:\r\n  café de especialidad  ');
    const docx = await runHandler(handler, bucket, {
      source_id: SOURCE_ID,
      format: 'docx',
      path: inBrand('tono.docx'),
    });
    expect(docx.text).toBe('Hablamos de tú');
    const txt = await runHandler(handler, bucket, { source_id: SOURCE_ID, format: 'text', path: inBrand('notas.txt') });
    expect(txt.text).toBe('Notas:\ncafé de especialidad');
  });

  it('un PDF sin texto (escaneado) falla diciendo por qué', async () => {
    await writeFile(bucket.file(inBrand('vacio.pdf')), makePdf(['   ']));
    await expect(
      runHandler(handler, bucket, { source_id: SOURCE_ID, format: 'pdf', path: inBrand('vacio.pdf') }),
    ).rejects.toThrow(/no tiene texto/);
  });

  it('no lee archivos de otra marca', async () => {
    await expect(
      runHandler(handler, bucket, {
        source_id: SOURCE_ID,
        format: 'pdf',
        path: `${ORG}/${OTHER_BRAND}/sources/ajeno.pdf`,
      }),
    ).rejects.toThrow(/no pertenece a la marca/);
    expect(BRAND).not.toBe(OTHER_BRAND);
  });

  it('una carga mal formada no se reintenta', async () => {
    await expect(
      runHandler(handler, bucket, { source_id: SOURCE_ID, format: 'website', path: inBrand('x.pdf') }),
    ).rejects.toBeInstanceOf(PermanentError);
    await expect(
      runHandler(handler, bucket, { source_id: 'no-uuid', format: 'pdf', path: inBrand('x.pdf') }),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it('una web en una dirección privada se rechaza sin descargar nada', async () => {
    await expect(
      runHandler(handler, bucket, {
        source_id: SOURCE_ID,
        format: 'website',
        url: 'http://169.254.169.254/latest/meta-data/',
      }),
    ).rejects.toThrow(/no es pública/);
  });
});
