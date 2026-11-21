import { TEXT } from '@/lib/texts';
// Único sitio donde se enseñan importes de IA.
//
// La base de datos guarda los importes como enteros en millonésimas («micros»)
// de la moneda de cuenta de la plataforma, y esa moneda TODAVÍA NO ESTÁ
// DECIDIDA (docs/02-modelo-de-datos.md, §9). Por eso, por defecto, aquí no se
// pinta «€» ni «$»: la cifra va con una unidad neutra y con el aviso de que es
// una estimación (consumo que informa el proveedor × tarifa configurada).
//
// Cómo se fija la moneda: variable pública `VITE_AI_ACCOUNT_CURRENCY` con un
// código ISO 4217 (`EUR`, `USD`…) al construir la aplicación. Debe coincidir
// con la moneda en que está escrita la tabla de precios `AI_PRICES` de la
// función `ai-generate`. Un valor que no sea un código válido se ignora y se
// sigue mostrando la unidad neutra.

export const MICROS_PER_UNIT = 1_000_000;

export interface MoneyDisplay {
  /** Código ISO 4217, o `null` mientras la moneda de cuenta no esté decidida. */
  currency: string | null;
  locale: string;
}

/** Lee la configuración. Exportada para poder probar los dos casos. */
export function resolveMoneyDisplay(raw: string | undefined): MoneyDisplay {
  const code = (raw ?? '').trim().toUpperCase();
  let currency: string | null = null;
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      new Intl.NumberFormat('es-ES', { style: 'currency', currency: code });
      currency = code;
    } catch {
      currency = null;
    }
  }
  return { currency, locale: 'es-ES' };
}

export const MONEY_DISPLAY: MoneyDisplay = resolveMoneyDisplay(import.meta.env.VITE_AI_ACCOUNT_CURRENCY);

const NEUTRAL_UNIT = TEXT.creditUnit;
const MAX_DECIMALS = 4;

/** Importe en micros → texto («12,50 créditos» o, con moneda fijada, «12,50 €»). */
export function formatMicros(micros: number, display: MoneyDisplay = MONEY_DISPLAY): string {
  const units = (Number.isFinite(micros) ? micros : 0) / MICROS_PER_UNIT;
  const tiny = units !== 0 && Math.abs(units) < 10 ** -MAX_DECIMALS;
  const shown = tiny ? Math.sign(units) * 10 ** -MAX_DECIMALS : units;
  const options: Intl.NumberFormatOptions = { minimumFractionDigits: 2, maximumFractionDigits: MAX_DECIMALS };
  const prefix = tiny ? (units > 0 ? '< ' : '> ') : '';
  if (display.currency) {
    return (
      prefix +
      new Intl.NumberFormat(display.locale, { ...options, style: 'currency', currency: display.currency }).format(shown)
    );
  }
  const number = new Intl.NumberFormat(display.locale, options).format(shown);
  return `${prefix}${number} ${Math.abs(units) === 1 ? NEUTRAL_UNIT.one : NEUTRAL_UNIT.other}`;
}

/** Nombre de la unidad para etiquetas de formulario. */
export function moneyUnitLabel(display: MoneyDisplay = MONEY_DISPLAY): string {
  return display.currency ?? NEUTRAL_UNIT.other;
}

/** Aviso que acompaña a cualquier importe. */
export function moneyEstimateNote(display: MoneyDisplay = MONEY_DISPLAY): string {
  return display.currency
    ? `Importes estimados en ${display.currency} a partir del consumo que informa el proveedor de IA y la tarifa configurada en la plataforma. No son una factura.`
    : 'Importes estimados a partir del consumo que informa el proveedor de IA y la tarifa configurada en la plataforma. Se cuentan en créditos de IA, porque la plataforma aún no tiene una moneda fijada. No son una factura.';
}

/**
 * Texto escrito por una persona («50», «12,5», «1.000,25») → micros. `null`
 * si no es un importe válido (negativo, vacío, más de 6 decimales…).
 */
export function parseUnitsToMicros(input: string): number | null {
  let text = input.trim().replace(/\s/g, '');
  if (!text) return null;
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  const micros = Number(whole) * MICROS_PER_UNIT + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(micros) ? micros : null;
}
