// Marca de contenido generado con IA (Reglamento europeo de IA, art. 50).
//
// La fuente de verdad es la base de datos: al guardar cada versión calcula
// `content_versions.ai_generated` (y la pieza copia el de su versión vigente)
// con `private.content_document_ai_generated` (migración
// 20261119411000_contenido_generado_ia). Esta función es su espejo en el
// editor, para enseñar la marca mientras se trabaja, antes de guardar. Mira lo
// mismo salvo el rastro de exportaciones y reels (eso solo lo sabe la base de
// datos, que conoce sus fuentes): por eso el editor la combina con la marca
// guardada de la pieza.
//
// La publicación (Fase 3) debe leer `content_versions.ai_generated` de la
// versión exacta que publique, no esta función.
import { allLayers, type ContentDocument } from './document';

export type AiContentReason =
  | { kind: 'caption' }
  | { kind: 'layer'; layerId: string; name: string }
  | { kind: 'generation'; layerId: string; name: string }
  | { kind: 'asset'; layerId: string; name: string };

/** Lo que hace falta de cada recurso de la biblioteca usado en el documento. */
export interface AiAssetInfo {
  id: string;
  provenance?: unknown;
}

function isAiAsset(asset: AiAssetInfo | undefined): boolean {
  const provenance = asset?.provenance;
  return (
    typeof provenance === 'object' && provenance !== null && (provenance as { type?: unknown }).type === 'ai_generation'
  );
}

/** Por qué el documento lleva contenido generado con IA (vacío si no lo lleva). */
export function aiContentReasons(document: ContentDocument, assets: AiAssetInfo[] = []): AiContentReason[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const reasons: AiContentReason[] = [];
  if (document.copy.aiGenerated === true) reasons.push({ kind: 'caption' });
  for (const layer of allLayers(document)) {
    const ref = { layerId: layer.id, name: layer.name };
    if (layer.aiGenerated === true) reasons.push({ kind: 'layer', ...ref });
    else if (layer.type === 'image' && layer.source.kind === 'generation') reasons.push({ kind: 'generation', ...ref });
    else if (layer.type === 'image' && layer.source.kind === 'asset' && isAiAsset(byId.get(layer.source.assetId)))
      reasons.push({ kind: 'asset', ...ref });
    else if (layer.type === 'logo' && isAiAsset(byId.get(layer.assetId))) reasons.push({ kind: 'asset', ...ref });
  }
  return reasons;
}

/** Frase para la interfaz. */
export function describeAiReasons(reasons: AiContentReason[]): string {
  const caption = reasons.some((r) => r.kind === 'caption');
  const layers = reasons.filter((r) => r.kind !== 'caption').length;
  const parts = [
    ...(caption ? ['el texto de la publicación'] : []),
    ...(layers === 1 ? ['una imagen o capa'] : layers > 1 ? [`${layers} imágenes o capas`] : []),
  ];
  return parts.length ? `Generado con IA: ${parts.join(' y ')}.` : '';
}
