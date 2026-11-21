# Edición de fotos bajo demanda

Rama `f6/edicion-fotos` (sale de `f5/integracion`). Para cualquier marca, desde
la **ficha de una foto en la biblioteca** («Editar foto») y desde una **capa de
imagen del editor** («Editar foto» en el panel Diseño; el resultado sustituye
la imagen de la capa y se deshace con Ctrl+Z).

**Regla que no se rompe:** la foto original no se toca nunca. Cada resultado
es un recurso **nuevo** de la biblioteca (carpeta «Ediciones»), con su
procedencia en `media_assets.provenance`, igual que «Exportar imagen».

## 1. Qué hace cada acción y con qué

| Acción | Con IA | Dónde se hace | Procedencia del resultado |
|---|---|---|---|
| Mejorar: luz, contraste, color, temperatura, nitidez («Mejorar automáticamente» o a mano) | No | Navegador (`src/features/photo-edit/pixels.ts`) | `photo_edit`, paso `adjust` con los valores |
| Mejorar: encuadre a 1:1, 4:5 o 9:16 | No | Navegador (`framing.ts`) | `photo_edit`, paso `crop` con la caja |
| Recortes por red 1:1, 4:5 y 9:16 con encuadre inteligente (uno por formato) | No | Navegador (`framing.ts`) | `photo_edit`, paso `crop` |
| Poner fondo liso, de un color de la marca o una imagen de la biblioteca, con sombra suave opcional (a una foto que ya tiene transparencia o recién recortada) | No | Navegador (`cutout/composition.ts`) | `photo_edit`, paso `background` (con `shadow: true` si lleva sombra) |
| Quitar el fondo, **en el navegador** (por defecto) | No (modelo propio en el navegador, gratis) | Navegador (`cutout/`, §7) | `photo_edit`, paso `remove_background` (`engine: browser`) |
| Quitar el fondo, con IA (si el servidor tiene proveedor) | **Sí** | `ai-media` (`photo.edit`) → adaptador de IA de medios | `ai_edit`, `operation: remove_background` |
| Ampliar la resolución ×2 o ×4 (hasta 4096 px por lado) | **Sí** | `ai-media` (`photo.edit`) → adaptador | `ai_edit`, `operation: upscale`, `scale` |
| Cambiar el fondo con IA (texto libre; máscara del plato si la hay) | **Sí** | `ai-media` (`photo.edit`) → OpenAI (§7) | `ai_edit`, `operation: replace_background`, `prompt` |
| Mejorar luz y color con IA | **Sí** | `ai-media` (`photo.edit`) → OpenAI (§7) | `ai_edit`, `operation: enhance` |

«Cambiar el fondo» de una foto normal son dos pasos: quitarlo (en el navegador
o con IA) y poner otro (sin IA). Con el navegador, el recorte se queda en el
diálogo (sin guardar) y se elige el fondo encima, con vista previa; se guarda
UN recurso con los dos pasos en su procedencia (o solo el PNG transparente).
Con IA, al terminar de quitarlo el diálogo pasa a editar la foto sin fondo.
Si el servidor tiene IA además del navegador, salen las dos opciones y está
marcada la del navegador.

Se editan fotos y logotipos JPEG, PNG o WebP. Con IA, además, tienen que estar
en nuestro almacenamiento (Supabase o R2; las de Google Drive no se mandan a
ningún proveedor) y tener medidas. En el navegador se edita hasta 24 MP; lo
mayor se reduce y se avisa.

### Sin IA: cómo funciona y sus límites

- **Mejorar automáticamente** mira el histograma: estira negros y blancos si
  la foto no llega, corrige la mitad de la dominante de color (mundo gris),
  aclara las oscuras, aviva un poco las apagadas y da algo de nitidez
  (máscara de enfoque sobre la luminancia). Es moderado a propósito y se
  puede retocar con los deslizadores antes de guardar.
- **Encuadre inteligente** no reconoce objetos: busca dónde se concentran los
  bordes, el detalle y el color, con algo de preferencia por el centro, y
  coloca ahí el recorte más grande que cabe en cada formato. Funciona bien con
  un plato o un producto sobre un fondo más liso; con fondos cargados conviene
  mirar la vista previa (y se puede desmarcar para centrar).
- El resultado es PNG si tiene transparencia o el original era PNG; si no,
  JPEG al 92 %. Los ajustes se ven en una vista previa reducida y se guardan a
  tamaño completo.
- Las fotos se leen con `crossOrigin = "anonymous"` (como «Exportar imagen»);
  si el navegador las tiene en caché sin CORS, lo dice.

