# Imagen y vídeo generativos (Fase 2)

Código en `supabase/functions/_shared/ai/media/`. Registro de modelos en la
tabla `ai_media_models` (migración `20261117110000_ai_media_models.sql`).

**Estado, sin adornos:**

| Pieza                                     | Implementado            | Probado                                                     | Pendiente o bloqueado                                                                                   |
| ----------------------------------------- | ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Contrato de medios, servicio, cupo y cola | Sí                      | Sí, contra las migraciones reales con proveedores simulados | —                                                                                                       |
| Registro de modelos y precios             | Sí                      | Sí (RLS, privilegios, vuelta atrás)                         | Todas las filas están inactivas: falta que el dueño elija proveedor y que alguien contraste los precios |
| Adaptadores reales (6, con ComfyUI)       | Sí                      | **Solo con respuestas HTTP simuladas**                      | **Ninguno se ha probado contra el servicio real**: no hay cuentas ni claves                             |
| Almacenamiento de resultados (§7)         | Sí, sobre Storage       | Contra la base de datos real (PGlite)                       | No se ha ejecutado contra un Storage de verdad: lo hará la prueba de extremo a extremo `10-…`           |
| Funciones `ai-media`, `ai-media-poll` y `ai-media-webhook` (§8) | Sí | Su lógica, en Node con la base de datos real y la imagen simulada | Sin desplegar. La prueba de extremo a extremo `10-…` está escrita y sin ejecutar |
| Seguimiento con pg_cron (§9)              | Sí (migración)          | El disparador, en PGlite (sin pg_cron: no hace nada)        | No se ha programado en ningún Supabase; faltan los secretos de Vault en cada entorno                    |
| Pantalla «Con IA» en el editor (§10)      | Sí                      | Pruebas de componentes                                      | Solo imagen: el vídeo generativo no se expone (nace apagado)                                            |

No se ha elegido proveedor: están preparados todos detrás del mismo contrato
para decidir después.

## 1. Adaptadores

Todos usan `fetch` puro, sin SDK, y llevan en la cabecera del archivo las
páginas de documentación oficial contra las que se escribieron (consultadas el
17/11/2026) y lo que queda por confirmar con una llamada real.

| Adaptador                            | Archivo                                | Tipo            | Entrega                                                 | Región                             | Notas                                                                                                         |
| ------------------------------------ | -------------------------------------- | --------------- | ------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `google-vertex`                      | `vertex-image.ts` (+ `google-auth.ts`) | Imagen          | Síncrona                                                | UE por defecto (multirregión `eu`) | Sin confirmar: forma de la imagen en la respuesta REST, `imageSize` y qué modelos están en la UE              |
| `bfl`                                | `bfl-image.ts`                         | Imagen (FLUX.2) | Asíncrona, por sondeo                                   | UE por defecto (`api.eu.bfl.ai`)   | Puede entrenar con las entradas salvo contrato enterprise. Sin webhook: su documentación no describe la firma |
| `ideogram`                           | `ideogram-image.ts`                    | Imagen          | Síncrona                                                | No documentada                     | El endpoint v3 figura como heredado; valores admitidos de proporción y velocidad sin listar                   |
| `higgsfield`                         | `higgsfield-video.ts`                  | Vídeo           | Asíncrona: sondeo y webhook firmado (Standard Webhooks) | No documentada                     | Puede entrenar con las entradas. Solo cobra lo completado                                                     |
| `fal`                                | `fal-video.ts`                         | Vídeo           | Asíncrona: sondeo y webhook firmado (ED25519 con JWKS)  | No garantizada                     | Con modelos de terceros el contenido pasa a ese tercero                                                       |
| `comfyui`                            | `comfyui-image.ts`                     | Imagen (FLUX.2 Klein 4B, abierto) | Asíncrona, por sondeo                 | La del servidor que se configure   | Servidor ComfyUI propio (§11). Nadie entrena con lo enviado. Las referencias (`ReferenceLatent`), sin contrastar |
| `simulated-image`, `simulated-video` | `simulated.ts`                         | Ambos           | Síncrona / asíncrona                                    | —                                  | Solo pruebas. La imagen es un PNG determinista; el vídeo, un archivo de prueba no reproducible                |
| `simulated-image-async`              | `simulated.ts`                         | Imagen          | Asíncrona, sin estado                                   | —                                  | Solo pruebas locales: el trabajo «termina» a los 2 s; prueba el sondeo de punta a punta                       |

| `openai` | `openai-image.ts` | Imagen (GPT Image) y ediciones de foto | Síncrona | Global; UE con `eu.api.openai.com` | §13. Misma clave que el texto. Sin probar con OpenAI real |

Fuera de este bloque: Runway (se eligió fal.ai como segundo de vídeo porque su
cola y sus webhooks están documentados con detalle), Recraft,
Stability, Replicate y voz. La edición de fotos (quitar el fondo y ampliar con
IA; recortes y ajustes sin IA) está en `docs/edicion-fotos.md`.
Los reels montados con plantillas son del trabajador de medios, no de aquí.

## 2. Contrato (`contract.ts`)

