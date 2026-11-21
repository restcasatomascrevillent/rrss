// PUNTO DE ENGANCHE, SIN IMPLEMENTAR: exportar a imagen un «documento por capas».
//
// El formato del documento lo está definiendo otra pieza de la Fase 2. Cuando
// exista, este manejador validará la carga con su esquema, dibujará el
// documento en cada formato pedido y subirá las imágenes, igual que los demás.
//
// Hasta entonces NO está registrado en `createMediaHandlers`: el trabajador no
// reclama trabajos de este tipo (se quedan en cola, a la vista) y nada simula
// un resultado. Para activarlo: implementar `run` y añadirlo a ese registro.
import { NotImplementedError } from '../errors.ts';
import type { Handler } from '../handler.ts';
import type { MediaDeps } from './shared.ts';

export const DOCUMENT_EXPORT_KIND = 'media.document.export';

export function createDocumentExportHandler(_deps: MediaDeps): Handler {
  return {
    kind: DOCUMENT_EXPORT_KIND,
    async run() {
      throw new NotImplementedError('La exportación de documentos por capas todavía no está implementada');
    },
  };
}