### Con IA: interruptor, cupo y coste

- Salen solo con **`VITE_AI_PHOTO_EDIT_ENABLED=true`** en el despliegue **y**
  si el servidor tiene un modelo para esa acción (`ai-media`,
  `photo.options`). Sin proveedor, la pestaña «Ampliar» y la opción de quitar el
  fondo con IA no aparecen; quitar el fondo sigue disponible en el navegador (§7).
- Mismo camino que la imagen con IA (`docs/ia-medios.md`): se estima el coste
  máximo **antes** (`photo.estimate`, no reserva nada) y se enseña; al editar,
  `ai_reserve_generation` aparta el cupo de la **organización** (tarea
  `image`, función del plan `ai_image`); sin cupo no se llama al proveedor. Cada
  edición queda en `ai_generations` con `purpose = photo.remove_background` o
  `photo.upscale` y su coste real: sale en el consumo de IA y en el margen por
  cliente como cualquier generación.
- Quien solo ve la marca no puede editar (la base de datos lo impide al
  reservar, 403). La foto se lee con la identidad de quien pide (RLS) y viaja
  al proveedor como URL firmada de 15 minutos.
- Los asíncronos (ComfyUI) los cierra `ai-media-poll`; si se cierra el
  diálogo, el resultado llega igualmente a la biblioteca.

## 2. Servidor

- Contrato (`_shared/ai/media/contract.ts`): petición `ImageEditRequest`
  (`kind: 'image_edit'`, `operation`, `source` con medidas, `scale`). Los
  adaptadores declaran las ediciones que saben hacer (`edits`). Los adaptadores
  que no las saben (Vertex, BFL, Ideogram, vídeo) las rechazan.
- Registro (`ai_media_models.operation`): `generate` (por defecto),
  `remove_background` o `upscale`. **Un modelo de edición nunca se elige para
  generar ni al revés** (`resolveMediaModel` / `resolveEditModel`). Mismo
  criterio de datos: solo se eligen solos los que procesan en la UE; los demás
  hay que fijarlos con `AI_MEDIA_REMOVE_BACKGROUND_MODEL` o
  `AI_MEDIA_UPSCALE_MODEL` (`proveedor:modelo`) o permitirlos con
  `AI_MEDIA_ALLOW_NON_EU`.
- Validación antes de reservar: JPEG, PNG o WebP; como mucho 36 MP de entrada
  (`settings.max_input_pixels`); al ampliar, como mucho 4096 px por lado del
  resultado (`settings.max_output_side`).
- Almacenamiento: `…/ia/<generación>-0.png`, carpeta «Ediciones», etiquetas
  `ia` y `edición`, nombre «Sin fondo · <original>.png» o «Ampliada ×2 ·
  <original>.png».
- `ai-media` (acciones nuevas):
  - `photo.options` → `{ edits: [{ operation, model, delivery, dataRegion, euProcessing, trainsOnInputs, untestedAdapter }] }`
  - `photo.estimate` `{ assetId, operation, scale? }` → `{ costMicros, model, dataHandling }`
  - `photo.edit` `{ assetId, operation, scale? }` → 200 `{ status: "completed", asset }` o 202 `{ status: "pending", generationId }`.

## 3. Base de datos (migración `20261128010000_photo_editing.sql`)

Con su vuelta atrás en `supabase/rollbacks/`. **Sin tablas nuevas**: el
registro de cada edición con IA es su fila de `ai_generations` y la relación
con el original vive en la procedencia del recurso.

1. `ai_media_models.operation` con sus restricciones (las ediciones solo de
   imagen) y privilegio de cambiarla solo para superadministradores (RLS del
   registro).
2. Dos filas de ComfyUI propio **inactivas** y con el precio **sin verificar**:
   `comfyui · birefnet-general` (quitar el fondo) y `comfyui ·
   realesrgan-x4plus` (ampliar).
3. Guarda de la procedencia (`private.media_assets_edit_provenance_guard`):
   - `type: 'ai_edit'` solo lo escribe el servidor (como `ai_generation`);
   - en `ai_edit` y `photo_edit`, `source_asset_id` tiene que ser un recurso de
     **la misma marca** que quien inserta puede ver: no se puede decir que una
     foto sale de la de otra marca u organización. No es clave foránea a
     propósito (si el original se borra, la edición conserva de dónde salió);
   - índice por `source_asset_id` para listar las ediciones de una foto.

Procedencia de una edición del navegador:

