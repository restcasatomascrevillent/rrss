# Exportar imagen desde el editor

Estado: implementado y probado (lógica y diálogo con dobles; dibujo comprobado a mano en un navegador). Sin variables de entorno nuevas.

## Qué hace

«Exportar imagen» (cabecera del editor, disponible también en solo lectura) genera la imagen final de lo que se ve en el lienzo, **con los cambios sin guardar** (el diálogo lo avisa).

- Tamaño real del lienzo lógico (1080×1080, 1080×1350, 1080×1920, 1920×1080) a escala 1; opcionalmente el doble si no pasa de 4096 px por lado. El `pixelRatio` se pasa siempre explícito: el resultado no depende del monitor.
- PNG o JPEG (calidad 50–100 %, solo JPEG).
- Un escenario de Konva fuera de pantalla, sin guías, selección ni tiradores. Usa el mismo dibujo que el lienzo del editor (`editor/canvas/draw.ts`), así que lo que se exporta y lo que se ve salen del mismo código.
- Antes de dibujar espera a las tipografías de los textos (`document.fonts.load`, con un tope de 8 s). La aplicación hoy no carga tipografías web propias: solo se ven las del sistema del equipo.
- Salidas: descargar el archivo y/o guardarlo en la biblioteca (carpeta «Exportaciones», etiqueta «exportación»), con nombre legible editable (`menu-de-otono-1080x1350-v3.png`; `-borrador` si hay cambios sin guardar).
- Con cambios sin guardar y destino biblioteca, ofrece (marcado por omisión) guardar antes una versión nueva para que la procedencia sea exacta. Si se desmarca, la procedencia queda como «versión base + cambios sin guardar».

## Errores explicados

No se exporta (y se dice por qué, con el nombre de las capas implicadas) si:

- una imagen no tiene dirección (cargando, sin acceso o generación de IA aún sin conectar): saldría el recuadro gris del editor;
- una imagen no carga (dirección firmada caducada, que duran 1 h, o sin CORS);
- el navegador bloquea la lectura del lienzo por «mancha» (`SecurityError`): suele ser una copia en caché de la imagen sin CORS; se indica recargar sin caché o volver a subirla a la biblioteca.

Las imágenes se cargan con `crossOrigin = "anonymous"`; el cubo de Storage debe responder con cabeceras CORS (Supabase lo hace por omisión).

## Procedencia

Columna nueva `media_assets.provenance` (migración `20261118120000_media_assets_provenance.sql`, con su vuelta atrás). Se escribe al insertar y **no se puede cambiar después** (sin privilegio de UPDATE para el cliente); un recurso subido a mano la tiene vacía (`{}`). No se usó `rights` porque son los derechos de uso, que la persona edita y se reescriben enteros desde la ficha del recurso.

```json
{
  "type": "export",
  "content_id": "<uuid de la pieza>",
  "version": 3,
  "unsaved_changes": false,
  "format": "png",
  "width": 1080,
  "height": 1350,
  "pixel_ratio": 1,
  "exported_at": "2026-11-18T10:00:00.000Z"
}
```

La base de datos solo exige un objeto con `type` de texto y como mucho 2048 bytes. `content_id` no es clave foránea a propósito (la pieza puede borrarse y el recurso conserva de dónde salió): quien lo lea debe comprobar que la pieza es de su marca. Hay índice por `content_id` para listar lo que sale de una pieza.

## Exportación en el servidor (pendiente)

No se ha tocado `worker/src/handlers/document-export.ts`. Para que produzca lo mismo píxel a píxel que el navegador haría falta:

1. Mismo dibujo: reutilizar `describeDocument` y `draw.ts` (son datos y funciones puras de Konva, sin React) con `skia-canvas` como lienzo de Konva en Node.
2. Mismas tipografías: instalar en la imagen del trabajador los archivos de cada tipografía de la marca y registrarlos en skia-canvas (hoy ni el navegador ni el servidor las cargan; con tipografías del sistema el texto cambia de un equipo a otro, y Skia y el navegador también difieren en el suavizado y en el ajuste de líneas).
3. Mismas imágenes: descargar los recursos con URL firmadas de servicio y descodificarlos con el mismo recorte (`coverCrop`/`containBox`); cuidar la orientación EXIF y el perfil de color, que el navegador aplica y Skia puede no aplicar.
4. Mismo codificador: PNG es sin pérdida, pero JPEG no coincide byte a byte entre codificadores; la igualdad «píxel a píxel» solo es exigible en PNG.
5. Una prueba de referencia: documentos de ejemplo exportados en el navegador (PNG) y comparados con la salida del servidor con una tolerancia pequeña en los bordes del texto.