- **Petición**: `ImageRequest` (texto, imágenes de referencia, proporción,
  tamaño) o `VideoRequest` (imagen inicial, texto, duración, proporción). Una
  generación produce un medio; cuatro propuestas son cuatro generaciones.
- **Adaptador** (`MediaProvider`): `estimateUsage` (cota superior, sin llamar a
  nadie), `start` (devuelve el resultado o el trabajo en curso), y opcionales
  `poll`, `cancel` y `parseWebhook` (comprueba la firma antes de creer nada).
- **Servicio** (`MediaService`): `estimate` (coste máximo antes de generar),
  `generate`, `processJob` (avanza un trabajo de la cola) y `handleWebhook`.
- **Almacenamiento** (`MediaStorage.put`) y **lecturas** (`MediaReader`) se
  inyectan: este módulo no escribe en Storage ni abre conexiones.
- Cada resultado dice dónde se procesó (`dataRegion`, `euProcessing`), si el
  proveedor puede entrenar con las entradas (`trainsOnInputs`) y si el
  adaptador sigue sin probar contra el servicio real (`untestedAdapter`).

## 3. Ciclo de una generación

1. Se elige el modelo del registro (ver §5) y se valida la petición.
2. `estimateUsage` × precio del registro = cota superior del coste.
3. `ai_reserve_generation` aparta esa cota. **Si no hay cupo, aquí se acaba: no
   se llama al proveedor.**
4. Se lanza en el proveedor, con tiempo máximo.
   - Falla (error, límite de uso, tiempo agotado): `ai_fail_generation`
     devuelve la reserva.
   - Síncrono: se guarda el archivo y `ai_complete_generation` cambia la
     reserva por el coste real.
   - Asíncrono: se encola un trabajo `ai.media.poll` con clave de idempotencia
     `ai-media:<generación>`. La reserva sigue contando mientras dura.
5. El trabajo lo cierra quien llegue antes:
   - **Sondeo** (`processJob`): si sigue en curso, el trabajo vuelve a la cola
     con espera creciente; si terminó, se descarga el resultado a nuestro
     almacenamiento y se registra el coste; si falló, se devuelve la reserva.
   - **Webhook** (`handleWebhook`): firma comprobada, y además el aviso debe
     ser del trabajo de esa generación.
6. **Trabajo que nunca termina**: pasado el tiempo máximo (30 min por defecto) o
   agotados los intentos de consulta, se pide al proveedor que lo cancele y se
   devuelve la reserva.

**Idempotencia.** El estado de la generación es el árbitro: un webhook
repetido, o un sondeo que llega después del webhook, encuentran la generación
cerrada y no hacen nada (ni descargan, ni cobran). `ai_complete_generation` no
apunta dos costes aunque se llame dos veces.

**Vídeo: segundos.** El consumo queda en `ai_generations.usage.seconds`; se
cobra por los segundos que el proveedor dice haber generado y, si no lo dice,
por los pedidos. El cupo sigue siendo solo de coste: un cupo en segundos exige
ampliar `usage_quotas.metric`.

**Si el archivo no se puede guardar.** En síncrono el gasto ya está hecho: se
apunta el coste sin resultado y se devuelve un error. En asíncrono se reintenta
(el proveedor conserva el archivo un tiempo).

## 4. Registro de modelos (`ai_media_models`)

Proveedor, modelo, tipo, unidad de cobro (`image`, `megapixel`, `second`),
precio en millonésimas, matices de tarifa (`price_details`: primera unidad,
recargo por megapíxel de referencia), **fecha y fuente del precio**, si está
verificado, región de datos, si el proveedor puede entrenar con las entradas,
entrega síncrona o asíncrona, ajustes del modelo (`settings`: nombres de los
campos de la petición, duraciones admitidas…), prioridad y estado.

- Lo lee cualquier usuario con sesión; lo escribe solo un superadministrador
  (y el servidor). No es dato de ningún cliente.
- **Un modelo con el precio sin verificar no se puede activar** (restricción de
  la tabla).
- Las filas sembradas nacen inactivas y son las únicas cuyo nombre de modelo
  salió de la documentación oficial:

| Modelo                                               | Precio sembrado                                                         | ¿Verificado?                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `google-vertex` · `gemini-nano-banana-2.1`           | 0,0336 por imagen                                                       | **No**: es el precio de la API de Gemini, no el de Vertex |
| `bfl` · `flux-2-pro`                                 | 0,03 el primer megapíxel, 0,015 los demás y por megapíxel de referencia | Sí (bfl.ai/pricing, 16/11/2026)                           |
| `ideogram` · `ideogram-v3` (Turbo)                   | 0,03 por imagen                                                         | Sí (ideogram.ai/pricing, 16/11/2026)                      |
| `higgsfield` · `kling-video/v3.0/std/image-to-video` | 0,112 por segundo                                                       | **No**: las dos páginas oficiales no coinciden            |

De fal.ai no se siembra nada: no se ha contrastado ningún par modelo–precio.

- Los precios están en la moneda del proveedor (USD). La conversión a la moneda
  de cuenta de la plataforma es una decisión pendiente; hoy se toman uno a uno.

## 5. Configuración del servidor