```json
{ "type": "photo_edit", "source_asset_id": "…", "width": 1080, "height": 1350,
  "edited_at": "2026-11-20T10:00:00.000Z",
  "steps": [ { "kind": "adjust", "auto": true, "exposure": 12, "contrast": 0, "saturation": 8,
               "warmth": 0, "sharpness": 20, "levels": { "black": 14, "white": 231 }, "balance": [1.04, 1, 0.95] },
             { "kind": "crop", "aspect": "4:5", "smart": true, "box": { "x": 310, "y": 0, "width": 2400, "height": 3000 } } ] }
```

Con IA:

```json
{ "type": "ai_edit", "operation": "remove_background", "source_asset_id": "…", "generation_id": "…",
  "provider": "comfyui", "model": "birefnet-general", "purpose": "photo.remove_background",
  "data_region": "unknown", "trains_on_inputs": "no", "untested_adapter": true }
```

## 4. ComfyUI propio: flujos de trabajo (opción principal)

**SIN CONTRASTAR con un ComfyUI real** (solo con respuestas HTTP simuladas).
Mismo servidor, túnel y riesgos que la imagen con IA (`docs/ia-medios.md` §11).

### Ampliar (`comfyui · realesrgan-x4plus`): solo nodos del núcleo

```
LoadImage(foto) ─► ImageUpscaleWithModel(UpscaleModelLoader("RealESRGAN_x4plus.pth"))
               ─► ImageScale(lanczos, ancho × alto exactos, crop disabled) ─► SaveImage
Si la foto es PNG o WebP (puede tener alfa):
LoadImage.mask ─► MaskToImage ─► ImageScale(mismo tamaño) ─► ImageToMask(red)
               ─► JoinImageWithAlpha(imagen ampliada, alfa) ─► SaveImage
```

Real-ESRGAN amplía ×4 de forma nativa; para ×2 se reduce después al tamaño
exacto. Archivo: `RealESRGAN_x4plus.pth` (Real-ESRGAN, licencia BSD-3-Clause)
en `ComfyUI/models/upscale_models/`. El nombre se cambia en
`settings.upscale_model_name`.

### Quitar el fondo (`comfyui · birefnet-general`): un nodo personalizado

El núcleo de ComfyUI no tiene ningún nodo que quite el fondo. El flujo usa,
por defecto, el nodo `BiRefNetRMBG` del paquete **ComfyUI-RMBG**
(1038lab/ComfyUI-RMBG, licencia GPL-3.0; se ejecuta en el servidor de
ComfyUI, no se distribuye con nuestro código) con el modelo **BiRefNet**
(licencia MIT):

```
LoadImage(foto) ─► <rmbg_class_type>(image = foto, …rmbg_inputs) ─► máscara (salida rmbg_mask_output)
               ─► InvertMask (si rmbg_mask_is_foreground) ─► JoinImageWithAlpha(foto, alfa) ─► SaveImage (PNG con alfa)
```

`JoinImageWithAlpha` (núcleo) invierte la máscara que recibe (en ComfyUI las
máscaras marcan lo transparente); por eso se invierte antes cuando el nodo
devuelve «1 = lo que se queda». Todo es configurable en `settings` sin tocar
código: `rmbg_class_type`, `rmbg_inputs`, `rmbg_image_input`,
`rmbg_mask_output`, `rmbg_mask_is_foreground`.

**Antes de activarlo:**

1. Instalar ComfyUI-RMBG fijado a un commit concreto (como el resto de nodos
   del cuaderno) y comprobar sus nombres con `GET /object_info/BiRefNetRMBG`
   (entradas y en qué salida va la máscara). Si no coinciden, ajustar
   `settings` en la fila.
2. **Ojo: ese paquete descarga los pesos del modelo la primera vez que se usa.**
   Hacerlo a propósito al preparar el servidor (no en la primera petición de un
   cliente) y comprobar la licencia del modelo elegido: **RMBG-2.0 de BRIA es
   CC BY-NC (no comercial): no usarlo**; BiRefNet es MIT.
3. Fijar el precio por imagen según la GPU y activar:
   `update ai_media_models set price_micros = <coste>, price_verified = true, active = true where provider = 'comfyui' and operation <> 'generate';`
4. Si el servidor no está en la UE (Colab: región desconocida):
   `AI_MEDIA_REMOVE_BACKGROUND_MODEL=comfyui:birefnet-general` y
   `AI_MEDIA_UPSCALE_MODEL=comfyui:realesrgan-x4plus` en las funciones.
5. `VITE_AI_PHOTO_EDIT_ENABLED=true` en el despliegue.

## 5. Alternativa sin GPU en el trabajador (valoración, sin descargar nada)

