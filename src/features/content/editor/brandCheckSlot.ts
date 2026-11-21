import { lazy, type ComponentType } from 'react';
import type { BrandCheckPanelProps } from '@/features/brandcheck/ui/BrandCheckPanel';

// Hueco del panel de comprobación de marca en el editor. El panel vive en
// src/features/brandcheck/ui/ y se descarga aparte, solo al abrir la pestaña
// «Marca». Si algún día se vacía este hueco (`null`), el editor deja de enseñar
// la pestaña: lo que no existe no aparece (CLAUDE.md, honestidad del producto).
//
// Lo que el editor le pasa: el documento tal como está (con los cambios sin
// guardar), la red, el formato, la marca, la paleta dominante de la imagen
// (si se ha podido leer) y a quién avisar al pulsar un hallazgo.
export type { BrandCheckPanelProps };

export const BRAND_CHECK_PANEL: ComponentType<BrandCheckPanelProps> | null = lazy(() =>
  import('@/features/brandcheck/ui/BrandCheckPanel').then((m) => ({ default: m.BrandCheckPanel })),
);
