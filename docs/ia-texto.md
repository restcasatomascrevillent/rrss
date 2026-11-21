# IA de texto: adaptadores, tareas y función `ai-generate`

Estado a 17/11/2026. **Nada de esto se ha probado contra un proveedor real**: no
hay cuentas ni claves. Todo está probado con el proveedor simulado y con
respuestas HTTP simuladas. Tampoco hay pantallas: es la parte de servidor.

| Pieza | Estado |
|---|---|
| Servicio (reservar cupo → generar → registrar), salida estructurada validada, modelo por tarea | Implementado y probado con la base de datos real y el proveedor simulado |
| Adaptadores Vertex AI (UE), Anthropic directo, Mistral, OpenAI (UE con `eu.api.openai.com`), Bedrock (UE) | Implementados; **sin probar contra el servicio real** (solo HTTP simulado) |
| Tareas: texto de publicación, propuesta de perfil, comprobación de marca | Implementadas y probadas con el proveedor simulado. **La calidad de los textos no se ha medido** con ningún modelo |
| Lógica de `ai-generate` (`handler.ts`) | Probada en Node con la base de datos real |
| Arranque de `ai-generate` en Deno (`index.ts`) | Ejecutado **solo en local** (`supabase functions serve`, edge-runtime 1.74) con el proveedor simulado de pruebas locales, en la prueba de extremo a extremo de la Fase 2. **Sin desplegar** |
| Interfaz (redactar en el editor, comprobar tono, proponer perfil desde fuentes de texto, consumo de IA, cupo en Plataforma) | Probada con Supabase simulado (componentes) y de extremo a extremo en local con el proveedor simulado |

## 1. Dónde está cada cosa

```
supabase/functions/_shared/ai/
  contract.ts            contrato (ampliado: esquema de salida, material estable, propósitos)
  service.ts             reservar → generar → validar → registrar
  schema.ts              validación propia de JSON Schema y versión «para el proveedor»
  simulated-provider.ts  solo para pruebas
  text/
    config.ts            variables de entorno → adaptadores, modelos y precios
    http.ts              llamada HTTP común y traducción de errores
    prompt.ts            material delimitado y cota de consumo
    anthropic-messages.ts  formato de la API de mensajes (común a los tres de Claude)
    vertex.ts  google-auth.ts   Claude por Vertex AI (token de cuenta de servicio)
    anthropic.ts                Claude por la API directa
    bedrock.ts  sigv4.ts        Claude por Amazon Bedrock (firma SigV4)
    mistral.ts                  Mistral
    openai.ts                   OpenAI (Chat Completions, endpoint de la UE configurable)
    tasks/               post-copy.ts · profile-proposal.ts · brand-check.ts · shared.ts
supabase/functions/ai-generate/
  handler.ts             lógica (sin Deno, probada)
  index.ts               arranque en Deno: cliente de Supabase y variables
```

Imagen y vídeo viven en `_shared/ai/media/` y no forman parte de este documento.

## 2. Adaptadores

Todos con `fetch` puro, sin SDK. Ninguno está elegido por defecto: se elige por
configuración (apartado 3).

| Adaptador (`id`) | Punto de entrada | Autenticación | Datos en la UE |
|---|---|---|---|
| `anthropic-vertex` | `https://aiplatform.eu.rep.googleapis.com/v1/projects/{proyecto}/locations/eu/publishers/anthropic/models/{modelo}:rawPredict` | Token OAuth de una cuenta de servicio (JWT RS256 firmado con Web Crypto) | Sí con `eu` (multirregión) o una región `europe-…`. El adaptador rechaza cualquier otra ubicación |
| `anthropic` | `https://api.anthropic.com/v1/messages` | Cabecera `x-api-key` | **No**: la API directa solo admite `us` o `global`. No se carga salvo aceptación expresa |
| `mistral` | `https://api.mistral.ai/v1/chat/completions` | `Authorization: Bearer` | Empresa europea; **dónde procesa no consta** en las páginas consultadas |
| `openai` | `{OPENAI_BASE_URL}/v1/chat/completions` (por defecto `https://api.openai.com`; para la UE, `https://eu.api.openai.com`) | `Authorization: Bearer` (+ `OpenAI-Organization` y `OpenAI-Project` opcionales) | Solo con un proyecto creado con región Europa **y** el endpoint `eu.api.openai.com`. Con otra dirección no se carga salvo aceptación expresa |
| `anthropic-bedrock` | `https://bedrock-mantle.{región}.api.aws/anthropic/v1/messages` | SigV4 (servicio `bedrock-mantle`) o token de Bedrock en `x-api-key` | Sí si la región es `eu-…` y el modelo no usa el enrutado `global.`; el adaptador rechaza lo demás |