Pregunta: ¿se puede quitar el fondo en el trabajador de medios (Node + FFmpeg,
sin GPU) con calidad aceptable? **Sí, con condiciones**, pero no se ha hecho:
habría que descargar pesos (100–200 MB) y eso queda a la espera del «sí».

| Opción | Licencia (a contrastar en la ficha del modelo antes de usar) | Calidad esperada en fotos de producto o plato | CPU (orden de magnitud, sin medir) |
|---|---|---|---|
| BiRefNet (general o *lite*) en ONNX con `onnxruntime-node` | MIT (modelo), MIT (onnxruntime) | La mejor de las abiertas, bordes finos | Varios segundos por foto a 1024 px con 2–4 vCPU; 1,5–2 GB de RAM |
| IS-Net (DIS, `isnet-general-use`) en ONNX | Apache-2.0 | Buena; algo peor en pelo y bordes finos | 1–3 s por foto; ~1 GB de RAM |
| U²-Net / U²-Netp | Apache-2.0 | Aceptable en objetos con fondo liso; flojo en bordes (máscara a 320 px) | < 1 s; U²-Netp pesa 4,7 MB |
| `@imgly/background-removal-node` | **AGPL-3.0**: obligaría a publicar el código del servicio. Descartada | — | — |
| RMBG-1.4 / RMBG-2.0 de BRIA | **No comercial** sin contrato. Descartada | — | — |

Recomendación si el dueño lo quiere: trabajo nuevo `media.image.remove_background`
en el trabajador con `onnxruntime-node` y **BiRefNet lite** (o IS-Net si la
máquina es pequeña), pesos copiados en la imagen Docker del trabajador (no
descargados al vuelo), salida PNG con alfa a la carpeta «Ediciones» con
procedencia `media_job`. Coste por foto: solo CPU del trabajador (sin cupo de
IA, pero sí de almacenamiento). Encaja con el alojamiento propuesto (Fly.io en
Fráncfort, datos en la UE). Pendiente: el «sí» a descargar los pesos, medir
tiempo y calidad con 20–30 fotos reales de la marca, y el tamaño de máquina.

## 7. Quitar el fondo en el navegador (sin IA, sin coste)

Rama `f7/recorte-navegador`. Mismo enfoque que el panel del restaurante
(IS-Net en un Web Worker con `onnxruntime-web`, WebGPU si hay y WASM si no),
genérico y sin nada de ningún cliente. Código en `src/features/photo-edit/cutout/`.

- **Modelo:** IS-Net «general use» (DIS), ONNX con pesos en float16 y entrada y
  salida en float32, de `imgly/isnet-general-onnx` en Hugging Face
  (`onnx/model_fp16.onnx`). **88 152 708 bytes (≈ 84 MiB)**. Licencia: el
  modelo declara **MIT** (ficha de Hugging Face) y la arquitectura y los pesos
  originales de IS-Net/DIS son **Apache-2.0** (permiten uso comercial y
  redistribución). `onnxruntime-web` es MIT. Cautelas: la ficha de ese
  repositorio es de una línea (sin detalle de los datos de entrenamiento, DIS5K)
  y existe otra conversión (`onnx-community/ISNet-ONNX`) etiquetada AGPL-3.0, que
  **no se usa**; antes de un contrato con un cliente grande conviene que lo
  revise quien lleve lo legal. `@imgly/background-removal` (AGPL) y RMBG de BRIA
  (no comercial) siguen descartados (§5).
- **De dónde se descarga:** en tiempo de ejecución, desde el navegador de quien
  edita, a la URL de `VITE_CUTOUT_MODEL_URL` o, si no está definida, a la de
  Hugging Face (CORS abierto, sin clave). **No está en el repositorio** ni lo
  sirve nuestro despliegue. Para alojarlo en el propio despliegue (más fiable y
  sin depender de Hugging Face): copiar el `.onnx` a `public/models/` y poner
  `VITE_CUTOUT_MODEL_URL=/models/<archivo>.onnx` (sirve también la versión
  cuantizada a uint8 de 46,7 MB del panel, mismas entradas y salidas). Cambiar
  de modelo = cambiar `CUTOUT_MODEL_CACHE` en `cutout/model.ts`.
- **Caché:** la primera vez se baja entero (con progreso) y se guarda en Cache
  Storage (`rrss-cutout-model-v1`); después se lee de ahí sin red. Si el
  navegador no deja guardar, funciona igual y vuelve a descargar. El motor de
  onnxruntime (WASM, ≈ 27 MB) se carga dentro del worker solo al usarlo: no
  entra en el paquete inicial. El worker se termina tras 60 s sin uso.
