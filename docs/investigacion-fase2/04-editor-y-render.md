# 04 · Editor por capas en el navegador y render en el servidor

Fecha de la investigación: 16/11/2026. Solo investigación; nada instalado ni probado. Todo dato lleva su fuente (números entre corchetes, lista al final). «SV» = sin verificar (no hallé fuente oficial o la página no lo decía).

## 1. Resumen ejecutivo

- **Construir (recomendada):** documento JSON propio y versionado + **Konva** (MIT) en el navegador + **el mismo Konva con `skia-canvas` (MIT) en Node** para exportar. Coste de licencias: 0 €. Coste real: unas semanas de ingeniería (guías, grupos, texto, tipografías, móvil).
- **Comprar:** **Polotno SDK** (editor completo, JSON abierto, render propio en Node). Licencia por presupuesto («desde unos cientos hasta 20-30k+» [1]); **hoy exige React 19** [9], y el proyecto está en React 18. Alternativa de más alcance (vídeo incluido): **IMG.LY CE.SDK** (precio solo con presupuesto [2]).
- **Vídeo:** Remotion es gratis hasta 3 personas; un SaaS que renderiza automáticamente entra en «Automators»: 0,01 $/render con mínimo de 100 $/mes [5].
- **Servidor:** el render de imágenes con Konva+skia cabe en una función de Vercel (Node, 2 GB de memoria, 300 s, 250 MB de paquete [11]); **no** en una Edge Function de Supabase (2 s de CPU, 256 MB [10]).

## 2. Editores en el navegador (comparativa)

| Opción | Licencia / precio comercial | Mantenimiento (16/11/2026) | React 18 | Notas clave |
|---|---|---|---|---|
| **Konva + react-konva** | MIT, sin clave [3] | Konva 10.9.1 publicada el 31/10/2026 [6]. 15k estrellas [3] | `react-konva` 19.3.2 pide React ^19.3 [7]. La etiqueta `legacy` apunta a 18.2.16 [7] (rama 18: válida, sin confirmar su mantenimiento) | Lienzo 2D, nodos y grupos nativos, `toJSON`. Hay que construir a mano UI, guías, texto editable, deshacer. Node con `canvas` o `skia-canvas` [3][8] |
| **Fabric.js** | MIT [4] | Última 7.4.0 en npm [7b]; repo con 31,6k estrellas [4]. (La etiqueta «v740» de GitHub es de mayo/2026 [4b]) | Es agnóstico de React (sin wrapper oficial; SV) | Texto editable in situ y JSON integrados. Node con `@fabricjs/node` (Node ≥20, node-canvas + jsdom) [4]. Lo más cercano a un editor «de serie» sin pagar |
| **Polotno SDK** | Comercial, sin clave pública de precio: «desde cientos a 20-30k+», renders propios «ilimitados, uso razonable» [1]. Hay referencias a tramos self-serve para <50 empleados (199 $/mes en un tramo) que NO aparecen en la página actual: SV [12] | Polotno 4.20.1 [9] | **No**: `peerDependencies` react ^19.3.0 [9]. Habría que subir a React 19 o usar una versión antigua (SV) | Editor completo (UI blanca, plantillas, tipografías, grupos, deshacer con transacciones [13]). JSON legible y exportable; `migrateDesign` en `@polotno/schema` [13]. Render Cloud opcional (borra a los 7 días [1]) |
| **IMG.LY CE.SDK** | Suscripción por plataforma y funciones; **sin precios públicos**; sin clave = marca de agua en exportaciones [2] | `@cesdk/cesdk-js` 1.86.2 [14] | `react` >16 opcional [14] | Motor sin interfaz en Node (`@cesdk/node`, `node-native` con Node 22+ y glibc 2.39+ [15]); foto, vídeo y diseño [2]. Formato de escena propio (detalle SV) |
| **tldraw** | «SDK License»: clave obligatoria en producción (sin clave el editor deja de pintar a los 5 s); prueba de 100 días; precio «por valor», sin cifra oficial [16][17] | tldraw 5.6.1 [18] | Sí: react `^18.2.0 \|\| ^19.2.1` [18] | Pizarra infinita, no un editor de piezas gráficas con formatos fijos. Tiene sincronización multijugador [16]. Encaje flojo para este caso |
| **Pintura (PQINA)** | 749 €/año por desarrollador; 169 €/año personal; licencia perpetua para la versión disponible en el periodo [19] | SV | Compatible con React (según su web) [19b] | Es un retocador de foto (recorte, filtros, anotaciones), **no** un editor de capas. Útil solo para recortar fotos antes de colocarlas. Licencia no transferible; OEM aparte [19] |