**Desde la interfaz:** un superadministrador puede meter las credenciales en
**Plataforma → Integraciones**: «IA de imagen» (modelo fijo, criterio de datos,
cuenta de servicio de Vertex en JSON, claves de Black Forest Labs e Ideogram) y
«ComfyUI propio» (URL base, token de acceso y región de los datos). Se guardan
cifradas en Supabase Vault (migración `20261120010000`), no se vuelven a ver y
mandan sobre las variables de abajo; `ai-media`, `ai-media-poll` y
`ai-media-webhook` las leen sin redesplegar (caché de 30 s). «Probar conexión»
pide un token a Google (Vertex), el saldo a Black Forest Labs (`/v1/credits`) o
el estado a ComfyUI (`/system_stats`); Ideogram no documenta ninguna llamada
gratuita y se dice así. Nada de eso genera imágenes. El vídeo (Higgsfield,
fal.ai) sigue apagado y solo por variables. La interfaz enseña la imagen con IA
si `VITE_AI_IMAGE_ENABLED=true` **y** hay algún modelo de imagen activo con su
adaptador configurado.

**O como variables** de las funciones del servidor (nunca `VITE_`). Las de este bloque
(ComfyUI, pruebas locales) están documentadas aquí y todavía NO en
`.env.example`. Sin su clave un adaptador no se carga, y el error dice qué
variable falta.

En la interfaz, `VITE_AI_IMAGE_ENABLED=true` enseña «Con IA» en el editor; sin
ella no aparece nada (igual que `VITE_AI_TEXT_ENABLED` con el texto).

| Proveedor         | Variables                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Edición de fotos  | `AI_MEDIA_REMOVE_BACKGROUND_MODEL`, `AI_MEDIA_UPSCALE_MODEL` (`proveedor:modelo`; ver `docs/edicion-fotos.md`) |
| Elección          | `AI_MEDIA_IMAGE_MODEL`, `AI_MEDIA_VIDEO_MODEL` (`proveedor:modelo`), `AI_MEDIA_ALLOW_NON_EU`, `AI_MEDIA_WEBHOOK_BASE_URL` (`https://<proyecto>.supabase.co/functions/v1/ai-media-webhook`), `AI_ALLOWED_ORIGIN` (CORS de `ai-media`) |
| ComfyUI propio    | `COMFYUI_BASE_URL` (https, o http solo en localhost), `COMFYUI_API_TOKEN` (opcional: el token del proxy o túnel), `COMFYUI_DATA_REGION` (`eu`, `us`, `global` o `unknown`; por defecto `unknown`) |
| Solo pruebas      | `AI_E2E_SIMULATED_PROVIDER=true` (imagen simulada síncrona y asíncrona en `ai-media`; exige un Supabase local, §12) y `AI_MEDIA_SIMULATED=true` (simulados de imagen y vídeo; desde el 18/11/2026 también exige un Supabase local) |
| Vertex AI         | `GOOGLE_VERTEX_PROJECT_ID`, `GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON`, `GOOGLE_VERTEX_LOCATION` (opcional, `eu`)                                     |
| Black Forest Labs | `BFL_API_KEY`, `BFL_API_BASE_URL` (opcional, `https://api.eu.bfl.ai`)                                                                           |
| Ideogram          | `IDEOGRAM_API_KEY`                                                                                                                              |
| Higgsfield        | `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET`, `HIGGSFIELD_WEBHOOK_SECRET` (opcional)                                                    |
| fal.ai            | `FAL_KEY`                                                                                                                                       |

**Criterio de datos.** Por defecto solo se eligen solos los modelos que
procesan en la UE. Los demás siguen disponibles, pero hay que fijarlos a
propósito (`AI_MEDIA_*_MODEL`) o permitirlos (`AI_MEDIA_ALLOW_NON_EU=true`), y
su resultado va marcado. La región efectiva es la del adaptador cuando depende
de su configuración: un Vertex apuntando a `global` no cuenta como UE aunque el
registro diga otra cosa.

## 6. Antes de activar un proveedor

1. Cuenta, clave y contrato de tratamiento de datos (DPA, región, no
   entrenamiento).
2. Una llamada real con cada adaptador y corregir lo que la documentación no
   dejaba claro (lista en la cabecera de cada archivo).
3. Contrastar el precio en la página oficial, anotar fecha y fuente y marcarlo
   verificado; después, activar la fila.
4. Desplegar `ai-media`, `ai-media-poll` y `ai-media-webhook`, crear los dos
   secretos de Vault (§9) y poner `VITE_AI_IMAGE_ENABLED=true` en la aplicación.

## 7. Almacenamiento (`supabase-storage.ts`)

Cada resultado acaba en el cubo privado `brand-media`, en
`<organización>/<marca>/ia/<generación>-<índice>.<ext>`, y en `media_assets`
como un recurso más: `origin = 'generated'`, carpeta `IA`, etiqueta `ia`,
`created_by` = quien lo pidió, medidas leídas de la cabecera del archivo y la
procedencia en `provenance` (la columna que creó la exportación del editor,
migración `20261118120000`):

```json
{"type": "ai_generation", "generation_id": "…", "provider": "comfyui", "model": "flux-2-klein-4b",
 "purpose": "post.visual", "prompt": "<encargo, recortado>", "data_region": "unknown",
 "trains_on_inputs": "no", "untested_adapter": true}
```