- **Flujo:** Editar foto → Fondo → «Quitar el fondo» (progreso: descargando el
  modelo con MB, preparando, quitando el fondo) → fondo liso, color de la marca
  o imagen de la biblioteca (mármol, mantel…), sombra suave opcional (la
  silueta desplazada abajo y desenfocada, opacidad máxima 35 %), vista previa →
  guardar. La foto no sale del navegador. Resultado: recurso nuevo con
  `photo_edit` y pasos `remove_background` (`engine`, `model`) y `background`
  (`color` o `asset_id`, `shadow`); el original no se toca. Sin migración ni
  cambios en el servidor.
- **Cuando el navegador no puede:** sin `Worker` o `WebAssembly`, o con menos de
  2 GB de memoria (`navigator.deviceMemory`), el diálogo lo dice y no ofrece el
  botón (si hay IA en el servidor, queda esa). Fallos al recortar (sin red,
  memoria, sin WebGPU ni WASM, nada que recortar) se explican en claro y se puede
  reintentar. WebGPU que falle o dé una máscara vacía se repite en WASM.
- **Calidad de la máscara:** el alfa sale de la máscara del modelo escalada con
  interpolación bilineal y una curva suave; **no** lleva el filtro guiado del
  panel (que conserva mejor antenas, patas y cristal fino). Para platos y
  productos basta; si hiciera falta más, es el siguiente paso.
- **Rendimiento (medido solo en CPU de Node, no en un navegador):** el modelo
  float16 se carga y ejecuta bien con `onnxruntime-node` (entrada y salida
  float32 de 1×3×1024×1024 y 1×1×1024×1024; ≈ 1,4 s en CPU de escritorio).
  En navegador con WASM de 1 hilo se espera bastante más (el panel midió
  13–19 s con el modelo uint8); con WebGPU, 1–2 s. **Sin medir en navegador.**
- **Cabeceras COOP/COEP: no se activan, a propósito.** Solo darían hilos en
  WASM (`SharedArrayBuffer`). `Cross-Origin-Embedder-Policy: require-corp`
  bloquearía las fotos de Storage, R2, Drive y las miniaturas de redes (no
  mandan `Cross-Origin-Resource-Policy`), el modelo alojado fuera y las ventanas
  de OAuth (COOP). `vercel.json` queda como estaba y el worker usa 1 hilo
  (`numThreads = 1` salvo que la página ya esté aislada).
- **Para las pruebas e2e:** `VITE_CUTOUT_SIMULATED=true` (solo en
  `playwright.config.ts`) cambia únicamente lo que devuelve el worker por una
  máscara elíptica; el resto del camino es real. Sin esa variable no existe esa
  rama en el paquete de producción.

## 6. Pruebas

- Unitarias (`src/features/photo-edit/edicion.test.ts`): ajustes (sin cambio
  con ajustes neutros, la entrada no cambia, nitidez, automático), fondo y
  transparencia, encuadre inteligente (se va donde está el detalle, centrado si
  no hay nada), procedencia y nombres, qué se puede editar y factores de
  ampliación.
- Componentes (`editarFoto.test.tsx`): biblioteca (lectora no edita; mejorar y
  recortes guardan recursos nuevos con procedencia y el original no cambia;
  sin IA no se ofrece quitar el fondo; fondo de color sobre una foto sin fondo;
  con IA, coste antes y resultado nuevo; interruptor encendido sin modelo) y
  editor (la capa pasa a usar la foto editada). El lienzo del navegador se
  sustituye por dobles (jsdom no dibuja).
- Base de datos (`tests/db/edicion-fotos.test.ts`): migración, guarda de la
  procedencia y aislamiento entre marcas y organizaciones, elección de modelo,
  `ai-media` con la edición simulada (recurso nuevo, original intacto, cupo,
  permisos, límites) y ComfyUI con HTTP simulado (flujos y camino asíncrono
  hasta la biblioteca).
- Extremo a extremo: `tests/e2e/22-edicion-fotos.spec.ts` (quitar el fondo con
  la edición simulada y comprobar que la fila y el archivo originales no
  cambian). **Escrita y sin ejecutar.**

**Sin probar:** contra un ComfyUI real (los dos flujos), el dibujo real en un
navegador (lectura de píxeles, codificación PNG/JPEG, CORS de R2 y de Drive) y
la prueba e2e.

