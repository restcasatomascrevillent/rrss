import type { NetworkFormatSpec, SpecProvenance } from './networks';

// Zonas seguras: la parte del lienzo que la interfaz de la red puede tapar
// (nombre de la cuenta, botones, pie). Lógica pura sobre el catálogo de redes;
// la usan la superposición del editor y el verificador de marca.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SafeZone {
  /** Zona que se ve siempre, en unidades del lienzo. */
  safe: Rect;
  /** Franjas que puede tapar la interfaz (arriba, abajo, izquierda, derecha), sin solaparse. */
  unsafe: Rect[];
  provenance: SpecProvenance;
  source: string;
  note?: string;
}

/**
 * Zona segura de un formato para un lienzo. `null` si el catálogo no tiene
 * cifra para ese formato o el lienzo no tiene la proporción a la que se refiere
 * (por ejemplo, un 4:5 en una historia: la red lo encaja a su manera).
 */
export function safeZoneFor(
  spec: NetworkFormatSpec | undefined,
  canvas: { aspectRatio: string; width: number; height: number },
): SafeZone | null {
  const zone = spec?.safeZone;
  if (!zone || zone.value.ratio !== canvas.aspectRatio) return null;
  const { width, height } = canvas;
  const { top, bottom, left, right } = zone.value.insets;
  const safe: Rect = {
    left: width * left,
    top: height * top,
    right: width * (1 - right),
    bottom: height * (1 - bottom),
  };
  const unsafe: Rect[] = [
    { left: 0, top: 0, right: width, bottom: safe.top },
    { left: 0, top: safe.bottom, right: width, bottom: height },
    { left: 0, top: safe.top, right: safe.left, bottom: safe.bottom },
    { left: safe.right, top: safe.top, right: width, bottom: safe.bottom },
  ].filter((rect) => rect.right - rect.left > 0 && rect.bottom - rect.top > 0);
  return {
    safe,
    unsafe,
    provenance: zone.provenance,
    source: zone.source,
    ...(zone.note ? { note: zone.note } : {}),
  };
}

/** Parte (0–1) del área de una caja que queda fuera de la zona segura. */
export function shareOutside(box: Rect, safe: Rect): number {
  const area = (box.right - box.left) * (box.bottom - box.top);
  if (area <= 0) return 0;
  const inside =
    Math.max(0, Math.min(box.right, safe.right) - Math.max(box.left, safe.left)) *
    Math.max(0, Math.min(box.bottom, safe.bottom) - Math.max(box.top, safe.top));
  return Math.min(1, Math.max(0, 1 - inside / area));
}