- **Tope de 2048 bytes** (lo exige la columna): el encargo se recorta hasta caber.
- **Solo el servidor** puede escribir `type: 'ai_generation'` (disparador de la
  migración `20261118210000`): nadie hace pasar una foto suya por generada.
- **Idempotente**: misma generación e índice → misma ruta y misma fila (subida
  con `upsert` y fila con `on conflict (storage_path)`).
- **50 MB por archivo** (plan gratuito de Supabase y tope del cubo): lo mayor se
  rechaza antes de subir. El tipo se mira en los bytes, no en lo que diga el
  proveedor, y debe ser uno de los que admite el cubo.
- La generación anota en `ai_generations.output.assets[].asset_id` el recurso
  creado: así la interfaz lo encuentra al terminar un trabajo asíncrono.

## 8. Funciones

| Función | Quién la llama | Autenticación | Qué hace |
| --- | --- | --- | --- |
| `ai-media` | La interfaz | Sesión del usuario (JWT) | `image.models`, `image.estimate`, `image.generate` |
| `ai-media-poll` | pg_cron (§9) | **Solo la clave de servicio** (`Authorization: Bearer` o `apikey`); `verify_jwt = false` | Reclama hasta 5 trabajos `ai.media.poll` y llama a `processJob` |
| `ai-media-webhook` | Los proveedores | **Firma del proveedor** (la comprueba su adaptador); `verify_jwt = false` | `handleWebhook`; 401 si la firma o el trabajo no casan |

`ai-media` (petición `{ action, brandId, input }`):

- `image.models` → `{ models: [{ id: "proveedor:modelo", displayName, delivery, dataRegion, euProcessing, trainsOnInputs, untestedAdapter, default }] }`.
  Solo los modelos activos del registro cuyo adaptador está configurado y que
  el criterio de datos permite (UE, o `AI_MEDIA_ALLOW_NON_EU`, o el fijado en
  `AI_MEDIA_IMAGE_MODEL`). No se puede pedir un modelo que no esté en la lista.
- `image.estimate` `{ aspectRatio, model?, referenceAssetIds? }` →
  `{ model, costMicros, usage, size }`. **No reserva nada.**
- `image.generate` `{ prompt, aspectRatio, model?, referenceAssetIds?, purpose? }`:
  200 `{ status: "completed", asset: { id, path }, costMicros, … }` o
  202 `{ status: "pending", generationId, jobId }`.
- Proporciones: las del lienzo (`1:1`, `4:5`, `9:16`, `16:9`); el tamaño pedido
  es de ~1 MP en múltiplos de 64. Encargo de hasta 2000 caracteres; hasta 4
  referencias, que deben ser imágenes de la biblioteca de esa marca que el
  usuario ve (se leen con su identidad y viajan como URL firmada de 15 min).
- Errores: mismos códigos, estados y mensajes que `ai-generate`
  (`quota_exhausted`/`quota_missing` 402, `forbidden` 403, `not_configured` 503…).
- El vídeo generativo **no** se expone: nace apagado por criterio de datos.
- El registro de modelos se relee como mucho una vez por minuto: activar un
  modelo no exige redesplegar.

## 9. Seguimiento de los trabajos asíncronos (pg_cron + pg_net)

La migración `20261118210000` programa con pg_cron, cada 30 s, la función
`private.ai_media_poll_dispatch()`: si hay trabajos `ai.media.poll` que toque
mirar, llama a `ai-media-poll` con pg_net; si no, no hace nada (no gasta
invocaciones). Donde no existen pg_cron o pg_net (PGlite) no se programa.

**Plan gratuito.** La documentación de Supabase (consultada el 18/11/2026:
`guides/functions/schedule-functions`, `guides/cron`, `guides/cron/install`,
`guides/database/extensions/pg_net`) presenta pg_cron y pg_net como
extensiones de la plataforma y no las limita a ningún plan; pero tampoco dice
expresamente que estén en el gratuito, y la página de precios no las menciona.
**Hay que comprobarlo en staging** (Integrations → Cron) al aplicar la
migración. Esas páginas traían una nota dirigida a asistentes automáticos
(pedía preparar un informe para Supabase); no se siguió. Coste: con trabajos
pendientes, 2 invocaciones por minuto como mucho; el plan gratuito incluye
500 000.

En cada entorno, una vez (SQL Editor, como `postgres`):

```sql
select vault.create_secret('https://<proyecto>.supabase.co', 'rrss_project_url');
select vault.create_secret('<clave de servicio del proyecto>', 'rrss_service_role_key');
```

Sin esos dos secretos el disparador avisa en el registro y no llama a nada.
**Aviso de la propia documentación:** mientras la petición está en la cola de
pg_net, la clave queda escrita en `net.http_request_queue` y la puede leer
cualquier rol de la base de datos que pueda iniciar sesión. En local
(`supabase start`) la dirección interna es `http://kong:8000`.

## 10. Interfaz