Quitar el fondo en el navegador (§7):
- Unitarias (`cutout/cutout.test.ts`): entrada y máscara del modelo, composición
  (color, imagen, tamaño, sombra debajo del sujeto y suave, opacidad), descarga
  con progreso y caché, errores de descarga y procedencia.
- Componentes (`editarFoto.test.tsx`): se ofrece sin IA; navegador sin soporte;
  progreso de descarga; guarda un recurso nuevo con sus dos pasos y el original
  no cambia; guardar solo el PNG transparente; error y reintento; con IA y
  navegador, el del navegador va por defecto. El recorte está simulado.
- e2e `tests/e2e/25-recorte-navegador.spec.ts` (máscara del worker simulada, lo
  demás real; comprueba que el original no cambia). **Escrita y sin ejecutar**
  (el Supabase local de esta máquina lo ocupaba otro proyecto). **Sin probar:**
  el modelo real en un navegador real (descarga, WebGPU, WASM, tiempos, calidad).

## 8. Cambiar el fondo con IA y mejorar con IA (OpenAI)

Dos acciones de `ai-media` (`photo.edit`) que se suman a quitar el fondo y
ampliar: **`replace_background`** («Cambiar el fondo con IA») y **`enhance`**
(«Mejorar luz y color con IA»). Hoy las hace el adaptador de OpenAI
(`docs/ia-medios.md`, §13); otro proveedor las ofrece si su adaptador declara
esas ediciones. Salen en el diálogo solo si el servidor tiene un modelo activo
y permitido para ellas (misma regla que «Ampliar»).

- **Dónde:** pestaña **«Fondo con IA»** de «Editar foto» (el mismo diálogo se
  abre desde la ficha de la biblioteca y desde el editor de piezas).
- **Cómo se usa:** un campo de texto («¿qué fondo quieres?», hasta 500
  caracteres) y sugerencias a un clic: mesa de mármol blanco con luz cálida,
  mantel de lino beige, mesa de madera rústica, pizarra oscura
  (`BACKGROUND_SUGGESTIONS` en `api.ts`). Se ve el coste máximo antes y si se
  procesa fuera de la UE. El botón no se activa sin texto.
- **Proteger el plato (dos capas).**
  1. **Máscara.** Si el navegador puede recortar (`cutoutSupport()`, §7), antes
     de llamar a `ai-media` se recorta el plato con el mismo IS-Net (mismo
     worker, misma caché del modelo y misma barra de progreso) y su alfa se
     convierte en la máscara. **Convenio** (el del adaptador de OpenAI, que
     manda el PNG tal cual como `mask`; OpenAI repinta lo transparente): PNG RGBA
     con las medidas **exactas de la foto original** (`asset.width × height`,
     aunque el recorte se hiciera sobre una versión reducida), **plato opaco
     (alfa 255), fondo transparente (alfa 0)**, sin grises (alfa ≥ 128 → 255).
     Código: `cutout/plate.ts` (`subjectMaskPixels`).
  2. **Garantía.** OpenAI documenta que la máscara es orientativa, así que al
     recibir el resultado el navegador lo descarga, vuelve a pegar el plato
     **original** encima (`restorePlate`: original y alfa escalados al tamaño del
     resultado, borde suavizado con un radio ≈ 0,4 % del lado menor) y guarda
     esa versión. Casilla **«Proteger el plato original»**, marcada por
     defecto; sin marcar, se manda la máscara igualmente pero el resultado de la
     IA se deja como llega.
  - **Qué se guarda.** Con protección, el recurso es **uno solo**: la versión
    con el plato pegado, con procedencia `photo_edit` (no `ai_edit`: la guarda de
    la base de datos solo deja al servidor escribir `ai_edit`) y un paso
    `ai_background` (`prompt`, `model` de la IA, `mask_model` del recorte,
    `plate_protected: true`). La copia sin proteger que ya creó `ai-media` se
    borra de la biblioteca (el coste de IA no se devuelve). Sin protección, el
    recurso es el de `ai-media` con su `ai_edit` y **sin** la marca (esa
    procedencia no se puede tocar desde el navegador).
  - **Si algo falla.** Recorte imposible (sin red para el modelo, memoria,
    nada que recortar): no se llama a la IA y se explica. Si el resultado de la
    IA llega con otra proporción (más del 3 %) o no se puede abrir o guardar, se
    deja el resultado de la IA y se avisa de que hay que revisar el plato.
  - **Sin recorte posible** (navegador sin WebAssembly o con poca memoria): se
    mantiene el aviso «No hay recorte del plato: la IA puede retocar también el
    plato», sin casilla ni máscara.
  - **Límite.** La recomposición se hace sobre la foto cargada (como mucho
    24 MP) y al tamaño del resultado de la IA (~1,5 MP). El plato sale con la
    resolución del resultado, no la de la foto original.