Lo que hacen todos:

- **Salida estructurada** con el mecanismo nativo (`output_config.format` en
  Claude, `response_format: json_schema` con `strict` en Mistral y OpenAI). Al proveedor
  se le envía el esquema sin las restricciones que no admite (`minLength`,
  `maxItems`…); el servicio valida después con el esquema completo. Un rechazo
  o un corte por longitud no cumplen el esquema: se registran con su coste y la
  petición falla con `refused` o `invalid_output`.
- **Caché de prompts**: el material estable (el perfil de marca) va primero. En
  Claude su último bloque lleva `cache_control` (5 minutos); en Mistral se envía
  `prompt_cache_key`. El prefijo guardado es «instrucciones de la tarea +
  perfil», así que la caché es por tarea, marca y modelo. Si el prefijo no llega
  al mínimo del modelo, el proveedor no lo guarda y no avisa.
- **Recuento de tokens**: el consumo real sale de la respuesta, con la caché
  separada. Antes de llamar se reserva una cota superior calculada sin red (un
  token cada 2,5 caracteres más un margen). El adaptador directo de Anthropic
  ofrece además el recuento exacto (`count_tokens`), que el servicio no usa.
- **Coste** = consumo × tabla de precios (configuración). Unidades:
  `input_tokens`, `output_tokens`, `cache_read_input_tokens` y, en Claude,
  `cache_write_input_tokens`. Sin precio completo, el servicio no genera.
- **Errores**: 429 → `rate_limited` (reintentable); 5xx y 529 → reintentable;
  401/403 → `auth`; otros 4xx → `invalid_request`; sin red → `network`; tiempo
  agotado → `timeout`; respuesta ilegible → `bad_response`. Un fallo del
  proveedor no consume cupo. Los mensajes guardados no llevan claves.
- No se envían parámetros de muestreo (`temperature`…): la versión de la API de
  Anthropic `2026-10-21` los rechaza. El razonamiento del modelo se factura como
  salida, dentro de `max_tokens`.

### Pendiente de confirmar con la primera llamada real

- **Vertex**: el ámbito OAuth (`…/auth/cloud-platform`, no figura en las páginas
  consultadas), la forma del cuerpo de los errores y qué modelos hay en la
  multirregión `eu` de la cuenta. Multirregión y regional cuestan un 10 % más
  que el punto global: ajustar la tabla de precios. Google recomienda la
  federación de identidades en vez de guardar una clave de cuenta de servicio;
  no está implementada.
- **Bedrock**: con qué identificador de modelo (o perfil de inferencia EU) se
  sirve dentro de la UE desde el punto `bedrock-mantle`. El token de Bedrock
  caduca a las 12 horas: en un servidor, usar claves de IAM.
- **OpenAI**: nada probado con cuenta real. Falta confirmar: que el proyecto de
  la organización es elegible para residencia en Europa (hay que contactar con
  ventas de OpenAI), que los modelos elegidos están en la lista de residencia UE,
  que los esquemas de las tareas (campos opcionales, `enum`) los acepta el modo
  `strict`, y cuántos tokens de razonamiento gasta cada modelo dentro de
  `max_completion_tokens` (si se queda corto, la salida se corta con `length`).