Capacidades que no pude verificar con fuente oficial para ninguna opción: rendimiento en móvil y accesibilidad (lectores de pantalla). **Regla general (mi criterio, SV):** un editor sobre `<canvas>` no es accesible por sí mismo; hay que ofrecer un panel HTML paralelo de capas con teclado y etiquetas, sea cual sea la opción.

## 3. Formato del documento

**Recomendación: esquema JSON propio** (la IA ya propone «un plan en JSON» que un motor ejecuta; el documento es el mismo plan guardado), con un adaptador por motor de dibujo. Razones: se evita el cierre con un proveedor; el esquema guía a la IA y se valida con Zod/JSON Schema; los formatos de salida (1:1, 4:5, 9:16) son datos del documento, no del editor.

Esquema sugerido (mínimo):
- `schemaVersion` (entero), `id`, `brandId`, `formats[]` (cada uno con `w`, `h`, `safeZones`).
- `layers[]` con `id`, `type` (`image|text|shape|logo|group`), `name`, `locked`, `visible`, `opacity`, `anchor` (reglas por formato: ancla, margen, escala relativa) y `overrides` por formato.
- Medidas relativas (porcentajes) para poder re-componer; texto con `fontFamily` + `fontAssetId` (el archivo de la tipografía versionado en Storage).
- `assets` referenciados por id (nunca imágenes en base64: Polotno avisa de que inflan el JSON [13]).

Versionado y migración: `schemaVersion` + migraciones puras `vN -> vN+1` aplicadas al leer (patrón que ya implica `migrateDesign` de Polotno [13]); guardar siempre el documento original y cada versión como fila inmutable (ver §7).

Esquemas públicos de referencia:
- **Creatomate:** raíz `output_format`, `width`, `height`, `elements[]`; tipos `image, video, audio, text, shape, composition` (grupo con línea de tiempo propia); medidas en px o `%` [20].
- **Bannerbear:** plantilla en su editor y petición con `modifications` por nombre de capa (`text`, `image_url`, color, `hide`); la v5 anida cambios en `modifications.objects` [21].
- **Polotno:** `store.toJSON()` con páginas y elementos (`id`, `type`, `x`, `y`, `width`, `height`…); referencia en polotno.com/docs/schema [13][22].
- **Canva Connect:** no expone capas: se rellenan campos de «plantillas de marca» (texto e imagen) vía autofill. Los documentos hablan de requisito Enterprise, pero la guía nueva menciona Pro/Teams: contradictorio, comprobar [23]. No sirve como modelo de documento propio.

## 4. Render en el servidor (idéntico a lo que se ve)

