import type { LengthUnit } from '@/features/brandcheck/types';
import type { TextLimit } from './networks';

// Cómo se cuentan los caracteres frente a los límites de texto de una red.
//
// Única correspondencia del producto: la usan el contador del editor
// (editor/copy.ts), la ventana «Redactar con IA» (features/ai/networkLimits.ts)
// y el verificador de marca (features/brandcheck/document.ts). El servidor
// (`post.caption` en supabase/functions/_shared/ai/text/tasks/post-copy.ts)
// mide igual. La prueba `textUnits.test.ts` vigila que los cuatro coincidan.
//
// Regla: se cuenta en unidades UTF-16 en todos los casos.
// - Si la red dice «UTF-16», es literalmente su unidad.
// - Si la red dice «caracteres» sin precisar cómo, se toma UTF-16 porque es la
//   cuenta más estricta de las habituales (UTF-16 ≥ puntos de código ≥
//   grafemas): el producto nunca dice «cabe» de un texto que la red pudiera
//   rechazar. El precio es que un emoji puede contar 2 y que, rozando el
//   límite, se avisa unos caracteres antes de lo necesario.
export const LENGTH_UNIT_BY_LIMIT: Readonly<Record<TextLimit['unit'], LengthUnit>> = {
  characters: 'utf16',
  utf16: 'utf16',
};

/** Unidad con la que se mide un límite de texto del catálogo de redes. */
export function lengthUnitOf(limit: Pick<TextLimit, 'unit'> | undefined): LengthUnit {
  return limit ? LENGTH_UNIT_BY_LIMIT[limit.unit] : 'utf16';
}

/** Aviso corto para la interfaz junto a los contadores. */
export const LENGTH_UNIT_NOTE = 'Un emoji puede contar como 2 caracteres.';
