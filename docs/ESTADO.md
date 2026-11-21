# Estado del proyecto

Última actualización: 21/11/2026 (ediciones sencillas del editor en la rama `f13/edicion-sencilla`; antes, editor de reels en `f11/editor-reels`). Rama de trabajo: `claude/focused-noether-hk502p`
(PR abierto a `staging`; `main` y `staging` existen desde el 16/11/2026).

**En staging** (desplegado y publicado en https://rrss-omega.vercel.app): las Fases 1
a 6, Integraciones, copiloto por voz y fotos de Drive (`f4/integracion`).

**Unido en `f6/integracion`, pendiente de subir y de desplegar** (todo probado en
local; ver «Para llevar a staging»): almacenamiento en Cloudflare R2, arreglos del
copiloto, OpenAI como proveedor de texto, pulido (privacidad, desenfoque en reels,
huérfanos en R2, plan Prueba), alta de la biblioteca desde Drive, edición de fotos y
«Publicar ahora».

Resumen: las Fases 1 a 6 están construidas y probadas de extremo a extremo en local con
proveedores **simulados** (IA, Meta, Stripe). Lo que falta para usarlas de verdad son
cuentas y decisiones del dueño, no desarrollo: aplicación de Meta, proveedor de IA,
Stripe, correo y revisión legal. Staging (Supabase gratuito, UE) tiene 35 migraciones
y las funciones desplegadas sin proveedores.

## Pruebas

| Tanda              | Resultado                                                                                                                                                                                                                                                                                  | Qué cubre                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`         | 987 pasan (21/11/2026, rama `f13/edicion-sencilla`; incluye las ediciones sencillas del editor) | Lógica (unitarias) e interfaz contra un Supabase simulado (componentes) |
| `npm run test:db`  | 909 pasan, 2 omitidas (21/11/2026, rama `f13/edicion-sencilla`; incluye el documento v5) | Esquema, aislamiento entre organizaciones, permisos, planes, cupos, cola, publicación (con «Publicar ahora»), campañas, analítica, RGPD, integraciones, copiloto, biblioteca con Drive, R2, edición de fotos y huérfanos de R2, contra las migraciones reales (PGlite). Las 2 omitidas son de simultaneidad con dos conexiones (pasaron contra Postgres 16 el 16/11/2026) |
| `worker/`          | 90 pasan (21/11/2026, rama `f11/editor-reels`) | Trabajador de medios con FFmpeg real: reels v1 y v2 del editor (recortes, textos con estilo, subtítulos quemados, mezcla de sonido, transiciones mixtas; con desenfoque), recortes, extracción de texto, informe PDF, imágenes de Drive y R2 |
| `agency/`          | 54 pasan (21/11/2026; incluye entregas con páginas) | Herramienta de la agencia contra un Supabase simulado |
| `npm run test:e2e` | 88 de 88 (20/11/2026, rama `f7/importar-publicaciones`): tanda completa desde cero con `supabase db reset`; 11 y 15 fallaron la primera vez por no tener instaladas las dependencias del trabajador en el worktree y pasaron al instalarlas; la nueva `24-importar-publicaciones` (3 pruebas) pasó a la primera | Navegador (Playwright) contra un Supabase local (`supabase db reset` antes) con las funciones servidas en local, el trabajador real y proveedores simulados (IA, Graph API, Drive, dictado, MinIO como R2): Fases 1 a 6, integraciones, copiloto, Drive, R2, edición de fotos (22) y «Publicar ahora» (23), en 23 archivos |
| CI de GitHub       | `comprobar`, `trabajador`, `agencia` y `e2e`                                                                                                                                                                                                                                               | El trabajo `e2e` levanta su propio Supabase y ejecuta la prueba completa; no bloquea el PR hasta verse estable                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Hecho

### Fase 1 · Núcleo multiempresa

Sesión con confirmación de correo y recuperación de contraseña, organizaciones
(empresa o agencia), asistente de alta de marca, perfil de marca versionado con
exportar e importar, biblioteca, equipo e invitaciones con cinco roles,
aislamiento entre organizaciones, ajustes, actividad y panel de plataforma.

### Fase 2 · Estudio creativo

- **Contenidos y editor por capas** (documento propio v2 + Konva): selección múltiple, alinear, repartir, agrupar, texto sobre el lienzo, guías respecto a otras capas, zonas seguras orientativas por red, vista previa por red, renombrar y cambiar de red; versiones, historial, estados y aprobación.
- **Exportar imagen** (PNG/JPEG) a la biblioteca con procedencia inmutable.
- **Verificador de marca** sin IA (con zonas seguras) y con IA; perfil ampliado (hashtags, llamadas a la acción, emojis).
- **IA de texto e imagen** detrás de adaptadores, con cupo y coste por organización; vídeo con IA apagado por criterio de datos.
- **Reels con plantillas** y **recortes** desde la biblioteca (trabajador con FFmpeg), con cancelar y aviso de peso.
- **Fuentes de marca**: extracción de texto de PDF, Word y webs (con protección SSRF y `robots.txt`) para la propuesta de perfil; **tipografías de marca** en editor, exportación y reels.
- **Modo agencia**: encargos con avisos, entrega desde la herramienta `agency/` o desde la interfaz; el servidor impide la IA de texto en marcas en modo agencia.

### Fase 3 · Calendario y publicación

Cuentas de Instagram por OAuth (tokens cifrados fuera de `public`), calendario
(mes, semana, día y por red) con arrastrar y soltar y aprobación por lotes,
comentarios en la pieza, y publicador `social-publish` (pg_cron cada minuto)
con cerrojo, idempotencia y reintentos: imagen, carrusel y reel. La base de
datos impide publicar lo no aprobado, incluso con la clave de servicio, y que el
plan no incluya publicación. Detalle en `docs/publicacion.md`.

**Publicar ahora** (rama `f7/publicar-ahora`, en `f6/integracion`): botón en el editor de
una pieza aprobada, opción «Ahora» al programar y botón en la ficha del
calendario; confirma en un paso, exporta la imagen si falta (en el editor), pone
la publicación con la hora actual por las mismas garantías, procesa la cola al
momento (`social-publish/now`, con la sesión de la persona) y enseña el progreso
y el enlace. Migración `20261130010000` (dos RPC, sin tablas) con su vuelta
atrás; hay que desplegar la migración y `social-publish`. Probado en base de
datos, componentes y e2e (`23-publicar-ahora.spec.ts`).

**Carruseles de varias páginas** (rama `f8/carrusel-paginas`): un carrusel es una
pieza con varias páginas en UNA versión. El documento pasa a la **versión 4**
(`pages`, de 1 a 10, mismo lienzo y mismo texto; un documento v3 se lee como uno
de una página). Editor con tira de miniaturas (añadir, duplicar, borrar,
reordenar arrastrando o con botones), deshacer que vuelve a la página de cada
paso, copiloto sobre la página activa y vista previa con flechas; «Exportar el
carrusel» saca un JPEG por página con `page`/`page_count` en la procedencia;
programar y «Publicar ahora» usan las exportaciones de cada página en orden; la
base de datos lo exige (migración `20261203010000`, con vuelta atrás) y el
publicador ya enviaba los hijos en ese orden. Verificador, marca de IA, campañas,
plantillas y `agency/` leen las páginas. Detalle y cómo convertir un carrusel
hecho con varias versiones (la demo de EnerGym) en `docs/publicacion.md`
(«Carruseles»; script `scripts/unir-versiones-en-carrusel.sql`, probado en PGlite,
**sin ejecutar** en staging).
- Pruebas: unitarias (esquema, migración, páginas, verificador, exportación),
  componentes (`editorPaginas.test.tsx`, programar y «Publicar ahora» un
  carrusel), base de datos (regla con varias exportaciones en orden, publicador
  con la Graph API simulada, IA y plantillas con páginas) y `agency/`. La e2e
  `27-carrusel-paginas.spec.ts` está **escrita y sin ejecutar** (el 21/11/2026
  Docker no estaba arrancado y no había Supabase local).
- Para llevarla a staging: migración `20261203010000_carousel_pages.sql`; ninguna
  función que desplegar (el cambio de la Graph API simulada solo cuenta en local).
  Ojo: un carrusel ya programado con exportaciones sin número de página queda
  detenido («invalid_media») hasta exportar sus páginas.

### Editor de reels (rama `f11/editor-reels`, 21/11/2026)

Una pieza de formato reel se monta en un **editor de reels** (el diseño por capas
antiguo sigue en `?editor=imagen`): línea de tiempo con pistas de vídeo y fotos,
textos, subtítulos y música; arrastrar para ordenar, recortar principio y final,
duración de las fotos, transición por elemento, cabezal, zoom y deshacer/rehacer.
Las tres plantillas son el punto de partida. **Vista previa al momento** en el
navegador (clips, fotos, textos, subtítulos y sonido sincronizados, con aviso de lo
que se verá distinto). Textos con la tipografía (.ttf/.otf) y los colores de la marca.
**Subtítulos automáticos** con OpenAI (`gpt-transcribe`, clave de Integraciones; un
trozo de voz = un subtítulo) con cupo y coste por organización, interruptor
`VITE_REEL_SUBTITLES_ENABLED` y corrección a mano. **Música** con volumen, entrada y
salida suaves y confirmación de licencia (queda en la procedencia). Se guarda como
**versión de la pieza**, se aprueba y se monta la versión guardada; programar y
«Publicar ahora» proponen su montaje.
- Plan del reel **v2** (`worker/src/reel/schema.ts`, `src/features/reels/editor/project.ts`); el v1 se migra al leerlo.
- Migración `20261207010000_reel_editor` (sin tablas: carga v2, enlace con la pieza, tipografías y licencia comprobadas, procedencia), con vuelta atrás. Función nueva `ai-transcribe`.
- Precio de los subtítulos: 0,0045 $/min (OpenAI, 21/11/2026) + 10 % de cota por la UE = 82,5 micros/s.
- Pruebas: unitarias, componentes, trabajador con FFmpeg real, base de datos (con aislamiento). La e2e `29-editor-reels.spec.ts` está **escrita y sin ejecutar** (Docker parado). Sin probar contra OpenAI real ni la vista previa en un navegador real.
- Para llevarlo a staging: migración `20261207010000`, desplegar `ai-transcribe` y redesplegar `platform-integrations`; `VITE_REEL_SUBTITLES_ENABLED` cuando haya clave de OpenAI. Detalle en `docs/editor-reels.md`.

### Fase 4 · Campañas (primera parte)

«Prepara la semana que viene» → plan explicado (observado / datos / hipótesis) →
borradores, nunca aprobados ni publicados; protegido contra instrucciones
maliciosas en fuentes y perfil; en modo agencia el plan lo entrega la agencia.

Presentación (rama `f10/campanas-diseno`, 21/11/2026): la lista son tarjetas
con fechas, estado, número de piezas y miniaturas; el detalle abre con título,
estado, fechas, red, objetivo en una línea y la acción según el estado, y
enseña la semana como tira de días con la miniatura de cada pieza (exportación
de la versión vigente, esbozo del documento o foto sugerida por el plan). Al
pulsar una pieza se abre su ficha (texto, motivo, «Abrir en el editor»).
«Por qué este plan» (observado / datos / hipótesis, siempre por separado) y
«Lo que se pidió» van plegados. Sin cambios de datos ni de lógica.

### Fase 5 · Analítica

Capturas horarias de métricas de Instagram, panel que separa dato de hipótesis y
dice lo que no se puede medir, interpretación con IA opcional e informe mensual
en PDF generado sin intervención. Detalle en `docs/analitica.md`.

### Fase 6 · Planes, facturación y RGPD

- **Planes como datos** (Prueba, Básico, Profesional, Agencia, Enterprise, Heredado) con límites que impone la base de datos, panel de **margen por cliente**, «Configuración → Plan». Stripe (Checkout, portal y webhook) escrito y probado con Stripe simulado. Detalle en `docs/facturacion.md`.
- **RGPD**: páginas legales como plantillas, consentimiento en el registro, descargar mis datos, exportar la organización, borrar cuenta y organización, registro de tratamientos (`docs/rgpd.md`) y etiqueta «Generado con IA» por pieza.

### Plataforma → Integraciones (rama `f4/integraciones`)

Las claves de los servicios se meten desde `/plataforma/integraciones` (solo
superadministradores): Meta (y «Generar clave» de cifrado de los tokens),
ComfyUI propio, IA de texto (proveedor y modelo por tarea, también el del
copiloto), IA de imagen, Stripe y Google Drive.

- Los secretos van a Supabase Vault (migración `20261120010000`); en la tabla
  queda su identificador y una pista. El navegador nunca los recibe; cambios y
  pruebas quedan en la actividad, sin valores.
- Las funciones leen primero lo guardado y, si no está, las variables de entorno
  (`_shared/integrations/settings.ts`, caché de 30 s, sin redesplegar). Lo
  hacen todas las que usan proveedores, incluidas `ai-generate` (también la
  tarea del copiloto) y `drive-media`. Una clave de cifrado con tokens guardados
  no se puede quitar.
- «Probar conexión» con una llamada gratuita por servicio. Ideogram, el secreto
  del webhook de Stripe y el cliente OAuth de Google no se pueden comprobar
  gratis: se dice así (se comprueban con la primera imagen, el primer aviso o
  al conectar).
- Instagram también se conecta pegando un token de página de larga duración
  (Marca → Datos → Cuentas conectadas): se valida con la Graph API y la cuenta
  queda «Con token».
- Interruptores: IA, copiloto, publicación, pago y Drive salen si la variable
  `VITE_*` del despliegue lo permite **y** el servidor dice que la integración
  está configurada (`platform-integrations`, solo booleanos).

### Copiloto por voz del editor (rama `f4/copiloto-voz`)

Botón «Dictar» en el editor: cada frase dictada (Web Speech API, es-ES) se
convierte con la IA de texto (tarea `editor.copilot`, esquema estricto y
saneado) en operaciones de capas (foto de fondo difuminada, logotipo, textos
literales con tipografías y colores del perfil) que se aplican al momento y se
deshacen con un solo Ctrl+Z por orden. El documento pasa a la **versión 3**
(desenfoque de imágenes, también en la exportación y en los reels del
trabajador; migración `20261121010000_reel_media_blur.sql`). Sale con
`VITE_AI_VOICE_COPILOT_ENABLED` + `VITE_AI_TEXT_ENABLED` y la IA de texto
configurada en el servidor. Probado con el proveedor simulado y una Web Speech
API simulada; **sin probar** con un proveedor real ni con el dictado real.
Arreglos de la evaluación sin API (rama `f5/copiloto-arreglos`, en
`f5/integracion`): color de los textos según el uso del color en el perfil y
legible sobre lo que hay debajo (`copilot/legibility.ts`), órdenes relativas
(«sube», «más difuminada»: `move_layer` con `dx`/`dy`) y ambiguas (se preguntan),
órdenes de terceros y logotipo que no pisa textos; cambia la tarea
`editor.copilot` de `ai-generate`. Detalle en `docs/copiloto-voz.md`.

### Almacenamiento en Cloudflare R2 (rama `f5/almacenamiento-r2`, en `f6/integracion`)

Valoración: **sí, con condiciones** (cubo en la UE, DPA de Cloudflare, token solo
para ese cubo, Supabase de respaldo). Con ≈ 3,2 GB a llevar, R2 cuesta 0 $ (10 GB
gratis, salida gratis) frente a no caber en Supabase Free (1 GB, 5 GB de salida) o
25 $/mes en Pro. Cada recurso guarda su almacén (`media_assets.storage_backend`,
migración `20261124010000`, que fija el servidor); la Edge Function `media-storage`
firma lecturas (1 h, tras la RLS), subidas (tipo y tamaño firmados, tras comprobar
que se edita la marca) y borrados. Credenciales en Plataforma → Integraciones →
Cloudflare R2 (Vault) con «Probar conexión» (HeadBucket); sin R2 configurado todo
sigue en Supabase. Lo usan biblioteca, editor, exportación, informes, exportación
RGPD, trabajador (sin credenciales de R2), imágenes con IA, publicación en Instagram
y borrado de organizaciones. Script reanudable `scripts/migrar-a-r2.ts` (en seco por
defecto). No necesita variable `VITE_`: la interfaz pregunta al servidor. Probado
con un S3 local (MinIO); **sin probar contra R2 real** y **sin desplegar**. Pasos
del dueño en `docs/almacenamiento-r2.md` §5.

Alta en la biblioteca de lo copiado desde Drive (rama `f6/alta-biblioteca`):
`scripts/alta-biblioteca.ts` da de alta cada objeto en la marca de su fila del
inventario (mapeo «marca → brand_id» en un JSON de quien lo ejecuta), con carpeta,
etiquetas, nombre legible, dimensiones y procedencia de Drive, en R2; idempotente,
completa huérfanos y tiene `--comprobar`. La copia pasa a
`<org>/<marca>/import/google-drive/` (bajo `…/drive/` la biblioteca no lo admite).
`scripts/crear-marca-agencia.sql` crea una marca en modo agencia (para Touza en
Oficiosos). Recuento en seco: Casa Tomás 239 fotos, Touza 241 fotos y 46 vídeos
(`docs/almacenamiento-r2.md` §4.2). Probado con PGlite; **sin ejecutar** en staging.

### Biblioteca con Google Drive (rama `f4/biblioteca-drive`)

La organización conecta su Google Drive (OAuth, solo lectura, token de refresco
cifrado como los de Meta) y sus marcas añaden a la biblioteca fotos de Drive **sin
copiarlas a Storage**: el recurso guarda el id del archivo y la imagen la sirve la
función `drive-media` con direcciones firmadas, tras comprobar por RLS que quien la
pide ve la marca. Editor, exportación y trabajador de medios la leen por ahí. No
ocupa plan. Migración `20261122010000`; el cliente de Google se configura en
Plataforma → Integraciones → Google Drive (migración `20261123010000`). Sale con
`VITE_DRIVE_LIBRARY_ENABLED` y Drive configurado en el servidor; «Desde Google
Drive», además, con una conexión activa. Probado contra Drive simulado (base de
datos, función y e2e); las fotos HEIC del iPhone no se pueden usar todavía.
Detalle en `docs/biblioteca-drive.md`.

### Edición de fotos bajo demanda (rama `f6/edicion-fotos`, en `f6/integracion`)
«Editar foto» desde la ficha de la biblioteca y desde una capa de imagen del
editor (la capa pasa a usar la editada; Ctrl+Z la devuelve). **El original no se
toca nunca**: cada resultado es un recurso nuevo en «Ediciones» con su
procedencia (`photo_edit` del navegador, `ai_edit` del servidor, que solo puede
escribir él; el original tiene que ser de la misma marca).
- **Sin IA, en el navegador:** mejorar (automático o a mano: luz, contraste,
  color, temperatura, nitidez), recortes 1:1, 4:5 y 9:16 con encuadre
  inteligente (heurística de detalle y color, no reconoce objetos) y poner un
  fondo liso, de color de la marca o de la biblioteca a una foto con transparencia.
- **Con IA, por `ai-media`** (`photo.options`, `photo.estimate`, `photo.edit`):
  quitar el fondo y ampliar ×2/×4, con coste máximo antes, cupo y coste por
  organización (`ai_generations`, propósito `photo.*`). Salen solo con
  `VITE_AI_PHOTO_EDIT_ENABLED=true` y un modelo en el servidor. ComfyUI propio
  como opción principal: ampliar con nodos del núcleo (Real-ESRGAN) y quitar el
  fondo con el nodo BiRefNet de ComfyUI-RMBG; filas sembradas **inactivas** y
  sin precio verificado. Migración `20261128010000` (con vuelta atrás), sin
  tablas nuevas.
- **Quitar el fondo en el navegador, gratis** (rama `f7/recorte-navegador`): IS-Net
  (float16, 84 MiB, MIT/Apache-2.0) en un Web Worker con `onnxruntime-web`,
  descargado en ejecución desde Hugging Face (o desde `VITE_CUTOUT_MODEL_URL`) y
  guardado en Cache Storage; sin proveedor ni coste. Encima, fondo liso, de color
  de la marca o de la biblioteca, con sombra suave opcional; resultado `photo_edit`
  con sus pasos. Sin COOP/COEP (romperían las fotos de otros orígenes). Detalle en
  `docs/edicion-fotos.md` §7. Probado: unitarias y componentes; e2e escrita y sin
  ejecutar; **sin probar el modelo real en un navegador**.
- Quitar el fondo en el trabajador sin GPU (BiRefNet o IS-Net con
  `onnxruntime-node`): valorado y documentado como alternativa, **sin descargar
  pesos** (falta el «sí»).
- Pruebas: unitarias, componentes, base de datos y e2e `22-edicion-fotos.spec.ts` en verde. Sin probar contra un
  ComfyUI real ni el dibujo real en un navegador.
- Para llevarla a staging: migración `20261128010000_photo_editing.sql`;
  redesplegar `ai-media`, `ai-media-poll` y `ai-media-webhook` (código común de
  medios); variable nueva `VITE_AI_PHOTO_EDIT_ENABLED` (apagada hasta tener
  modelo) y, si el ComfyUI no está en la UE, `AI_MEDIA_REMOVE_BACKGROUND_MODEL` /
  `AI_MEDIA_UPSCALE_MODEL`.

### Importar publicaciones de la cuenta y plantillas de diseño (rama `f7/importar-publicaciones`)

Botón «Importar publicaciones» en Marca → Datos de la marca → Cuentas conectadas:
lee el histórico de Instagram (`/media`, con paginación, `children`, límites de la
API y reanudación) con la cuenta conectada, sin que el token salga del servidor, lo
guarda en `social_imported_media` y, si se pide, copia las imágenes a la biblioteca
(carpeta «Instagram / Publicadas», con procedencia y en el almacén activo). Se puede
detener y reanudar sin perder ni duplicar nada. En modo agencia, `agency/` saca las
plantillas (`importadas`, `comprobar-plantillas`, `entregar-plantillas`) y se guardan
como plantillas de la marca (`brand_design_templates`: documento v3 + análisis con
ejemplos). Detalle, decisiones y lo no probado en `docs/importar-publicaciones.md`.
- Pruebas: base de datos (`importar-publicaciones.test.ts` y casos en `aislamiento.test.ts`), `agency/` (`plantillas.test.ts`) y e2e `24-importar-publicaciones.spec.ts`.
- Para llevarla a staging: migración `20261201010000_social_import.sql` y desplegar la función nueva `social-import`.
- Pendiente: interfaz para usar las plantillas (crear una pieza desde una), exportación RGPD de lo importado, probar contra Meta y R2 reales.

### Editar fotos con OpenAI: cambiar el fondo con IA (rama `f7/openai-imagen`)

OpenAI (GPT Image) como proveedor de imagen de `ai-media` con la misma
`OPENAI_API_KEY` de Integraciones: generar, **cambiar el fondo** (texto libre y
sugerencias; con máscara del plato si la hay), **mejorar luz y color** y quitar
el fondo (PNG transparente). Pestaña «Fondo con IA» en «Editar foto» (biblioteca
y editor); resultado = recurso nuevo con procedencia `ai_edit` y el encargo. «Probar
conexión» comprueba también que la clave vea un modelo `gpt-image…`. Detalle,
fuentes, precio y límites en `docs/ia-medios.md` §13 y `docs/edicion-fotos.md` §7.
- Precio: OpenAI cobra por tokens; el registro lleva una **cota por megapíxel** (70.000 micros de salida, 14.000 de entrada). Los modelos nacen inactivos y sin precio verificado: hay que activarlos en Plataforma.
- Fuera de la UE: `AI_MEDIA_ALLOW_NON_EU=true` (o proyecto europeo con `OPENAI_BASE_URL=https://eu.api.openai.com`).
- Interfaz para el integrador: `PhotoEditDialog` acepta `getSubjectMask` (PNG con las medidas de la foto, plato opaco). Nadie la pasa todavía: sin ella se avisa de que la IA puede retocar el plato. La máscara de OpenAI es orientativa: no garantiza el plato intacto.
- Pruebas: `tests/db/ia-openai-imagen.test.ts`, casos nuevos en `edicion-fotos.test.ts` y `editarFoto.test.tsx`; e2e `26-cambiar-fondo-ia.spec.ts` escrita **sin ejecutar** (el Supabase local lo usaba otro proyecto).
- Para llevarla a staging: migración `20261202010000_openai_image.sql` (vuelta atrás en `supabase/rollbacks/`) y redesplegar `ai-media`, `ai-media-poll`, `ai-media-webhook` y `platform-integrations` (código compartido). Sin probar contra OpenAI real.

### Valoración de Cloudflare Workers AI (rama `f8/workers-ai`, 20/11/2026)

Solo documentación (`docs/ia-medios.md` §14), sin código: Workers AI cubre generar
imagen (FLUX.2 klein 9B ≈ 0,015 USD el primer megapíxel) y texto, pero no quitar el
fondo, ampliar ni editar fotos de platos (entradas menores de 512×512, sin máscara,
inpainting obsoleto desde el 20/11/2026) ni garantiza la UE. No sustituye al Colab.

### Base robusta: despliegues, carga inicial y móvil (rama `f11/base-robusta`, 21/11/2026)

Respuesta a los problemas 1, 2 y 4 y al cambio transversal 5 de la auditoría de diseño
(`energym-demo-datos/capturas/auditoria/INFORME.md`). Implementado y probado en local
(componentes); sin desplegar.

- **Pantalla en negro tras un despliegue.** Todas las pantallas se cargan con
  `lazyRoute` (`src/lib/lazyRoute.ts`): si el trozo de código ya no existe, recarga la
  página una vez (marca con la hora en `sessionStorage`, como mucho una vez cada 30 s) y,
  si vuelve a fallar, el límite de errores enseña «Hay una versión nueva de la
  aplicación · Recargar». También se atiende `vite:preloadError`. Límite de errores
  (`src/layout/ErrorBoundary.tsx`) en toda la app y otro alrededor de cada sección: el
  menú se queda y sale «Esta sección no se ha podido mostrar · Reintentar».
- **Carga inicial.** La pantalla de la dirección de entrada se descarga a la vez que la
  sesión (antes esperaba a organizaciones y marcas); las 4 secciones principales se
  precargan cuando el navegador está libre. «/» con una visita anterior va directo a la
  última marca (organizaciones y marcas en paralelo: una ida y vuelta menos). Las
  integraciones se piden a la vez que la organización. Siluetas grises del armazón y de
  la sección en lugar de «Cargando…» a pantalla completa. Primer paquete: 236 → 203 kB
  comprimido (lucide-react y zod ya no van en los trozos fijos; todas las pantallas,
  también acceso y Configuración, se cargan al visitarlas).
- **Móvil.** Barra inferior con Inicio, Contenidos, Calendario, Biblioteca y «Más» (hoja
  con el resto, con la insignia de Encargos); etiquetas enteras; la pestaña activa lleva
  color y una raya, y «Más» queda marcada si la sección está dentro.
- **Sección activa.** En el lateral, la activa (solo por ruta, `aria-current`) lleva
  fondo, negrita y una raya, para no confundirla con el fondo de «pasar por encima».
  Configuración mantiene la última marca de la organización en el menú y en el selector.
- **Medidas.** Publicada (antes), entrando en frío por «/» con renovación del token: JS
  listo a 0,80 s, primera petición a 1,07 s, trozo de la pantalla pedido a 1,34 s (tras
  organizaciones y marcas) y contenido completo a 2,19 s; en caliente, 0,15 s y 0,54 s.
  En local (compilado contra staging, «/», antes → después): trozo de la pantalla 567 →
  141–401 ms, marcas 380 → 135–280 ms, peticiones de la sección 590 → 351–465 ms; total
  450–750 → 520–660 ms (con la máquina cargada el total no es concluyente). Olas de
  peticiones en cascada: 5 → 4. En el navegador integrado se ven parones de 4–8 s en los
  que la pestaña no pinta nada aunque el JS ya ha llegado (primer pintado a 8,5 s con el
  JS descargado a los 0,04 s): son de la pestaña, no de la app; el cliente de Supabase
  2.119 ya no usa el cerrojo entre pestañas que señalaba la auditoría.
### Acciones claras y avisos que se resuelven (rama `f11/acciones-claras`, 21/11/2026)

Problemas 6, 7 y 9 y cambios transversales 1 y 2 de la auditoría de UX
(`energym-demo-datos/capturas/auditoria/INFORME.md`); capturas del antes y el
después en `energym-demo-datos/capturas/tanda2/f13-*`.

- **Cabecera común** (`src/components/ui/PageHeader.tsx` + `MoreMenu.tsx`): título, una
  línea de contexto, **una** acción principal y el resto en «⋯» (Radix, por teclado).
  Editor: la principal sale del estado (`editorPrimaryAction` en `content/status.ts`):
  Enviar a revisión → Aprobar → Publicar ahora (o Programar) → Recuperar si está
  archivada; «Guardar versión» visible y discreto; Archivar, Devolver a idea/borrador,
  Retirar la aprobación, Historial, Exportar, Nombre y red y Plantilla, en «⋯» por
  grupos. Contenidos (las archivadas, en «⋯»), Biblioteca (Drive y reels, en «⋯») y
  Calendario («Aprobar varias», en «⋯»).
- **Avisos que se resuelven** (`ActionNotice`): una frase, el botón que lleva a
  arreglarlo y «¿Por qué?» plegado. Calendario: un aviso por motivo de «Detenida»
  (`social/holdAdvice.ts`) con «Conectar cuenta», «Usar @cuenta» (vuelve a guardar
  con la cuenta conectada), «Usar la versión aprobada» o «Exportar» (abre el editor
  con `?exportar=1`); la ficha, igual. Estados vacíos con botón en Contenidos,
  Calendario, Biblioteca, Encargos y Analítica (sin cuenta: «Conectar Instagram»,
  sin periodo ni informes).
- **Conectar Instagram:** con OAuth disponible, «Conectar con Meta» es el principal y
  el token pasa a «Opciones avanzadas»; sin él, una frase lo explica («La conexión
  con Meta aún no está activada en la plataforma») y a quien administra la
  plataforma le lleva a Integraciones.
- **Por qué no salía el botón de Meta en staging:** es **configuración**. El botón
  necesita App ID, App Secret, claves de cifrado, la dirección de retorno (se deduce
  de `SUPABASE_URL`) y `SOCIAL_APP_URL`; en staging falta **`SOCIAL_APP_URL`**
  (`META_LOGIN_CONFIG_ID` es opcional). «Probar conexión» daba OK porque no lo
  comprobaba: ahora lo comprueba (`integrations/probes.ts`, hay que redesplegar
  `platform-integrations`) y «Qué ve la gente» enseña la fila del botón de Meta.
- Pruebas: `components/…` en `contenidos.test.tsx` (cabecera del editor, teclado),
  `social/avisosResolubles.test.tsx`, `status.test.ts`, `holdAdvice.test.ts`, caso
  nuevo en `tests/db/integraciones.test.ts`; e2e 09, 11, 13, 20, 21 y 27 abren «⋯»
  con `accionDelMenu` (`tests/e2e/apoyo.ts`), **sin ejecutar** la tanda e2e.

### Ediciones sencillas del editor (rama `f13/edicion-sencilla`, 21/11/2026)

Detalle y límites en `docs/edicion-fotos.md`, sección 10.

- **Implementado y probado (unidad, componentes y base de datos):** ajustes de
  foto (brillo, contraste, saturación, temperatura, nitidez) y 7 filtros
  rápidos; girar, voltear, enderezar y recortar (libre o por proporción);
  fondo detrás de la foto (color, degradado, foto desenfocada) y sombra bajo el
  plato; quitar el fondo y desenfocar el fondo del plato (foto nueva, en el
  navegador); contorno, sombra y fondo del texto; sombra de las formas; 7
  figuras y pegatinas nuevas. Todo se guarda en la capa (documento **v5**), se
  deshace con Ctrl+Z, es por página en carruseles y el lienzo y la exportación
  lo dibujan con el mismo código.
- **Migración** `20261211010000_templates_document_v5.sql` (con vuelta atrás y
  prueba en `tests/db/edicion-sencilla.test.ts`): la tabla de plantillas acepta
  la v5. **No aplicada en staging ni en producción.**
- **IA:** solo «Cambiar el fondo con IA…» (OpenAI, ya existente, tras su
  interruptor); sin proveedor, el botón no sale. El resto es del navegador.
- **Quitar el fondo** queda detrás de `photo-edit/cutout/remover.ts` para
  cambiar de motor (otro agente compara alternativas a IS-Net).
- **Arreglo incluido:** el lienzo carga las imágenes como la exportación
  (`canvas/imageStore.ts`), lo que evita «Imagen no disponible» al insertar
  desde el selector; barra «Añadir» con desplazamiento en móvil; posición y
  tamaño enteros al soltar.
- **Sin probar:** a mano en un navegador (dibujo con Konva, recorte arrastrando
  el marco, descarga del modelo de recorte) ni en e2e de Playwright.
- **Pendiente:** prueba e2e del editor con las ediciones; decidir el motor de
  recorte definitivo.

## Sin probar contra el servicio real

| Servicio | Estado | Detalle |
|---|---|---|
| IA de texto (Claude por Vertex UE, Bedrock UE, Mistral, Anthropic directo) | Adaptadores escritos, sin claves | `docs/ia-texto.md` |
| IA de imagen (Vertex UE, FLUX.2, Ideogram, ComfyUI propio) y vídeo (Higgsfield, fal.ai) | Adaptadores escritos, sin claves; vídeo apagado | `docs/ia-medios.md` |
| Meta (OAuth, publicación, métricas) | Adaptador escrito; sin aplicación de Meta | `docs/publicacion.md`, `docs/analitica.md` |
| Stripe | Funciones escritas; sin cuenta | `docs/facturacion.md` |
| Google Drive (OAuth, listar, servir imágenes) | Adaptador escrito; sin cliente OAuth de Google | `docs/biblioteca-drive.md` |
| Dictado del navegador (Web Speech API de Chrome) | Probado con una simulada | `docs/copiloto-voz.md` |
| Cloudflare R2 (firmas, subidas, «Probar conexión», migración) | Probado con MinIO en local; sin cuenta de Cloudflare | `docs/almacenamiento-r2.md` |
| Quitar el fondo en el navegador (IS-Net, onnxruntime-web) | Lógica y flujo probados con el worker simulado; modelo real solo comprobado en CPU de Node; sin probar en un navegador (WebGPU/WASM, tiempos, calidad) | `docs/edicion-fotos.md` §7 |
| Subtítulos automáticos con OpenAI (`gpt-transcribe`) | Adaptador escrito; solo con HTTP simulado y la transcripción simulada; sin clave | `docs/editor-reels.md` |
| IA de imagen y edición de fotos con OpenAI (GPT Image: cambiar el fondo, mejorar, generar) | Adaptador escrito; solo con HTTP simulado; sin clave; máscara y consumo real sin contrastar | `docs/ia-medios.md` §13 |
| Edición de fotos con IA (ComfyUI: quitar el fondo y ampliar) | Flujos escritos; solo con HTTP simulado y la edición simulada; nodo de quitar fondo sin contrastar | `docs/edicion-fotos.md` |
| «Probar conexión» de Integraciones | Probado con servicios simulados: ninguna llamada real a Meta, Stripe, IA ni ComfyUI | `docs/05-puesta-en-marcha.md` |

## En staging

Proyecto `zzkdrfhqmjfvrdsoguio`, plan gratuito, región UE:

- 35 migraciones aplicadas (la última, `20261123010000_integrations_drive_copilot`, el 20/11/2026); todas las tablas de `public` con RLS. Organizaciones existentes en el plan «Heredado».
- Funciones desplegadas sin proveedores: `platform-integrations`, `drive-media`, `ai-generate`, `ai-media`, `ai-media-poll`, `ai-media-webhook`, `social-connect`, `social-publish`, `social-insights`, `billing-checkout`, `billing-portal`, `billing-webhook`, `delete-account`, `delete-organization`.
- Plataforma → Integraciones disponible para el superadministrador; ninguna integración configurada todavía.
- pg_cron: `rrss-ai-media-poll` (30 s), `rrss-social-publish` (cada minuto), `rrss-analytics` y `rrss-purge-provisional-assets` (cada hora). Faltan a propósito los secretos de Vault (`rrss_project_url`, `rrss_service_role_key`): sin ellos las llamadas programadas solo dejan un aviso.
- Inicio de sesión con retorno a https://rrss-omega.vercel.app y `localhost:5173`.
- Cuentas: la del dueño (superadministrador), una de prueba y la de la agencia (Gestora de Casa Tomás). Casa Tomás está dada de alta en Oficiosos, en modo agencia, con perfil, logotipos y 25 fotos.
- Copiloto del editor con OpenAI (21/11/2026): secretos de `ai-generate` `AI_TEXT_EDITOR_COPILOT_PROVIDER=openai`, `AI_TEXT_EDITOR_COPILOT_MODEL=gpt-6.1-terra`, `OPENAI_BASE_URL=https://eu.api.openai.com` y `AI_PRICES` de ese modelo; `ai-generate` y `platform-integrations` redesplegadas; `VITE_AI_VOICE_COPILOT_ENABLED` ya estaba en `true` en Vercel producción. **Falta la clave `OPENAI_API_KEY`** (la pone el dueño en Plataforma → Integraciones → IA de texto → OpenAI, de un proyecto con residencia en Europa). Sin probar con modelo real hasta entonces.
- Interruptores de Vercel encendidos: `VITE_AI_TEXT_ENABLED`, `VITE_AI_IMAGE_ENABLED`, `VITE_SOCIAL_PUBLISHING_ENABLED`, `VITE_AI_VOICE_COPILOT_ENABLED` y `VITE_DRIVE_LIBRARY_ENABLED`; cada módulo sale solo cuando su integración está configurada. Apagados: reels y recortes (sin trabajador alojado) y facturación (sin precios decididos).

## Para usar en staging lo desplegado

1. Drive: cliente OAuth de Google (Drive API, dirección de vuelta
   `…/functions/v1/drive-media/callback`) metido en Plataforma → Integraciones →
   Google Drive, y `SOCIAL_TOKEN_KEYS` («Generar clave» en Meta).
2. Instagram: «Generar clave» en Meta y conectar la cuenta pegando un token, o
   la aplicación de Meta para OAuth.
3. El trabajador de medios, cuando se aloje, con esta versión (desenfoque y
   fotos de Drive).
4. Fotos de Drive: 371 HEIC convertidas a JPEG; 126 subidas junto a su HEIC el
   20/11/2026, el resto pendiente (copia local en
   `codigo-restaurante/drive-jpeg-pendientes`).
5. Para llevar `f6/integracion` a staging (una sola pasada; solo hay una variable `VITE_` nueva):
   - Migraciones, en este orden (cada una con su vuelta atrás en `supabase/rollbacks/`):
     `20261124010000_media_storage_r2`, `20261126010000_integrations_openai`,
     `20261128010000_photo_editing`, `20261129010000_media_storage_orphans`,
     `20261130010000_publish_now`.
   - Función nueva: `media-storage` (`verify_jwt = false`, ya en `supabase/config.toml`).
   - Volver a desplegar `ai-generate`, `ai-media`, `ai-media-poll`, `ai-media-webhook`,
     `platform-integrations`, `social-publish`, `delete-account` y `delete-organization`;
     conviene redesplegar también `billing-checkout`, `billing-portal`, `billing-webhook`,
     `drive-media`, `social-connect` y `social-insights` para que todas lleven el mismo
     catálogo común de integraciones.
   - pg_cron: la migración `20261129010000` crea `rrss-media-orphans` (cada hora, minuto 41);
     necesita los secretos de Vault `rrss_project_url` y `rrss_service_role_key`, como las demás.
   - Vercel: `VITE_AI_PHOTO_EDIT_ENABLED` (dejarla apagada hasta tener un modelo de edición).
   - Después, la cuenta y el cubo de Cloudflare (`docs/almacenamiento-r2.md` §5) y, con el
     «sí» al recuento, la migración de archivos (560 archivos, ≈ 3,0 GB) y
     `scripts/alta-biblioteca.ts`.
   - El trabajador, cuando se aloje, con esta versión (`WORKER_MEDIA_STORAGE=auto`).

## Bloqueado por algo externo

| Qué                                                           | Qué hace falta                                                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publicar en Instagram y medir                                 | Aplicación de Meta (tipo Business), verificación de empresa y revisión de permisos; con acceso estándar se puede probar en staging con una cuenta propia                      |
| IA por API                                                    | Cuenta de Google Cloud con Vertex AI en la UE (o la alternativa elegida) y precios confirmados                                                                                |
| Cobrar                                                        | Cuenta de Stripe, moneda, precios por plan y portal configurado                                                                                                               |
| Correo para cualquiera (registro, recuperación, invitaciones) | SMTP propio (Resend u otro); hoy solo llega al equipo de Supabase, 2 por hora                                                                                                 |
| Reels y recortes en staging | Trabajador ya desplegado y probado con recortes; falta tarjeta en Fly (la prueba corta a los 5 min) y probar un reel completo (`docs/alojamiento.md` §4.2) |
| Fotos de Drive en staging                                     | Cliente OAuth de Google (Drive API, pantalla de consentimiento en producción sin verificar)                                                                                   |
| Archivos en Cloudflare R2                                     | Cuenta de Cloudflare, cubo en la UE, regla CORS, token del cubo y DPA firmado (`docs/almacenamiento-r2.md` §5)                                                                |
| Clientes reales                                               | Supabase de producción en Pro (copias de seguridad, sin pausas), dominio propio, páginas legales completadas y revisadas por un abogado, contrato de encargo con cada cliente |

## Decisiones del dueño pendientes


1. Moneda de cuenta, precios y límites de los planes (propuesta en `docs/facturacion.md`) y plan por defecto.
2. Proveedor de IA (por defecto, Google Cloud en la UE) y cupo mensual.
3. Activar el vídeo con IA (por defecto, apagado).
4. Alojamiento del trabajador de medios: recomendado Fly.io en Fráncfort; código preparado (`docs/alojamiento.md`), falta la cuenta.
5. Música para los reels y su licencia.
4. Alojamiento del trabajador de medios.
5. Música para los reels: el editor ya pide a la marca que confirme la licencia (queda en la procedencia); falta decidir si se ofrece una biblioteca de música con licencia.
6. Plazos de conservación de datos y revisión legal (`docs/rgpd.md`).
7. **Copiloto por voz en modo agencia (provisional).** `ai-generate` rechaza la IA de texto en marcas en modo agencia, salvo el copiloto por voz (`editor.copilot`), que no redacta: coloca literalmente lo dictado. Decidir si se mantiene, se quita o se hace configurable por marca (`docs/copiloto-voz.md` §4).
8. Decisiones provisionales que se pueden cambiar: una aprobación vale solo para la versión aprobada; quien edita y aprueba puede aprobar sin revisión; cada red es una pieza distinta; los colores fuera de la marca avisan pero no bloquean; aceptar un encargo aprueba la versión entregada; logotipos provisionales se borran a las 48 h.
9. Pasar los archivos a Cloudflare R2: crear la cuenta y dar el «sí» al recuento de la migración (`docs/almacenamiento-r2.md`).
10. Edición de fotos: si se quita el fondo con ComfyUI (GPU, con cupo de IA) o también en el trabajador sin GPU (descargar pesos de BiRefNet o IS-Net, 100–200 MB), y el precio por edición (`docs/edicion-fotos.md` §4 y §5).

## Pendientes conocidos

- Bajar a un plan sin publicación no detiene lo ya programado.
- Publicación: sin historias de Instagram, sin Facebook, el calendario usa la hora del dispositivo, renovar el token es volver a conectar.
- Exportar en el servidor (el editor exporta en el navegador).
- Sin reconocimiento de texto en escaneos ni imágenes; los reels no usan tipografías .woff.
- Editor: sin ajuste a guías al mover varias capas; zonas seguras solo para 9:16 y orientativas.
- Fase 4: lotes, coordinador y automatizaciones.
- Avisos de encargos por sondeo (60 s), sin tiempo real ni correo.
- ~~El trabajador usa la clave de servicio~~: resuelto con el intermediario `worker-gateway` (abajo); falta aplicarlo en staging.
- Variables nuevas sin llevar a `.env.example` (documentadas en `docs/`), entre ellas `VITE_AI_VOICE_COPILOT_ENABLED`, `VITE_DRIVE_LIBRARY_ENABLED`, `AI_TEXT_EDITOR_COPILOT_*` y las de Drive.
- Copiloto por voz: falta un aviso en el propio copiloto antes del primer dictado (el audio va a Google o Microsoft; la política de privacidad ya lo dice).
- Integraciones: tokens de «inicio de sesión de Instagram» (IG…) no admitidos; el vídeo con IA sigue solo por variables.

## Trabajador de medios en Fly.io (rama `f11/fly-trabajador`, 21/11/2026)

**Desplegado y probado en staging (21/11/2026).** App `rrss-worker` en Fráncfort, máquina `48e73d3b067698` (shared-cpu-2x, 2 GB, sin puertos, reinicio «no», modo `drain`), desplegada con la Action `worker-fly.yml` (el panel de Fly construyó una imagen equivocada: `docs/alojamiento.md` §4.2). Secretos en Fly: solo `SUPABASE_URL` y `WORKER_GATEWAY_TOKEN` (entra por `worker-gateway`, sin clave de servicio). Prueba real: 3 recortes de una foto de la biblioteca → la base de datos despertó la máquina, trabajo `succeeded` en ~20 s y la máquina se paró sola a los ~40 s sin trabajo. `VITE_MEDIA_WORKER_ENABLED=true` en Vercel. Reel completo probado el mismo día: el primer montaje falló con «plan: Invalid input» porque `request_media_job` quita los null (jsonb_strip_nulls) y el trabajador exigía `outline`; arreglado en el esquema del trabajador (ausente = null) y redesplegado; el reel salió 1080×1920, H.264 + AAC, 30 fps, en la biblioteca (carpeta Reels). Pendiente: borrar la máquina sobrante `1859526f369798` (parada) y tarjeta en Fly (la prueba corta a los 5 min).

- `worker/fly.toml`: Fráncfort, shared-cpu-2x con 2 GB y 1 GB de intercambio, modo `drain`, sin puertos, `[[restart]] policy = "never"` (la máquina se queda parada al salir).
- Migración `20261208010000_media_worker_wake.sql` (con vuelta atrás): integración «Trabajador de medios (Fly.io)» en Plataforma → Integraciones (`FLY_API_TOKEN` en Vault, `FLY_APP`, `FLY_MACHINE_ID`, «Probar conexión» = GET de la máquina), `private.media_worker_wake()` con pg_net a la API de máquinas de Fly, disparador al encolar trabajos `media.*`/`source.extract` y pg_cron `rrss-media-worker-wake` cada 2 minutos. Como mucho una llamada cada 10 s y ninguna si el trabajador tiene una reserva viva; sin configuración, solo un aviso.
- Token: uno **de despliegue de la app** del trabajador (el de menor permiso documentado que arranca su máquina).
- Despliegue: panel de Fly («Deploy from GitHub», directorio `worker`, configuración `fly.toml`). Alternativas sin ejecutar: GitHub Actions (`worker-fly.yml`, `worker-fly-preparar.yml`) y `worker/scripts/fly-preparar.mjs` (probado solo en modo «solo enseñar»; `flyctl` está bloqueado por Windows en el ordenador del dueño).
- Para llevarlo a staging: aplicar la migración, volver a desplegar `platform-integrations` (y, para el mismo catálogo, las demás funciones que lo importan) y, con el trabajador probado, `VITE_MEDIA_WORKER_ENABLED=true` en Vercel.

## Trabajador sin la clave de servicio (rama `f12/worker-sin-clave`, 21/11/2026)

El dueño no quiere `SUPABASE_SERVICE_ROLE_KEY` en Fly. Implementado y probado en local; **sin aplicar ni desplegar en staging**. Detalle, opciones valoradas y pasos en `docs/alojamiento.md` §5.

- Elegida la opción del intermediario: Edge Function `worker-gateway` (`verify_jwt = false`) con las operaciones exactas del trabajador (reclamar, renovar, terminar, fallar, devolver, URL firmadas de lectura y subida de una ruta). La clave de servicio se queda en Supabase. Descartado el rol de Postgres con JWT propio: no se puede revocar al momento y con las claves nuevas no está claro que Supabase lo admita.
- Migración `20261210010000_worker_gateway.sql` (con vuelta atrás): ajuste `WORKER_GATEWAY_TOKEN` (solo la huella SHA-256, en Vault; un disparador impide guardar otra cosa), funciones `worker_gateway_*` solo para la clave de servicio, que comprueban token, trabajo reservado por ese trabajador, tipos del trabajador y ruta de la organización y marca del trabajo, y tope de 1.200 llamadas por minuto (`private.worker_gateway_calls`).
- Plataforma → Integraciones → Trabajador de medios: «Generar token» (sale una vez para pegarlo en Fly), «Generar uno nuevo (rotar)» y «Revocar». «Probar conexión» avisa si falta.
- Trabajador: modo `gateway` por defecto (`worker/src/gateway.ts`); `service-key` solo pidiéndolo (local y CI); en Fly no arranca si encuentra la clave. `fly-preparar.mjs` y `worker-fly-preparar.yml` ya ponen el token y quitan la clave si quedaba.
- En Fly solo van `SUPABASE_URL` y `WORKER_GATEWAY_TOKEN`.
- E2E del reel y de un recorte por el intermediario del stack local escrita (`tests/e2e/11-reels.spec.ts`) y **sin ejecutar** (Docker parado).
- Para llevarlo a staging: aplicar la migración y desplegar `worker-gateway` y `platform-integrations`; después, el dueño genera el token y lo pega en Fly.

## Pulido (rama `f6/pulido`, en `f6/integracion`, 20/11/2026)

- Política de privacidad (versión `2026-11-20`, sigue siendo plantilla pendiente de revisión legal): añadidos el dictado por voz del navegador, Google Drive y Cloudflare R2 como encargados.
- Reels: deslizador de desenfoque (0 a 100) por foto; viaja en el plan (`blur`).
- Huérfanos en R2: `uploadAsset` pide `media-storage/discard` si falla el alta, y la tarea `rrss-media-orphans` (cada hora, necesita los secretos de Vault) barre lo apuntado sin recurso tras 24 h. Migración `20261129010000` con vuelta atrás. Probado con la función simulada; contra R2 real, sin probar.
- OpenAI como proveedor de texto (`f6/openai`, migración `20261126010000`): claves `OPENAI_API_KEY`, `OPENAI_BASE_URL` (UE: `https://eu.api.openai.com`), `OPENAI_ORGANIZATION` y `OPENAI_PROJECT` en Plataforma → Integraciones → IA de texto; sin clave no se carga. Sin probar contra OpenAI real.
- Plan «Prueba»: las funciones de IA salen como no incluidas si el cupo de IA es 0.
- Conexión con Meta sin marca conocida: aviso en la pantalla de entrada.
- Miniaturas (`f11/textos-miniaturas`, migración `20261209010000`, sin aplicar en ningún entorno): `media_assets.thumb_path`, miniatura WebP de ~400 px generada en el navegador al subir y usada en biblioteca, selectores, calendario, Campañas y tira del carrusel; URL firmadas en caché. Las imágenes que ya existen: `scripts/miniaturas-biblioteca.ts` (en seco por defecto, **sin ejecutar**; ver `docs/almacenamiento-r2.md`).
- Textos para el dueño: diccionario `src/lib/texts.ts` (actividad, estados, zonas horarias) y prueba `src/lib/texts.test.ts` que falla si una pantalla enseña nombres de tablas, UTC, JSON, undefined/null…; «Exportar JSON» → «Descargar configuración», «unidades de cuenta» → «créditos», token → «clave de acceso»/«conexión avanzada». Pendiente de la auditoría: la erratas «publicaciónes» no está en el código (viene de datos guardados); se corrige al mostrarla.

## Siguiente paso

1. Probar en https://rrss-omega.vercel.app el primer encargo real de Casa Tomás (post del chuletón) y el resto de pantallas con datos reales.
2. El dueño crea la aplicación de Meta, la cuenta de correo y, si quiere IA por API, Google Cloud.
3. Con la aplicación de Meta: conectar la cuenta de Instagram de Casa Tomás en staging y publicar una pieza aprobada.