| Opción | Fidelidad con el editor | Licencia / precio | Dónde corre | Tipografías |
|---|---|---|---|---|
| **Konva en Node + skia-canvas** | Máxima: mismo código de dibujo; ojo, Skia y el navegador difieren en antialiasing y texto | Konva MIT [3]; skia-canvas MIT, v4.0 [8] | Función de Vercel Node (nombra Vercel, Lambda, Cloudflare Containers [8]). Con Next.js marcarlo como `external` [24] | Archivos locales; API de biblioteca de fuentes documentada en skia-canvas.org [8] |
| Konva en Node + node-canvas | Alta | Konva exige elegir backend desde la v10 [24] | Igual | `registerFont`: SV |
| **Fabric + `@fabricjs/node`** | Alta | MIT [4] | Igual | Vía node-canvas [4] |
| **Satori + resvg** | Media: Satori solo admite un subconjunto de CSS (sin `@font-face`, sin `:hover`, sin tablas) [25]; exige reescribir la capa a JSX/HTML | Satori MPL-2.0 [25]; resvg-js MPL-2.0 [26] | Satori corre en navegador, Node y Workers; WASM en base64 [25]; `@resvg/resvg-wasm` existe [26] | TTF/OTF/WOFF/WOFF2; las variables salen en su instancia por defecto [25]; resvg: `fontFiles` / `fontBuffers` [26] |
| **Playwright / Puppeteer** | Máxima si el editor se carga en el navegador sin cabeza | Gratis (licencias de Chromium aparte; SV) | Contenedor; en Vercel Chromium infla el paquete (límite 250 MB, hasta 5 GB en «large functions» beta [11]) | Las del sistema/`@font-face` |
| **Creatomate** | Distinta (motor propio) | 45 $/mes (2.000 créditos), 108 $/mes (10.000), 274 $/mes (50.000); 1 crédito = 1 imagen; sin cobro por exceso (se detiene) [27] | Servicio externo; región UE: SV | Subidas propias (SV) |
| **Bannerbear** | Distinta | 49 $/mes (1.000 créditos API), 149 $/mes, 299 $/mes [28] | Servicio externo | SV |
| **Templated** | Distinta | 39 $/mes (1.000 créditos), 99 $/mes, 229 $/mes; límite de 60 peticiones/min en el plan base [29] | Servicio externo | SV |
| **Placid** | Distinta | Créditos mensuales 500/2.500/25.000/100.000 (precios no extraídos: SV); 1 imagen = 1 crédito, vídeo 1 crédito/s [30] | Servicio externo | SV |
| **Shotstack** | Distinta | Pago por uso 20 ¢/min de render; planes desde 39 $/mes (250 min) [31]; región UE: no figura | Servicio externo | SV |

**Dónde ejecutarlo:**
- **Edge Function de Supabase: descartada para imagen.** 256 MB de memoria, 2 s de CPU por petición, 150 s de reloj (gratis) o 400 s (de pago), paquete de 20 MB (CLI) o 5 MB (servidor) [10]; un binario nativo como skia-canvas no encaja (conclusión mía, SV).
- **Función de Vercel (Node):** 2 GB/1 vCPU por defecto (4 GB en Pro), 300 s por defecto (hasta 800 s en Pro), 250 MB de paquete, 4,5 MB de cuerpo de petición/respuesta (se salta guardando en Storage y devolviendo una URL) [11]. Región por defecto `iad1`; elegirla en la UE para el tratamiento de datos [11].
- **Contenedor propio** (Fly/Cloud Run/etc.): necesario si hay vídeo largo o Chromium; no investigué precios (SV).

## 5. Paso a vídeo

- **Remotion:** React que se renderiza a MP4 con Chrome + ffmpeg. Licencia: gratis para individuos y empresas de hasta 3 personas; si no, **Creators** 25 $/mes por puesto, **Automators** 0,01 $/render (bloques de 1.000 = 10 $, mínimo 100 $/mes) para «editores de vídeo, apps de prompt a vídeo, Player embebido»; **Enterprise** desde 500 $/mes [5]. Un SaaS multiempresa que renderiza por cuenta de clientes cae en Automators o Enterprise (interpretación mía; confirmar con ellos).
- Modos de render: Lambda, Docker, Node/Bun, Vercel Sandbox, Cloudflare/Azure Containers; Cloud Run está en alfa sin desarrollo activo [32].
- **Cómo reutilizar el documento:** una composición de Remotion que lee el mismo JSON y pinta cada capa como componente React (`<Img>`, `<div>`) con animaciones declaradas en `layers[].motion`. Ojo: el render de imagen (skia) y el de vídeo (Chrome) serían **dos motores**, así que las diferencias de texto son posibles. Para igualarlos, usar Chrome/Playwright también para imagen, o aceptar tolerancia.
- **FFmpeg directo:** válido para «foto con zoom + fundido + música» (Ken Burns), sin componer capas animadas; gratis; ejecutar en contenedor. No investigué su licencia concreta según la compilación (SV).
- **Servicios:** Creatomate (vídeo 6,91 créditos por un Short de 30 s en 720p [27]), Templated (13 créditos por 1080p/30 fps/10 s [29]), Shotstack [31], Placid (hasta 1920×1080 [30]).
- **CE.SDK** incluye exportación de vídeo en servidor con su Renderer [15] (límites no verificados).