- **Interfaz «máscara del sujeto opcional» (para el integrador).**
  `PhotoEditDialog` sigue aceptando
  `getSubjectMask?: (asset) => Promise<Blob | null>` (mismo convenio: PNG con
  las medidas de la foto, plato opaco). Si se pasa, **sustituye** al recorte del
  navegador y, como no hay recorte propio, **no** se vuelve a pegar el plato ni
  sale la casilla. Sin ella (lo normal) se usa el recorte del navegador. El
  servidor comprueba que sea un PNG con las medidas de la foto (hasta 1 MB).
- **Resultado:** un recurso **nuevo** («Fondo nuevo · <original>.jpg»,
  carpeta «Ediciones», etiqueta «ia»), con procedencia `ai_edit`
  (`operation: replace_background`, `source_asset_id`, el encargo en `prompt`,
  proveedor, modelo, región y `untested_adapter`). El original no se toca.
- **Tamaño del resultado:** ~1,5 MP con la proporción de la foto (p. ej. una
  de 4000×3000 sale a 1456×1088). Para más resolución, «Ampliar» después.
- **Quitar el fondo** con OpenAI (PNG transparente) es la opción de menor
  prioridad: si hay un modelo propio (ComfyUI) activo, gana ese.
- **API:** `photo.estimate`/`photo.edit` con `operation`, `prompt` (obligatorio
  en `replace_background`, prohibido en las demás) y `subjectMask` (base64 de
  un PNG; en `photo.estimate` basta `maskPresent: true`). El cuerpo admite
  hasta 1,5 MB por esa máscara.

**Pruebas:** `tests/db/ia-openai-imagen.test.ts` (adaptador con `fetch`
simulado: multipart con foto y máscara, parseo, errores, coste, tamaños;
catálogo y precios; configuración y residencia; «Probar conexión»),
`tests/db/edicion-fotos.test.ts` (función con la edición simulada, máscara
inválida, procedencia con el encargo), `editarFoto.test.tsx` (flujo del
diálogo, con el recorte y la respuesta de la IA simulados: máscara enviada,
plato vuelto a pegar, casilla desmarcada y fallo de proporción),
`cutout/plate.test.ts` (convenio y medidas de la máscara, recomposición, borde
suave, proporción) y la e2e `tests/e2e/26-cambiar-fondo-ia.spec.ts`
(actualizada para el recorte simulado del worker y la procedencia
`photo_edit`/`ai_background`; **escrita, sin ejecutar**: el Supabase local de esta máquina lo usaba otro proyecto).
**Sin probar:** contra OpenAI real (ver `docs/ia-medios.md`, §13), el recorte real del plato en un navegador y el borde de la recomposición a ojo.

## 10. Ediciones sencillas dentro del editor (rama `f13/edicion-sencilla`, 21/11/2026)

Lo de «Editar foto» (secciones 1 a 9) crea siempre una **foto nueva** en la
biblioteca. Esto es distinto y complementario: ediciones **que se guardan en la
capa del diseño** (documento v5), sin tocar la foto ni crear archivos, que se
deshacen con Ctrl+Z, funcionan por página en los carruseles y salen igual en el
lienzo y al exportar.

### Qué hay y dónde

| Edición | Dónde | Se guarda como | Con IA |
|---|---|---|---|
| Brillo, contraste, saturación, temperatura, nitidez | Panel «Diseño» de una capa de imagen → «Luz y color» | `adjust` de la capa | No |
| Filtros rápidos (blanco y negro, sepia, vivo, cálido, frío, desvaído, dramático) | «Luz y color» → «Filtros rápidos» | `adjust.filter` | No |
| Girar 90°, voltear ↔ ↕, enderezar (±45°) | «Girar y recortar» | `turn`, `flipX`, `flipY`, `straighten` | No |
| Recorte libre o por proporción (como la capa, 1:1, 4:5, 9:16, 16:9, 3:2) | «Recortar…» (ventana con marco arrastrable) | `crop` (fracciones de la foto ya girada) y la caja de la capa toma la proporción del recorte sin crecer | No |
| Fondo detrás de la foto: color, degradado o la misma foto desenfocada | «Fondo» → «Poner detrás de la foto» | `backdrop` | No |
| Sombra bajo la foto o el plato (sigue la silueta si hay transparencia) | «Fondo» → «Sombra» | `shadow` | No |
| Quitar el fondo | «Fondo» → «Quitar el fondo» | **foto nueva** (carpeta «Ediciones») y la capa pasa a usarla | No (navegador) |
| Desenfocar el fondo y dejar el plato nítido | «Fondo» → «Desenfocar el fondo…» | **foto nueva**; la capa pasa a usarla | No (navegador) |
| Cambiar el fondo con IA | «Fondo» → «Cambiar el fondo con IA…» (abre «Editar foto» en su pestaña de IA) | foto nueva | **Sí**, OpenAI |
| Contorno, sombra y fondo del texto | Panel de un texto → «Efectos del texto» | `outline`, `shadow`, `background` | No |
| Sombra de las formas | Panel de una forma | `shadow` | No |
| Figuras y pegatinas: triángulo, estrella, corazón, flecha, destello, globo de texto y línea | Barra «Añadir» → «Figuras…» | capa de forma con `shape` nuevo | No |