`GenerateImageDialog` (`src/features/ai/`), desde «Añadir → Con IA» del editor:
encargo, proporción (la del lienzo por defecto), referencias de la biblioteca,
modelo (de `image.models`), **coste máximo antes de generar**, estado mientras
genera y, si es asíncrono, seguimiento consultando `ai_generations` cada 3 s
(si se cierra la ventana, la imagen llega igualmente a la biblioteca). La
imagen entra como capa (se deshace con Ctrl+Z) y queda en la biblioteca. Cupo
agotado y «no configurado», con los mensajes de siempre.

## 11. ComfyUI propio (modelos abiertos)

> La dirección del túnel, el token y la región se pueden meter en Plataforma →
> Integraciones → ComfyUI propio, y «Probar conexión» comprueba que responde
> (`/system_stats`) sin generar nada. Útil con el cuaderno de Colab, cuya
> dirección cambia en cada sesión.

Adaptador `comfyui` contra la API HTTP documentada de ComfyUI (`/prompt`,
`/history/{id}`, `/view`, `/upload/image`; `/queue` e `/interrupt` para
cancelar, y `/interrupt` solo si lo que está en marcha es nuestro trabajo).
Grafo de FLUX.2 Klein 4B (Apache-2.0) copiado del cuaderno de Colab de pruebas
(`flux-2-klein-4b-fp8`, codificador `qwen_3_4b_fp8_mixed`, VAE `flux2-vae`, 4
pasos, semilla fija por generación), con los nombres de archivo cambiables en
`ai_media_models.settings`. Fila `comfyui · flux-2-klein-4b` sembrada
**inactiva**, a precio 0 y **sin verificar** (el coste es el de la GPU).
La página de la documentación de ComfyUI traía una indicación dirigida a
asistentes automáticos (descargar un índice); no se siguió.

### Con el cuaderno de Colab, paso a paso (pruebas)

1. El cuaderno de `tools/rrss-colab-imagenes/` **no abre túnel** (su celda 8
   está vaciada a propósito) y ComfyUI escucha solo en `127.0.0.1`. Para que la
   función llegue a él hay que añadir un túnel con autenticación (ver riesgos);
   no se ha hecho ni probado.
2. Ejecutar las celdas 1 a 7 (ajustes, GPU, instalación, modelos, arranque y
   vigilante). No ejecutar la 9: genera las seis imágenes de prueba del cuaderno.
3. Abrir el túnel con acceso protegido y apuntar su dirección https y su token.
4. En staging (nunca en producción): `COMFYUI_BASE_URL=<https del túnel>`,
   `COMFYUI_API_TOKEN=<token>`, `COMFYUI_DATA_REGION=unknown` (Colab no
   garantiza región) y, como no es UE, `AI_MEDIA_IMAGE_MODEL=comfyui:flux-2-klein-4b`.
5. Un superadministrador: `update ai_media_models set price_micros = 0,
   price_verified = true, active = true where provider = 'comfyui'` (0 porque
   la T4 gratuita no cuesta; en una GPU de pago, su coste por imagen).
6. Generar desde el editor. El trabajo es asíncrono: lo cierra `ai-media-poll`
   (pg_cron, §9). Cuenta con un par de minutos por imagen en la T4.
7. Al acabar: desactivar la fila, quitar `COMFYUI_*` y cerrar el entorno de
   Colab (celda 11). Con el entorno cerrado, los trabajos en curso acaban como
   «no terminó a tiempo» y devuelven el cupo.

En producción: una GPU alquilada con ComfyUI detrás de un proxy https con
token; si está en la UE, `COMFYUI_DATA_REGION=eu` (y entonces no hace falta
fijar el modelo).

### Riesgos de exponer ComfyUI por un túnel público

ComfyUI **no tiene autenticación**: quien conozca la dirección puede ejecutar
cualquier grafo (gastar la GPU, minar, o leer y escribir archivos con nodos que
lo permitan), subir archivos (`/upload/image`), ver todo lo generado y las
referencias subidas (`/view`, `/history`: imágenes de clientes) e interrumpir o
vaciar la cola. Las direcciones «aleatorias» de los túneles gratuitos se
filtran (registros, historial, capturas) y se rastrean.

Cómo mitigarlo:

- **Nunca un túnel sin autenticación.** Delante de ComfyUI, algo que exija un
  token: el acceso con token de servicio del propio túnel, o un proxy inverso
  que compruebe `Authorization: Bearer` (es lo que manda `COMFYUI_API_TOKEN`).
- Token largo y aleatorio, solo en las variables de la función; uno nuevo en
  cada sesión.
- **Sin nodos personalizados** que lean, escriban o descarguen archivos
  arbitrarios: el cuaderno instala solo los fijados.
- Túnel y entorno **efímeros**: se cierran al terminar (el vigilante del
  cuaderno corta a los 52 min); nada de dejarlo abierto.
- Nada de datos personales en encargos ni referencias mientras sea Colab
  (región desconocida, sin contrato de tratamiento).
- `COMFYUI_BASE_URL` solo admite https (http únicamente en `localhost`) y sin
  usuario ni contraseña en la URL; la descarga de referencias no lleva el token
  de ComfyUI.
- Vigilar la cola: si aparecen trabajos que no son nuestros, cerrar el entorno.

## 12. Pruebas locales de extremo a extremo