- **Mistral**: cuerpo de los errores que no son 422, qué modelos admiten
  `strict`, duración de la caché y dónde se procesan los datos.
- **Todos**: la calidad en español, los límites de uso de cada cuenta y los
  mínimos reales para que la caché se active.

## 3. Configuración (variables de entorno de la función)

**Desde la interfaz:** un superadministrador puede meter todo esto en
**Plataforma → Integraciones → IA de texto** (proveedor y modelo de todas las
tareas o de cada una, cuenta de servicio de Vertex en JSON, claves de Anthropic,
Mistral y OpenAI, credenciales de Bedrock, tabla de precios, criterio de datos y tiempo
máximo). Los secretos se guardan cifrados en Supabase Vault (migración
`20261120010000`) y no se vuelven a ver; cada ajuste se llama como su variable
y manda sobre ella. `ai-generate` los lee en cada petición (caché de 30 s), sin
redesplegar. «Probar conexión» lista los modelos (Anthropic, Mistral, OpenAI, Bedrock)
o pide un token de acceso con la cuenta de servicio (Vertex): no genera texto ni
gasta cupo. La interfaz enseña la IA de texto si `VITE_AI_TEXT_ENABLED=true` en
el despliegue **y** alguna tarea tiene proveedor cargado y precio completo.

**O como variables.** Solo nombres en `.env.example`. Son secretos de la
función; nunca `VITE_`.

| Variable | Para qué |
|---|---|
| `AI_TEXT_PROVIDER`, `AI_TEXT_MODEL` | Adaptador y modelo de todas las tareas de texto |
| `AI_TEXT_POST_CAPTION_PROVIDER` / `_MODEL` | Solo para redactar publicaciones |
| `AI_TEXT_PROFILE_PROPOSAL_PROVIDER` / `_MODEL` | Solo para proponer el perfil |
| `AI_TEXT_BRAND_CHECK_PROVIDER` / `_MODEL` | Solo para la comprobación de marca |
| `AI_TEXT_CAMPAIGN_PLAN_PROVIDER` / `_MODEL` | Solo para el plan de campaña (`campaign.plan`) |
| `AI_TEXT_EDITOR_COPILOT_PROVIDER` / `_MODEL` | Solo para el copiloto por voz del editor (`editor.copilot`, `docs/copiloto-voz.md`) |
| `AI_PRICES` | Tabla de precios en JSON |
| `AI_TIMEOUT_MS` | Tiempo máximo de la llamada (por defecto, 60 s) |
| `AI_ALLOW_NON_EU_PROCESSING` | `true` acepta procesar fuera de la UE |
| `AI_ALLOWED_ORIGIN` | Origen permitido para CORS |
| `AI_VERTEX_PROJECT_ID`, `AI_VERTEX_LOCATION`, `AI_VERTEX_SERVICE_ACCOUNT_JSON` | Vertex: proyecto, ubicación (`eu`) y el JSON de la cuenta de servicio |
| `ANTHROPIC_API_KEY` | Anthropic directo (además exige `AI_ALLOW_NON_EU_PROCESSING=true`) |
| `AI_E2E_SIMULATED_PROVIDER` | **Solo pruebas locales.** `true` usa el proveedor simulado de `text/local-test.ts`; exige además que `SUPABASE_URL` sea local (`http` y host `127.0.0.1`, `localhost` o `kong`). En otro entorno la función no arranca. Va en `supabase/functions/e2e.env` |
| `MISTRAL_API_KEY` | Mistral |
| `OPENAI_API_KEY` | OpenAI (secreto) |
| `OPENAI_BASE_URL` | OpenAI: dirección de la API. Para la UE, `https://eu.api.openai.com` (sin ella, `api.openai.com`, que exige `AI_ALLOW_NON_EU_PROCESSING=true`) |
| `OPENAI_ORGANIZATION`, `OPENAI_PROJECT` | OpenAI: cabeceras opcionales de organización y proyecto |
| `AI_BEDROCK_REGION` y `AI_BEDROCK_ACCESS_KEY_ID` + `AI_BEDROCK_SECRET_ACCESS_KEY` (+ `AI_BEDROCK_SESSION_TOKEN`), o `AI_BEDROCK_BEARER_TOKEN` | Bedrock |