## 6. Adaptación automática de formatos (1:1 → 4:5 → 9:16)

1. **Reglas de anclaje en el documento** (lo que más rinde): cada capa guarda ancla (centro, borde, esquina), margen y escala relativa por formato; el motor recalcula posiciones respetando zonas seguras de la red social.
2. **Foto de fondo: recorte por punto focal.** `sharp` ofrece `position: attention` (zona de más luminancia, saturación y tonos de piel) y `entropy` en `resize` con `fit: cover` [33]. Mejor aún: que la IA o una detección de sujeto devuelva un punto focal que se guarda en la capa y se usa en cada formato.
3. **Detección de sujeto:** AutoFlip (de MediaPipe) usa detección de objetos y caras para encuadrar vídeo [34]; licencia: SV. `smartcrop.js` no pude comprobarlo (la página dio 403): SV.
4. **Recomponer, no solo recortar:** pasar de 1:1 a 9:16 pide más alto; una foto 1080 p recortada a 9:16 queda en 608×1080 y habría que reescalarla [34], así que conviene exigir foto de origen grande o generar la imagen directamente en 9:16.
5. **Revisión humana:** mostrar los 3 formatos y permitir retocar cada `override`.

## 7. Versiones y edición colaborativa

- Para «versiones» basta con **instantáneas**: cada guardado inserta una fila inmutable en Postgres (`documento_id`, `numero`, `json`, `autor`, `fecha`, `motivo` «IA/persona/exportación») con RLS por empresa; restaurar = copiar una versión como nueva. Deshacer/rehacer en sesión lo da el editor (en Polotno, `history` con transacciones [13]) y no hace falta persistirlo.
- **Edición simultánea** solo si varias personas retocan a la vez: **Yjs** (MIT [35]) es red-agnóstico y exige un proveedor (y-websocket u otro) [36]; **Liveblocks** gratis con marca visible (500 salas activas/mes, 10 conexiones por sala, historial de versiones de 24 h); Pro 30 $/mes (1.000 salas), Team desde 600 $/mes [37]. tldraw trae sincronización multijugador dentro de su licencia [16].
- **Primera versión: no incluir edición simultánea.** Bloqueo optimista (`updated_at`/número de versión) y aviso «otra persona guardó antes». Es una decisión de producto que conviene confirmar.

## 8. Recomendación razonada

**A) Construir (recomendada si hay 4-8 semanas de ingeniería y se quiere control total):**
JSON propio versionado → `renderDocument(doc, formato)` aislado en un paquete con dos adaptadores: Konva en el navegador y Konva+skia-canvas en Node (función de Vercel, región UE, resultado a Storage). Prueba de «idéntico»: capturas de referencia por plantilla y comparación por píxeles en CI. Vídeo más adelante con Remotion (Automators) leyendo el mismo JSON. Coste de licencias de Fase 2: 0 € (más Remotion cuando llegue el vídeo).
*A favor:* sin proveedor, el plan JSON de la IA es el formato nativo, mismo motor en cliente y servidor. *En contra:* guías, selección múltiple, texto en línea y móvil se construyen a mano; la accesibilidad es trabajo propio.

**B) Comprar:** Polotno SDK si se acepta pasar a React 19 [9] (pedir presupuesto por escrito, preguntar por: tenant múltiple, derechos de render propio, escrow del código [1]). Si el vídeo es prioritario en 2027, pedir presupuesto también a IMG.LY [2]. Servicios de plantillas (Creatomate, Templated) solo como plan B del render: sus motores no son idénticos al editor.

**Mi criterio (SV):** construir con Konva si el producto es el editor; comprar Polotno si el objetivo es salir con el producto en pocas semanas y el presupuesto de licencia es asumible.

## 9. Riesgos