Con `AI_E2E_SIMULATED_PROVIDER=true` (ya en `supabase/functions/e2e.env`) y un
Supabase local (`SUPABASE_URL` por http con host `127.0.0.1`, `localhost` o
`kong`), `ai-media` ofrece dos modelos que solo existen en memoria:
`simulated-image · simulado-e2e` (síncrono) y `simulated-image-async ·
simulado-e2e-asincrono` (asíncrono, termina a los 2 s), a 0,02 unidades de
cuenta por imagen (precio inventado). Con la variable y otro Supabase, la
función no arranca. Escenario: `tests/e2e/10-fase2-imagen-con-ia.spec.ts`
(pasa en la tanda completa desde el 18/11/2026; `playwright.config.ts` pasa
`VITE_AI_IMAGE_ENABLED=true`).

## 13. OpenAI como proveedor de imagen (GPT Image)

Adaptador `openai` (`openai-image.ts`), con la **misma** clave que el texto:
`OPENAI_API_KEY` de «Plataforma → Integraciones» (y `OPENAI_BASE_URL`,
`OPENAI_ORGANIZATION`, `OPENAI_PROJECT`, que ya existen para el texto). Sin
clave no se carga y «Probar conexión» lo dice con el nombre de la variable.

**Fuentes (consultadas el 20/11/2026):**
`https://developers.openai.com/api/docs/guides/image-generation`,
`https://developers.openai.com/api/reference/resources/images/methods/edit` y
`https://developers.openai.com/api/docs/pricing`.

| Dato | Lo que dice la documentación |
|---|---|
| Modelos vigentes | Familia GPT Image 2.5 y 2.6: `gpt-image-2.5-sunburst` («mayor precisión de edición») y `gpt-image-2.5-flare` («generación rápida de uso diario»); también `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1` y `gpt-image-1-mini`. |
| Generar | `POST /v1/images/generations` (JSON). |
| Editar | `POST /v1/images/edits`: `image` (o `image[]`), `mask`, `prompt`, `size`, `quality`, `background`, `output_format`, `n`. Respuesta en `data[].b64_json` (los modelos GPT Image no devuelven URL). |
| Máscara | Mismo formato y tamaño que la imagen, con canal alfa; se edita lo transparente. **«Enmascarar con GPT Image se hace por indicación (prompt)»**: el modelo puede no respetar la forma exacta. Menos de 50 MB. |
| Fondo transparente | `background: "transparent"` con `output_format` `png` o `webp`; lo admiten `gpt-image-2.5-*` (y `gpt-image-2` en vista previa). |
| Tamaños | `1024x1024`, `1536x1024`, `1024x1536` y `auto` en todos; en la familia 2/2.5, cualquier `AnchoxAlto` con lados múltiplos de 16, proporción hasta 3:1, lados ≤ 3840 y entre 655.360 y 8.294.400 píxeles. |
| `input_fidelity` | Se omite en `gpt-image-2` (siempre alta fidelidad). El adaptador solo la envía si el modelo la pide en sus ajustes. |
| Precio | **Por tokens**, no por imagen: imagen 8 USD entrada y 30 USD salida por millón de tokens (texto 5 USD entrada), igual en 2, 2.5 y 2.6. Las tarifas por imagen de la guía (p. ej. `gpt-image-2` media 1024² = 0,053 USD, alta = 0,211 USD) son «históricas, para comparar»; para 2.5/2.6 no hay tabla por imagen. |
| Residencia | `eu.api.openai.com` (proyecto con región Europa) procesa en la UE; con la dirección normal, no. |

**Operaciones (registro `ai_media_models`, proveedor `openai`, migración
`20261202010000`):**

| Operación | Modelo | Qué hace | Prioridad |
|---|---|---|---|
| `generate` | `gpt-image-2.5-flare` | Generar imagen (con referencias va por `/edits`) | 0 |
| `replace_background` | `gpt-image-2.5-sunburst` | Cambiar el fondo por el descrito; con máscara del sujeto, solo el fondo | 0 |
| `enhance` | `gpt-image-2.5-sunburst` | Mejorar luz y color con IA | 0 |
| `remove_background` | `gpt-image-2.5-sunburst` | Quitar el fondo (PNG transparente) | -10 (gana un modelo propio) |

- **Precio sembrado = cota, no tarifa.** Como OpenAI cobra por tokens, el
  registro lo aproxima por megapíxel con calidad `medium`:
  `price_micros` 70.000 por megapíxel de salida (73.000 el primero) y
  `input_megapixel_micros` 14.000 por megapíxel de entrada (la foto y, si hay,
  la máscara; cada una cuenta como mucho `max_input_megapixels` = 4). El
  resultado de una edición sale a ~1,5 MP (`size_mode: custom`, múltiplos de
  16 y la proporción de la foto; `preset` fija uno de los tres tamaños). El
  consumo real en tokens **no** se convierte en dinero: se cobra la cota
  reservada. Ejemplo: cambiar el fondo de una foto de 12 MP con máscara reserva
  unos 0,26 USD, aunque lo normal en OpenAI sea bastante menos. El gasto real
  está en el panel de OpenAI.