### OpenAI: residencia en la UE y precios

Fuentes consultadas el **20/11/2026**:
<https://developers.openai.com/api/docs/guides/data-residency> y
<https://developers.openai.com/api/docs/pricing>.

- **Residencia.** Hay que ser elegible (contactar con ventas de OpenAI), crear un
  proyecto con región Europa en «Data and inference residency» (no se puede
  cambiar después), crear una clave de ese proyecto y usar
  `OPENAI_BASE_URL=https://eu.api.openai.com`. Chat Completions admite
  almacenamiento y proceso en la UE; no se puede enviar `store=true` (el
  adaptador no lo envía nunca). Según OpenAI, **el esquema de la salida
  estructurada cuenta como dato de sistema y queda fuera de la residencia**: no
  debe llevar datos personales (los de las tareas no los llevan). El adaptador
  solo se carga con `eu.api.openai.com`; con `api.openai.com` u otra dirección
  hace falta `AI_ALLOW_NON_EU_PROCESSING=true`. «Probar conexión» llama a
  `GET /v1/models` en la dirección configurada.
- **Recargo.** Los endpoints de residencia cuestan un **10 % más** en los modelos
  publicados desde el 05/03/2026: multiplicar los precios de la tabla por 1,10.
- **Precios (USD por millón de tokens, nivel Standard, contexto ≤ 272 K)**, ya
  sin el recargo; la caché de entrada se factura como «cached input» y no hay
  recargo por escribirla:

| Modelo | Entrada | Entrada en caché | Salida | Con recargo UE (entrada / caché / salida) |
|---|---|---|---|---|
| `gpt-6-luna` | 0,10 | 0,01 | 0,50 | 0,11 / 0,011 / 0,55 |
| `gpt-6.1-terra` | 1,00 | 0,05 | 5,00 | 1,10 / 0,055 / 5,50 |
| `gpt-6.1-sol` | 2,00 | 0,10 | 10,00 | 2,20 / 0,11 / 11,00 |
| `gpt-6.2-sol` | 2,00 | 0,10 | 10,00 | 2,20 / 0,11 / 11,00 |
| `gpt-6.2-astra` | 8,00 | 0,40 | 40,00 | 8,80 / 0,44 / 44,00 |
| `gpt-5.4-mini` | 0,75 | 0,075 | 4,50 | 0,825 / 0,0825 / 4,95 |

  La página no da fecha de los precios Standard y OpenAI los cambia: revisarlos
  antes de activar. No se han fijado en código; van en `AI_PRICES`, por ejemplo
  para el copiloto con el recargo de la UE (el adaptador no usa
  `cache_write_input_tokens`):

```json
{ "openai/gpt-6.1-terra": { "input_tokens": 1.1, "output_tokens": 5.5, "cache_read_input_tokens": 0.055 } }
```

- **Recomendación para el copiloto** (`editor.copilot`: instrucciones cortas y
  esquema de operaciones, muchas llamadas): `gpt-6.1-terra` como modelo
  principal; `gpt-6-luna` si la calidad medida basta y se quiere bajar el coste
  unas 10 veces. Sin medir con el modelo real: la calidad es una suposición.
  Comprobar antes que el modelo figura en la lista de residencia UE de OpenAI.

Formato de `AI_PRICES` (un micro por token = una unidad de moneda por millón de
tokens; los números de este ejemplo son inventados):

```json
{ "anthropic-vertex/<modelo>": { "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_write_input_tokens": 0 } }
```

Reglas:

