// Script de migración a R2 (scripts/migrar-a-r2.ts): lectura del inventario y
// del recuento en seco, sin red ni escritura.
import { describe, expect, it } from 'vitest';
import { buildPlan, formatSummary, parseCsv, safeName } from '../../scripts/migrar-a-r2.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const BRAND = '22222222-2222-4222-8222-222222222222';

const CSV = [
  String.fromCharCode(0xfeff) + 'id;nombre;mimeType;formato;bytes;estado;jpeg_id;jpeg_estado',
  'heicConJpegLocal01;IMG_1.HEIC;image/heic;HEIC;3000;incluida;jpegEnDrive000001;convertida y subida junto a su HEIC',
  'heicSoloEnDrive001;IMG_2.HEIC;image/heic;HEIC;3000;incluida;jpegEnDrive000002;convertida y subida',
  'heicConOriginal001;IMG_3.HEIC;image/heic;HEIC;3000;incluida;;ya existía: ORIGINAL de la carpeta',
  'heicSinConvertir01;IMG_4.HEIC;image/heic;HEIC;3000;incluida;;sin convertir',
  'fotoJpegDeDrive001;"Plato; con punto y coma.jpg";image/jpeg;JPEG;1500;incluida;;',
  'videoDeDrive00001;Vídeo bar.MOV;video/quicktime;MOV;900000;incluida;;',
  'facturaExcluida01;factura.jpeg;image/jpeg;JPEG;100;"excluida: facturas/contabilidad";;',
  'libretaExcluida01;IMG_9.HEIC;image/heic;HEIC;100;excluida: libreta de reservas (datos personales);;',
].join('\r\n');

describe('migrar a R2: recuento en seco', () => {
  it('lee el inventario separado por «;» con comillas y BOM', () => {
    const rows = parseCsv(CSV);
    expect(rows).toHaveLength(8);
    expect(rows[0]!.id).toBe('heicConJpegLocal01');
    expect(rows[4]!.nombre).toBe('Plato; con punto y coma.jpg');
    expect(rows[6]!.estado).toBe('excluida: facturas/contabilidad');
  });

  it('copia solo lo incluido; las HEIC, por su JPEG; nada de facturas ni de la libreta', () => {
    const local = new Map([
      ['/jpeg/heicConJpegLocal01.jpg', 2000],
      ['/jpeg/libretaExcluida01.jpg', 50],
      ['/jpeg/extraSinInventario.jpg', 70],
    ]);
    const plan = buildPlan({
      org: ORG,
      brand: BRAND,
      brandMedia: [{ path: `${ORG}/${BRAND}/media/a.jpg`, bytes: 10, mime: 'image/jpeg' }],
      driveRows: parseCsv(CSV),
      estado: 'incluida',
      jpegDir: '/jpeg',
      jpegList: [
        { id: 'heicConJpegLocal01' },
        { id: 'libretaExcluida01' },
        { id: 'extraSinInventario', title: 'Extra.jpg' },
      ],
      localSize: (file) => local.get(file.replace(/\\/g, '/')) ?? null,
    });
    const keys = plan.items.map((i) => `${i.source} ${i.key}`);
    expect(keys).toEqual([
      `brand-media ${ORG}/${BRAND}/media/a.jpg`,
      `local ${ORG}/${BRAND}/import/google-drive/heicConJpegLocal01-IMG_1.jpg`,
      `drive ${ORG}/${BRAND}/import/google-drive/heicSoloEnDrive001-IMG_2.jpg`,
      `drive ${ORG}/${BRAND}/import/google-drive/fotoJpegDeDrive001-Plato-con-punto-y-coma.jpg`,
      `drive ${ORG}/${BRAND}/import/google-drive/videoDeDrive00001-Video-bar.mov`,
      `local ${ORG}/${BRAND}/import/google-drive/extraSinInventario-Extra.jpg`,
    ]);
    expect(plan.items.find((i) => i.from === 'jpegEnDrive000002')).toMatchObject({ mime: 'image/jpeg', bytes: 0 });
    expect(plan.skipped).toMatchObject({
      'HEIC con su JPEG original ya en el inventario': 1,
      'HEIC sin JPEG (no se puede usar en el navegador)': 1,
      'JPEG de un HEIC excluido en el inventario': 1,
    });
    expect(Object.keys(plan.skipped).filter((k) => k.startsWith('inventario: excluida'))).toHaveLength(2);
    expect(plan.notes['JPEG que también están ya en Drive (se copia la copia local, idéntica)']).toBe(1);

    const text = formatSummary(plan, new Set([`${ORG}/${BRAND}/media/a.jpg`]));
    expect(text).toMatch(/brand-media \(Supabase\) \| 1 \| 0,0 MB \| 0/);
    expect(text).toMatch(/TOTAL \| 6 \|/);
  });

  it('sin organización ni marca solo sirve en seco, y lo avisa', () => {
    const plan = buildPlan({
      org: null,
      brand: null,
      brandMedia: null,
      driveRows: parseCsv(CSV),
      estado: 'incluida',
      jpegDir: null,
      jpegList: null,
      localSize: () => null,
    });
    expect(plan.items.every((i) => i.key.startsWith('<org>/<marca>/'))).toBe(true);
    expect(plan.warnings.join(' ')).toMatch(/--org y --brand/);
  });

  it('nombres seguros para las claves', () => {
    expect(safeName('Vídeo bar ñ (1)')).toBe('Video-bar-n-1');
    expect(safeName('../../etc')).toBe('etc');
    expect(safeName('')).toBe('archivo');
  });

  it('--drive-dir: lee de la carpeta lo ya bajado y marca «falta descargar» lo que no está', () => {
    const local = new Map([
      ['/dd/fotoJpegDeDrive001.jpg', 1500],
      ['/dd/videoDeDrive00001.MOV', 12],
    ]);
    const base = {
      org: ORG,
      brand: BRAND,
      brandMedia: null,
      driveRows: parseCsv(CSV),
      estado: 'incluida',
      jpegDir: null,
      jpegList: null,
      driveDir: '/dd',
      localSize: (file: string) => local.get(file.replaceAll('\\', '/')) ?? null,
    };
    const plan = buildPlan({ ...base, driveToken: false });
    const foto = plan.items.find((i) => i.from === 'fotoJpegDeDrive001')!;
    expect(foto.localFrom?.replaceAll('\\', '/')).toBe('/dd/fotoJpegDeDrive001.jpg');
    expect(foto.missing).toBeUndefined();
    // El tamaño no coincide con el inventario: no se da por bajado.
    const video = plan.items.find((i) => i.from === 'videoDeDrive00001')!;
    expect(video.localFrom).toBeUndefined();
    expect(video.missing).toBe(true);
    expect(plan.items.find((i) => i.from === 'jpegEnDrive000002')?.missing).toBe(true);
    expect(formatSummary(plan)).toContain('falta descargar');
    // Con token, lo que falta se podrá bajar de la API.
    const withToken = buildPlan({ ...base, driveToken: true });
    expect(withToken.items.some((i) => i.missing)).toBe(false);
  });
});