- **Nacen inactivos y sin precio verificado** (como todo el registro). No hay
  pantalla de modelos: quien administra la plataforma los activa con
  `update public.ai_media_models set price_verified = true, active = true
  where provider = 'openai' and operation = '…'` tras contrastar la cota con su
  panel de OpenAI (y ajustar `price_micros` si quiere), como en §6.
- **Residencia.** Fuera de la UE por decisión del dueño: hay que permitirlo
  con la variable de siempre, `AI_MEDIA_ALLOW_NON_EU=true` (o fijar el modelo),
  o usar `OPENAI_BASE_URL=https://eu.api.openai.com` con un proyecto europeo.
  Sin eso, el adaptador está cargado pero no se ofrece ninguna operación. La
  interfaz enseña «Se procesa fuera de la UE» en cada edición.
- **Coste máximo antes de llamar, cupo y coste por organización:** el mismo
  camino que el resto (`estimate`, `ai_reserve_generation`, `ai_generations`).
- `trains_on_inputs` está en `no` (OpenAI dice que no entrena con datos de la
  API por defecto): **confirmar en la cuenta**.
- **Sin probar contra OpenAI real** (no hay clave): probado con HTTP simulado
  (`tests/db/ia-openai-imagen.test.ts`). Dudas que solo una llamada real
  resuelve: que la máscara con nuestro convenio (opaco = plato) proteja el
  plato; que la máscara a resolución de la foto se acepte con un `size` de
  salida distinto; el consumo real en tokens (para afinar la cota); y si la
  clave del dueño necesita «verificar la organización» para usar GPT Image.

**«Probar conexión».** Además de listar modelos (`GET /v1/models`, gratis),
comprueba que la lista incluya algún `gpt-image…`; si no, avisa (sin darlo por
fallo: la clave sirve para texto) de que puede hacer falta verificar la
organización o dar acceso al proyecto.

## 14. Valoración: Cloudflare Workers AI (20/11/2026)

**Resultado: no se programa el adaptador.** Workers AI cubre bien generar
imagen (y texto), pero no ninguna edición de foto que sirva a este producto, y
la regla de la plataforma es que el plato no se toca. Se deja documentado para
reabrirlo si cambian los modelos.

**Fuentes (consultadas el 20/11/2026):**
`developers.cloudflare.com/workers-ai/models/` (catálogo),
`…/workers-ai/platform/pricing/`, `…/workers-ai/platform/limits/`,
`…/workers-ai/platform/data-usage/`, las fichas y avisos de cambios de
`flux-2-klein-4b` y `flux-2-klein-9b`, la ficha de
`stable-diffusion-v1-5-inpainting` y la tabla de compatibilidad de la
Data Localization Suite (`…/data-localization/compatibility`).

### Catálogo de imagen

| Operación | Qué hay en Workers AI | Valoración |
|---|---|---|
| Generar | FLUX.1 schnell, FLUX.2 dev, **FLUX.2 klein 4B y 9B** (Black Forest Labs), Lucid Origin y Phoenix 1.0 (Leonardo), SDXL base y lightning, DreamShaper 8 LCM | **Cubre bien**, barato. |
| Editar con referencias | FLUX.2 klein 4B/9B y dev aceptan hasta 4 imágenes de entrada (`input_image_0…3`) y un prompt | **No sirve para fotos de platos**: ver abajo. |
| Inpainting (editar por zonas) | Solo `stable-diffusion-v1-5-inpainting` (beta), **marcado obsoleto con fecha 20/11/2026** | **No**: modelo antiguo y en retirada. |
| Quitar el fondo | Ninguno en el catálogo | **No cubre** (ya se hace en el navegador, gratis). |
| Ampliar (upscale) | Ninguno | **No cubre.** |
| Segmentación | Ninguno | **No cubre.** |

**Por qué la edición con FLUX.2 klein no vale aquí:**
- Las imágenes de entrada deben ser **menores de 512×512** (aviso de cambios de
  la 4B, repetido en la 9B; si es máximo estricto no lo aclara). Una foto de
  plato a ese tamaño pierde casi todo el detalle.
- No hay máscara: la edición es «regenerar con referencia» y el modelo puede
  cambiar el plato. Es peor que GPT Image con máscara (§13), que ya es solo
  orientativa.
- La salida se pide por ancho y alto entre 256 y 1920; no conserva el original.
- Los pasos están fijos en 4 (modelo destilado): rápido, pero sin ajuste fino.

Como edición solo serviría para estilizar o crear variantes desde una
referencia pequeña, no para «cambiar el fondo» ni «mejorar luz» sin tocar el plato.

### Formato de la API (para quien lo retome)

`POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-2-klein-9b`,
`Authorization: Bearer {token}`, **siempre `multipart/form-data`** (aunque solo
haya prompt): `prompt`, `width`/`height` (256–1920), `seed`, `guidance`,
`input_image_0…3`. Respuesta con sobre `{result, success, errors, messages}`; la
imagen sale en base64 (`result.image`). El token necesita los permisos
**Workers AI – Read y Workers AI – Edit**. La documentación de la API REST
**no** documenta un endpoint para listar modelos; si hubiera que implementar
«Probar conexión» gratuita, habría que comprobar si sirve
`GET …/accounts/{id}/ai/models/search` (no confirmado) o verificar el token con
`GET /client/v4/user/tokens/verify`.