- Sin `AI_TEXT_*` no hay IA: no existe modelo por defecto.
- Un adaptador sin sus credenciales no se carga y la tarea falla diciendo qué
  falta. **Nunca se sustituye por otro ni por el simulado**: el simulado no se
  puede elegir con `AI_TEXT_*`. La única vía es `AI_E2E_SIMULATED_PROVIDER`,
  limitada a un Supabase local.
- Los avisos de configuración van al registro del servidor con nombres de
  variables, nunca con valores. Al navegador solo llega «la IA no está
  disponible».

## 4. Tareas

Las instrucciones de cada tarea son texto fijo del producto. Todo lo que escribe
un cliente (perfil, encargo, fuentes, texto a comprobar) viaja como material
delimitado y se trata como dato.

| Tarea (`purpose`) | Entra | Sale |
|---|---|---|
| `post.caption` | Perfil de marca, encargo breve, red con sus límites (dato) y número de variantes (1–5) | Variantes con texto, etiquetas, longitud medida (en unidades UTF-16, ver abajo) y `withinLimits`. No se recortan |
| `profile.proposal` | Texto ya extraído de las fuentes (hasta 20 fuentes y 400.000 caracteres) y, si existe, el perfil actual | Una **propuesta** con la forma del perfil y notas para quien revisa. No guarda nada |
| `brand.check` | Perfil de marca y el texto | Veredicto por criterio (`tone`, `banned_topics`): `pass`, `fail` o `uncertain`, con explicación y citas. Global: `pass`, `fail` o `review` |
| `campaign.plan` | Perfil de marca, instrucción («prepara la semana que viene»), fechas (1–63 días), destinos (red/formato del catálogo), descripción de hasta 60 recursos de la biblioteca y hasta 5 fuentes de texto (60.000 caracteres) | Una **propuesta** de plan: objetivo, resumen, razonamiento (observado / respaldado por datos / hipótesis, con nota sobre los datos) y piezas (red, formato, fecha, idea, pie de borrador, etiquetas, recursos sugeridos, por qué). No guarda nada |
| `editor.copilot` | Perfil de marca, lo dictado (hasta 2000 caracteres), resumen del documento (lienzo y capas) y hasta 10 fotos elegidas | Operaciones de editor de una lista cerrada, saneadas (textos solo dictados, fotos y logotipos permitidos, colores y tipografías de la marca) y lo descartado con su motivo. Se admite en modo agencia (provisional). Detalle en `docs/copiloto-voz.md` |

**Unidad de los límites de texto.** Todo el producto cuenta en unidades UTF-16:
el contador del editor, la ventana «Redactar con IA», el verificador de marca y
esta tarea. Si una red dice «caracteres» sin precisar, se toma UTF-16 porque es
la cuenta más estricta (un emoji puede contar 2): nunca se da por bueno un texto
que la red pudiera rechazar. La correspondencia está en
`src/features/content/textUnits.ts` y la vigila `textUnits.test.ts`.

En la comprobación de marca el veredicto global lo calcula el producto (fallo >
duda > visto bueno). Un `fail` sin una cita que esté en el texto se rebaja a
duda. `review` significa «que lo revise una persona». La tarea nunca aprueba una
pieza. Las reglas literales (longitud, expresiones exactas) no son de esta
tarea: van en el verificador sin IA.

### Plan de campaña (`campaign.plan`) y defensa ante instrucciones maliciosas

La tarea solo propone; quien actúa es el motor de campañas
(`src/features/campaigns/engine.ts` + `accept_campaign_plan`, ver
`docs/02-modelo-de-datos.md` §13), que solo sabe crear borradores.

- **Instrucciones fijas** (mensaje de sistema): texto del producto que dice que
  la respuesta es una propuesta y que no aprueba, programa ni publica. Lo que
  escribe el cliente (perfil, instrucción, fuentes, nombres de archivos de la
  biblioteca) viaja como material delimitado; un cierre `</material>` dentro
  del material se neutraliza. El prompt solo lleva datos validados (fechas
  reales, identificadores de red y formato con formato fijo, un número).
