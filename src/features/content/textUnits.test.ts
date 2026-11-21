// Vigila que el contador del editor, la ventana «Redactar con IA», el
// verificador de marca y la medición del servidor (`post.caption`) cuenten el
// mismo texto con la misma cifra. Si alguien cambia la unidad en uno solo de
// los cuatro sitios, esta prueba falla.
import { captionLimits, variantLength } from '@/features/ai/networkLimits';
import { buildBrandCheckInput } from '@/features/brandcheck/document';
import { verifyPiece } from '@/features/brandcheck/verify';
import { createEmptyDocument } from './document';
import { copyCounters } from './editor/copy';
import { formatsOf, getFormatSpec, NETWORKS } from './networks';
import { LENGTH_UNIT_BY_LIMIT, lengthUnitOf } from './textUnits';

// Emoji simple (2 unidades UTF-16), secuencia con ZWJ (un grafema, varias
// unidades) y letras acentuadas: las tres unidades posibles dan cifras distintas.
const TEXT = 'Menú de otoño 🍂 con la familia 👨‍👩‍👧 y castañas';
const TAGS = ['otoño', 'menu'];

function editorCount(network: string, format: string, caption: string, hashtags: string[]): number {
  const doc = createEmptyDocument({ aspectRatio: '1:1' });
  const copy = { ...doc.copy, caption, hashtags };
  return copyCounters(copy, getFormatSpec(network, format)).find((c) => c.field === 'caption')!.value;
}

function verifierCount(network: string, format: string, caption: string, hashtags: string[], max: number) {
  const base = createEmptyDocument({ aspectRatio: '1:1' });
  const doc = { ...base, copy: { ...base.copy, caption, hashtags } };
  const spec = getFormatSpec(network, format)!;
  const tight = {
    ...spec,
    text: { ...spec.text, caption: { ...spec.text.caption!, value: { ...spec.text.caption!.value, maxLength: max } } },
  };
  const finding = verifyPiece(buildBrandCheckInput(doc, tight, null)).findings.find(
    (f) => f.code === 'LENGTH_EXCEEDED',
  );
  return finding?.measured;
}

// La tarea del servidor se carga por ruta para que el compilador de la
// aplicación (tsconfig.app.json, sin extensiones .ts en los imports) no la
// recorra: es código de las funciones de Supabase, comprobado con tsconfig.node.
const SERVER_TASK = '../../../supabase/functions/_shared/ai/text/tasks/post-copy.ts';
type MeasureVariant = (
  text: string,
  hashtags: string[],
  network: { maxChars: number; maxHashtags?: number },
) => {
  characters: number;
};
let measureVariant: MeasureVariant;
beforeAll(async () => {
  ({ measureVariant } = (await import(/* @vite-ignore */ SERVER_TASK)) as { measureVariant: MeasureVariant });
});

describe('una sola unidad para los límites de texto', () => {
  it('«caracteres» y «UTF-16» se cuentan en UTF-16', () => {
    expect(LENGTH_UNIT_BY_LIMIT).toEqual({ characters: 'utf16', utf16: 'utf16' });
    expect(lengthUnitOf(undefined)).toBe('utf16');
  });

  const formats = NETWORKS.flatMap((n) => formatsOf(n.id).map((f) => [n.id, f.format] as const)).filter(
    ([n, f]) => getFormatSpec(n, f)?.text.caption,
  );

  it.each(formats)('%s · %s: editor, IA, verificador y servidor dicen lo mismo', (network, format) => {
    const expected = TEXT.length + '\n\n#otoño #menu'.length;
    const limits = captionLimits(network, format);

    expect(editorCount(network, format, TEXT, TAGS)).toBe(expected);
    expect(variantLength({ text: TEXT, hashtags: TAGS }, limits)).toBe(expected);
    // Con un máximo de 1 carácter, el verificador informa de la longitud medida.
    expect(verifierCount(network, format, TEXT, TAGS, 1)).toBe(expected);
    expect(measureVariant(TEXT, TAGS, limits.request).characters).toBe(expected);
  });
});