### Precios (neuronas)

Gratis: 10.000 neuronas al día (se reinicia a las 00:00 UTC). Por encima, solo
con Workers Paid: **0,011 USD por 1.000 neuronas**.

| Modelo | Neuronas | Equivale a (cálculo propio) |
|---|---|---|
| `flux-1-schnell` | 4,80 por tesela de 512×512 y 9,60 por paso | muy barato |
| `flux-2-klein-4b` | 5,37 por tesela de entrada, 26,05 por tesela de salida | ≈ 0,001 USD por imagen de 1 MP, si la tesela es de 512×512 (no confirmado) |
| `flux-2-klein-9b` | 1.363,64 el primer MP, 181,82 cada MP más y por MP de entrada | **0,015 USD el primer MP**, 0,002 cada MP más |
| `flux-2-dev` | 18,75 por tesela de entrada y paso; 37,50 por tesela de salida y paso | por calcular |
| `lucid-origin` / `phoenix-1.0` | 636 / 530 por tesela de 512×512 | 0,007 / 0,006 USD por tesela |

### Límites y datos

- **Límite de ritmo:** texto a imagen, 720 peticiones por minuto; generación de
  texto, 300 por minuto (20 por minuto los modelos que exigen plan de pago, 50
  con créditos prepagados de AI Gateway). La página no da límites de tamaño.
- **Región: sin garantía de UE.** La tabla de compatibilidad de la Data
  Localization Suite marca Workers AI como **sin Regional Services** (solo con
  Customer Metadata Boundary), y la suite es de pago y Enterprise. Un anuncio de
  «regiones personalizadas» habla de regionalizar la inferencia, pero no hay
  fecha. Aquí valdría `AI_MEDIA_ALLOW_NON_EU=true`, igual que OpenAI sin región
  europea; el adaptador declararía `global`.
- **Datos:** Cloudflare dice que no conserva entradas ni salidas de la
  inferencia estándar y que **no entrena** con el contenido de los clientes
  (`trains_on_inputs: no`, a confirmar en el contrato). Los modelos de BFL
  figuran como «socio, sin retención de datos». Licencias según cada modelo.
- **Obsolescencia:** el único modelo de inpainting ya está retirado a efectos
  prácticos; el catálogo cambia deprisa (esta valoración puede quedar vieja en meses).

### Comparación

| | Workers AI | OpenAI (§13) | ComfyUI en Colab (§11) |
|---|---|---|---|
| Generar | Sí, FLUX.2 klein 9B ≈ 0,015 USD/MP | Sí, ≈ cota 0,07 USD/MP | Sí, FLUX.2 klein 4B, coste = GPU |
| Cambiar el fondo con máscara | **No** | Sí (máscara orientativa) | Sí (grafo propio) |
| Mejorar luz y color | **No** fiable | Sí | Sí |
| Quitar el fondo | No | Sí (PNG transparente) | Sí (nodo propio) |
| Ampliar | No | No | Sí (si se carga el modelo) |
| Región UE | No garantizada | Sí con `eu.api.openai.com` | La que elijas |
| Quién mantiene la GPU | Cloudflare | OpenAI | Tú (sesión de Colab que caduca) |
| Texto | Sí (ver abajo) | Sí | No |

### Conclusión

- **Cubre bien:** generar imagen barata con la misma cuenta que R2 y la API
  estándar de Cloudflare. FLUX.2 klein 4B es el mismo modelo que el cuaderno de
  Colab, ya alojado.
- **No cubre:** quitar el fondo, ampliar, segmentar, inpainting vivo y editar
  fotos de platos sin tocarlos. Para eso siguen OpenAI (con máscara) y ComfyUI.
  Así que **Workers AI no sustituye al Colab** para lo que el dueño necesita
  (ediciones); solo sustituiría la parte de «generar» que ya cubren OpenAI y ComfyUI.
- **Texto:** el catálogo es amplio (Llama 3.3 70B, Gemma 4, GPT-OSS 120B/20B,
  Qwen3, Mistral Small 3.1, EuroLLM 9B y otros, además de DeepSeek, GLM y Kimi).
  Precio en neuronas por millón de tokens, p. ej. `gpt-oss-20b` 18.182 de
  entrada y 27.273 de salida (≈ 0,20 y 0,30 USD) y `llama-3.3-70b` 26.668 y
  204.805 (≈ 0,29 y 2,25 USD). Apuntado como **mejora futura**: un proveedor de
  texto sobre `…/ai/run/@cf/…` (o la ruta compatible con OpenAI de Cloudflare)
  sería sencillo, pero no se ha hecho porque el trabajo pedía imagen y la
  residencia sigue sin garantía.
- **Si se retoma:** reabrir si Cloudflare añade un modelo de edición con
  máscara o admite entradas de tamaño normal; el adaptador seguiría el patrón
  de `openai-image.ts` (multipart con `fetch`, base64 en la respuesta). En
  Integraciones valdría reutilizar `R2_ACCOUNT_ID` si es la misma cuenta y un
  secreto nuevo `CLOUDFLARE_AI_API_TOKEN` (Workers AI Read + Edit).