### Qué usa IA y qué no

- **Todo es del navegador, gratis y sin clave**, salvo un botón: «Cambiar el
  fondo con IA…». Sale **solo** si el despliegue tiene
  `VITE_AI_PHOTO_EDIT_ENABLED=true`, el servidor tiene un modelo para
  `replace_background` (OpenAI, sección 8) y la foto es de nuestro almacenamiento.
  Sin eso el botón no existe; no se simula nada. Reutiliza el diálogo y el cupo
  de la sección 8 tal cual.
- **Quitar el fondo** pasa por una única función, `photo-edit/cutout/remover.ts`
  (`removeBackground`: foto → foto con alfa). Hoy usa IS-Net (sección 7), cuyo
  resultado el dueño considera flojo; cambiar el motor solo exige tocar ese
  archivo y `engine.ts`, no el panel ni el diálogo «Editar foto».
- La carga de imágenes del lienzo usa ahora `src/lib/corsImage.ts` como la
  exportación (`canvas/imageStore.ts`): arregla «Imagen no disponible» al
  insertar desde el selector, causado por la copia en caché sin CORS.

### Cómo está hecho

- **Documento v5** (`content/document/schema.ts`): campos opcionales por capa.
  Un documento v4 se lee igual (`migrate.ts`, 4 → 5, que además quita lo que
  no debería traer). Una edición que no cambia nada (ajustes a 0, recorte
  entero, enderezado 0) no se guarda (`applyLayerPatch`).
- **Orden de aplicación** de una foto: girar 90° → voltear → enderezar (con la
  ampliación justa para no dejar esquinas) → recortar → luz y color. Todo en una
  sola pasada de lienzo + una de píxeles (`editor/imageEffects/prepare.ts`); la
  luz y el color son el mismo cálculo que «Mejorar» (`photo-edit/pixels.ts`).
  Girar o voltear después de recortar mueve el recorte con la foto
  (`imageEdit.ts`).
- **Mismo resultado en lienzo y exportación:** ambos usan `canvas/draw.ts`
  (dibujo de cada capa), `prepareBitmap` y `stickers.ts` (contornos de las
  figuras). Solo cambia el tamaño de la foto preparada (1280 px en el editor,
  2400 al exportar); con la nitidez, la diferencia es la propia de la
  resolución. Las sombras y desenfoques se escalan con el zoom y con la
  resolución de exportación.
- **Texto:** el contorno es el de Konva (su grosor es lo que se ve por fuera);
  el fondo del texto se dibuja ajustado a las líneas escritas, no a toda la caja.
- **Base de datos:** la tabla de plantillas de marca solo aceptaba documentos
  v3 y v4; la migración `20261211010000_templates_document_v5.sql` (con su
  vuelta atrás) añade la v5. Ningún campo nuevo referencia recursos, así que la
  comprobación de recursos de la marca no cambia. Prueba: `tests/db/edicion-sencilla.test.ts`.

### Límites conocidos

- Luz y color necesitan leer los píxeles: si el almacén no responde a CORS, la
  foto se ve sin esos ajustes y la exportación avisa (como ya hacía).
- El filtro «foto desenfocada» difumina la propia foto; para desenfocar el
  fondo **detrás del plato** hay que usar «Desenfocar el fondo…», que crea una
  foto nueva (necesita el recorte del navegador).
- Las figuras no cambian de forma al estirarlas: se deforman con la caja. La
  línea se dibuja horizontal en el centro de su caja; para inclinarla, gírala.
- No probado a mano en un navegador real en esta rama: solo pruebas de unidad,
  de componentes y de base de datos (el dibujo con Konva y el recorte arrastrando
  no se ejercitan en jsdom).