- **Esquema cerrado** y validado entero: sin campos de «acciones» ni de estado.
  Un modelo que añada `approve` o `publish` produce `invalid_output` y no se
  guarda nada.
- **Saneado determinista** (`sanitizePlan`): se descartan las piezas en redes o
  formatos no pedidos, fuera de fechas o de más sobre el máximo (por defecto,
  una cada dos días, hasta 30), y los recursos que no estaban en la biblioteca
  enviada. La respuesta dice qué se descartó y por qué.
- **Sin datos no hay «respaldado por datos»**: mientras la plataforma no tenga
  analítica (Fase 5), lo que el modelo ponga ahí pasa a hipótesis y el plan lo
  dice (`NO_DATA_NOTE`).
- El simulado de pruebas locales construye el plan a partir de la instrucción
  y del perfil, y además **imita a un modelo comprometido**: si algún material
  contiene «ignora lo anterior», añade una pieza que obedece (otra red, fuera de
  fechas, «APROBADO»). La prueba de extremo a extremo comprueba que el producto
  la descarta y que todo lo creado son borradores.

Probado con el proveedor simulado y la base de datos real
(`tests/db/campanas.test.ts`); **sin probar contra un proveedor real** ni medida
la calidad de los planes.

## 5. Función `ai-generate`

`POST /functions/v1/ai-generate` con la sesión del usuario en `Authorization`.

```json
{ "action": "post.caption", "brandId": "<uuid>",
  "input": { "brief": "…", "network": { "id": "instagram", "name": "Instagram", "maxChars": 2200, "maxHashtags": 30, "notes": ["…"] }, "variants": 3 } }
{ "action": "brand.check", "brandId": "<uuid>", "input": { "text": "…" } }
{ "action": "profile.proposal", "brandId": "<uuid>", "input": { "sources": [{ "title": "Manual.pdf", "text": "…" }] } }
{ "action": "campaign.plan", "brandId": "<uuid>",
  "input": { "instruction": "Prepara la semana que viene", "startDate": "2026-11-23", "endDate": "2026-11-29",
             "targets": [{ "network": "instagram", "format": "post" }],
             "assets": [{ "id": "<uuid>", "name": "guiso.jpg", "kind": "image", "tags": ["otoño"] }],
             "sources": [{ "title": "Horario.txt", "text": "…" }] } }
```

El perfil de marca lo lee la función con la identidad del usuario (RLS); el
navegador no lo envía.

Respuesta 200: `{ action, generationId, … }` con el resultado de la tarea
(apartado 4). No incluye proveedor, modelo ni coste: están en `ai_generations`.

Errores: `{ "error": { "code", "message", "retryable", "generationId"? } }`.

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `invalid_request` | Petición mal formada o incompleta |
| 401 | `unauthenticated` | Sin sesión o caducada |
| 402 | `quota_exhausted`, `quota_missing` | Cupo agotado o sin asignar (mensaje del cupo, sin cifras) |
| 403 | `forbidden` | No puede crear contenido en la marca |
| 404 | `brand_not_found` | La marca no existe o no la ve |
| 409 | `brand_profile_missing` | La marca no tiene perfil (salvo en `profile.proposal`) |
| 422 | `refused` | El modelo se negó (coste registrado) |
| 502 | `provider_failed`, `invalid_output` | Falló el proveedor (sin coste) o respondió algo inservible (con coste) |
| 503 | `not_configured` | IA sin configurar |
| 504 | `provider_timeout` | El proveedor no respondió a tiempo |

El permiso de crear contenido lo impone la base de datos al reservar el cupo
(`ai_reserve_generation`), antes de llamar a ningún proveedor. Una petición es
una sola llamada al proveedor: no hay bucles ni reintentos dentro de la función.

## 6. Fuera de este bloque

Pantallas; extracción de texto de PDF y webs; guardar la propuesta de perfil;
reintentos y modelo alternativo; lotes; límite de frecuencia por usuario;
valoración de resultados; búsqueda por vectores; registro de modelos en base de
datos (hoy es configuración de la función).