- Salto a React 19 para Polotno y `react-konva` actual [7][9]; sobre React 18 queda `react-konva@legacy` (18.2.16) [7].
- Diferencias de texto (kerning, saltos de línea) entre navegador y Skia/Chrome; mitigar con tipografías incrustadas y pruebas visuales.
- Licencia de las fuentes: subirlas a un servidor para renderizar exige que la licencia lo permita (revisar).
- Precios de todo el sector cambian: Polotno tiene datos contradictorios en terceros [12].
- Límites de 4,5 MB de cuerpo y 250 MB de paquete en Vercel [11].
- Remotion: si se supera 3 personas hay licencia obligatoria; el Player embebido cuenta como Automators [5].
- Un proveedor de renders externo recibe contenido de los clientes (RGPD; región UE: SV en todos).

## 10. Preguntas abiertas

1. ¿Plazo y personas disponibles: 4-8 semanas de ingeniería o salir antes?
2. ¿Presupuesto anual de licencias admisible (orden de magnitud)?
3. ¿Quién retoca en móvil, y cuánto? (condiciona la elección y el coste de construir.)
4. ¿Cuántas imágenes por mes y cuántos vídeos? (decide función de Vercel vs contenedor vs servicio.)
5. ¿Se aceptan servicios externos de render con datos de clientes (acuerdo de tratamiento, UE)?
6. ¿Tipografías de marca propias por cliente? (licencias y almacenamiento.)
7. ¿Hace falta edición simultánea en la primera versión? (recomendado: no.)
8. ¿Se puede subir el proyecto a React 19?

## 11. Fuentes

[1] https://polotno.com/pricing · [2] https://img.ly/pricing · [3] https://github.com/konvajs/konva · [4] https://github.com/fabricjs/fabric.js · [4b] https://api.github.com/repos/fabricjs/fabric.js/releases/latest · [5] https://www.remotion.dev/docs/license/pricing · [6] https://api.github.com/repos/konvajs/konva/releases/latest · [7] https://registry.npmjs.org/react-konva (latest 19.3.2; legacy 18.2.16) y https://registry.npmjs.org/react-konva/latest · [7b] https://registry.npmjs.org/fabric · [8] https://github.com/samizdatco/skia-canvas · [9] https://registry.npmjs.org/polotno/latest · [10] https://supabase.com/docs/guides/functions/limits · [11] https://vercel.com/docs/functions/limitations · [12] https://polotno.com/sdk/pricing/self-serve (más resultados de búsqueda de terceros: toolradar.com/tools/polotno/pricing, spotsaas.com) · [13] https://polotno.com/docs/store-overview y https://polotno.com/docs/config · [14] https://registry.npmjs.org/@cesdk/cesdk-js/latest · [15] https://img.ly/docs/cesdk/node/concepts/headless-mode-24ab98/ (vía búsqueda) · [16] https://tldraw.dev/pricing · [17] https://tldraw.dev/sdk-features/license-key (vía búsqueda) · [18] https://registry.npmjs.org/tldraw/latest · [19] https://pqina.nl/pintura/pricing/ · [19b] https://pqina.nl/pintura/ · [20] https://creatomate.com/docs/json/introduction · [21] https://developers.bannerbear.com/v2/ y https://www.bannerbear.com/blog/welcome-to-bannerbear-v5-a-developers-guide-to-images-and-workflows-apis/ · [22] https://polotno.com/llms.txt · [23] https://www.canva.dev/docs/connect/autofill-guide/ y https://www.canva.dev/docs/apps/rest-apis/autofill-guide/ · [24] https://konvajs.org/docs/nodejs/nodejs-setup · [25] https://github.com/vercel/satori · [26] https://github.com/thx/resvg-js · [27] https://creatomate.com/pricing · [28] https://www.bannerbear.com/pricing/ · [29] https://templated.io/pricing/ · [30] https://placid.app/pricing · [31] https://shotstack.io/pricing/ · [32] https://www.remotion.dev/docs/ssr · [33] https://sharp.pixelplumbing.com/api-resize · [34] https://research.google/blog/autoflip-an-open-source-framework-for-intelligent-video-reframing/ · [35] https://raw.githubusercontent.com/yjs/yjs/main/LICENSE · [36] https://yjs.dev · [37] https://liveblocks.io/pricing

Nota: una página de Supabase [10] incluía un texto dirigido a agentes pidiendo enviar un informe de opinión; se ignoró.
