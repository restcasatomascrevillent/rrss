# Analítica (Fase 5)

Capturas periódicas de métricas, panel de la marca con dato frente a hipótesis,
informe mensual en PDF sin intervención e interpretación opcional con IA.
Estado a 18/11/2026:

| Qué | Estado |
|---|---|
| Base de datos: catálogo de métricas, series diarias de cuenta y de publicación, registro de capturas, informes y reloj (migraciones `20261119610000` a `20261119630000`) | Implementado y probado en base de datos (PGlite, migraciones reales, vuelta atrás) |
| Capturador (`social-insights` → `_shared/analytics/capture.ts`) | Probado contra la **Graph API simulada** |
| Lectura de métricas de Meta (`_shared/analytics/insights-graph.ts`) | Escrita contra la documentación oficial, **sin probar contra el servicio real**: no hay aplicación de Meta |
| Analista sin IA (`_shared/analytics/analyst.ts`) | Probado (unitarias) |
| Panel «Analítica» de la marca | Probado en componentes (Supabase simulado) |
| Informe mensual: preparación (`social-insights`) y PDF (`worker/`, `media.report.pdf`) | Probado de principio a fin contra las migraciones reales y pdf-lib de verdad; el PDF, también en las pruebas del trabajador |
| Interpretación con IA (`analytics.summary` en `ai-generate`) | Probada con el proveedor simulado; sin proveedor real (como el resto de la IA de texto) |
| Escenario de extremo a extremo `tests/e2e/15-analitica.spec.ts` | Escrito, **sin ejecutar** |
| Facebook | No se mide: las páginas no se conectan todavía (lo dice el panel) |

Aceptación de la fase («las cifras coinciden con las de la red para una cuenta
real; el informe se genera sin intervención»): la segunda parte está probada en
local; la primera solo se puede comprobar con una cuenta real (ver «Activarlo
en staging»).

## 1. Qué se mide

Consultado en la documentación oficial de Meta el 18/11/2026 (Graph API v27.0).
El catálogo vive en la tabla `analytics_metric_definitions` (una fila por
métrica, con su nombre en la API, qué mide, si es estimada, si Meta la marca
«en desarrollo», el retraso y la fuente): cada cifra guardada apunta a su
definición. Cambiar el catálogo es una migración.

**Cuenta de Instagram** (una cifra por día UTC):

| Métrica | En la API | Notas |
|---|---|---|
| Seguidores | campo `followers_count` de la cuenta | Valor en el momento de la captura; la API no da histórico: la serie empieza al conectar la cuenta |
| Alcance | `reach` | Estimación de Meta |
| Visualizaciones | `views` | Sustituye a «impresiones» (no son comparables); «en desarrollo» |
| Cuentas que interactuaron | `accounts_engaged` | Estimación |
| Interacciones | `total_interactions` | Me gusta + guardados + comentarios + compartidos, menos los retirados |
| Me gusta, Comentarios, Guardados, Compartidos | `likes`, `comments`, `saves`, `shares` | `comments` «en desarrollo» |
| Toques en los enlaces del perfil | `profile_links_taps` | |

Se piden con `GET /{ig-user-id}/insights?metric=…&period=day&metric_type=total_value&since=…&until=…`,
un día cada vez. **Sin verificar con una cuenta real**: dónde corta Meta el día
(aquí se pide de 00:00 a 24:00 UTC) y si `until` incluye el segundo final.

**Publicaciones hechas con la plataforma** (las de `scheduled_publications`
publicadas en los últimos 60 días; el valor es el acumulado de la publicación
el día de la captura):

| Métrica | En la API | Imagen/carrusel | Reel |
|---|---|---|---|
| Alcance | `reach` | sí | sí |
| Visualizaciones (en un reel, reproducciones) | `views` | sí | sí |
| Me gusta, Comentarios, Guardados, Compartidos | `likes`, `comments`, `saved`, `shares` | sí | sí |
| Interacciones | `total_interactions` | sí | sí |
| Tiempo medio y total de reproducción | `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time` | — | sí (milisegundos según la documentación, sin comprobar) |

### Lo que no se puede medir (y el panel lo dice)

- **Impresiones**: Meta las retiró (cuenta: 21/04/2025 en todas las versiones;
  publicaciones creadas desde el 02/07/2024).
- **Reproducciones con la medida antigua** (`video_views`, `plays`): retiradas;
  las reproducciones de un reel son `views`.
- **Visitas al perfil**: no figuran entre las métricas de cuenta vigentes.
- **Nuevos seguidores y bajas** (`follows_and_unfollows`) y **datos
  demográficos**: Meta no los da a cuentas con menos de 100 seguidores; no se
  capturan en esta versión (el desglose está sin comprobar).
- **Historias**: la plataforma no las publica y Meta solo da sus métricas 24 h.
- **Cada imagen de un carrusel**: Meta solo da el carrusel entero.
- **Facebook**: las páginas no se conectan todavía.
- **Lo que la red no dé** en una captura concreta (lista vacía, que Meta usa en
  vez de 0): no se guarda nada y queda anotado en la pasada
  (`analytics_capture_runs.unavailable`).
- **Cifras recientes**: provisionales durante 48 h (Meta las corrige); el panel
  las marca.
- **Solo orgánico**: las métricas de publicación no cuentan los anuncios.

## 2. Cómo se captura sin duplicar

1. **Reloj** (`rrss-analytics`, pg_cron, minuto 17 de cada hora):
   `private.analytics_dispatch()` encola un trabajo `analytics.capture` por
   cuenta viva de Instagram y **día** (clave de idempotencia
   `analytics.capture:<cuenta>:<día>`: repetirlo cada hora no crea nada) y, si
   hay trabajos de analítica pendientes, llama a la Edge Function
   `social-insights` con pg_net (Vault: `rrss_project_url`,
   `rrss_service_role_key`, como el publicador).
2. **Captura** (`processCaptureJob`): seguidores; después, día a día, las
   métricas diarias. La primera vez recupera 28 días; después repasa los 3
   últimos días completos (Meta corrige hasta 48 h después). Luego, las
   publicaciones de los últimos 60 días (como mucho 50 por pasada).
3. **Guardado** (`analytics_record_capture`): una fila por cuenta (o
   publicación), métrica y día; una captura nueva del mismo día **actualiza** la
   fila (valor, `captured_at`, `capture_count`, `provisional`) y conserva
   `first_captured_at`. Valida la métrica contra el catálogo, la publicación
   contra la cuenta, la fecha (dos últimos años, no futura) y la cifra (no
   negativa).

Errores y límites:

- Una métrica rechazada por Meta dentro de un lote se pide sola, para no perder
  las demás; la rechazada queda en «no se pudo medir».
- **Límite de llamadas** (Business Use Case de Instagram, «4800 × impresiones»
  en 24 h): se lee `X-Business-Use-Case-Usage`; al pasar del 80 % o ante un
  error de límite (códigos 4, 17, 32, 613, 80000–80099) se guarda lo capturado
  y el trabajo se aplaza sin gastar intento (`analytics_defer_job`: lo que diga
  Meta, mínimo 15 min).
- **Token caducado** (error 190): la cuenta pasa a «hay que volver a
  conectarla» (igual que en la publicación), la pasada queda fallida y no se
  reintenta; no se encolan más capturas de esa cuenta hasta reconectarla.
- Red o 5xx: se guarda lo capturado y la cola reintenta con espera creciente.

## 3. Panel

Marca → **Analítica** (lo ve quien ve la marca). Periodos: últimos 7 o 28 días,
este mes o el anterior, comparados con el periodo anterior de la misma duración.

- Cifras del periodo con su cambio; «Estimación de Meta» y «Provisional» donde
  toca; «N de M días» si faltan días. Sin cifra es «—», nunca 0.
- Evolución diaria de cualquier métrica (los días sin cifra no se dibujan).
- Comparación entre periodos y entre redes (Facebook: «no se conecta todavía»).
- Mejores y peores publicaciones (por interacciones; si no hay, por alcance) y
  medias por formato.
- **Resumen del analista**: «Dato» (cifra medida) y «Hipótesis» (reglas fijas:
  cambio de alcance ≥ 20 % con o sin más publicaciones, diferencia de formato
  ≥ 1,5× con 2 o más de cada, publicación que dobla la mediana, pérdida de
  seguidores), cada hipótesis con los datos en que se apoya; y avisos (pocas
  publicaciones, estimaciones, días sin cifra, días en UTC).
- **Lo que no se puede medir**, última captura e informes.

## 4. Informe mensual en PDF

1. A partir del día 3 de cada mes (para que Meta haya cerrado las cifras del
   último día), el reloj encola el informe del mes anterior de cada marca con
   alguna cuenta social (`analytics_enqueue_monthly_reports`; uno por marca y
   mes). Quien edita la marca puede pedir el de cualquier mes terminado de los
   dos últimos años desde el panel (`request_analytics_report`; nueva versión).
2. `social-insights` lee las cifras (`analytics_report_source`), pasa el
   analista y deja el documento listo (`analytics_report_render`), que encola
   `media.report.pdf` con la salida en `<org>/<marca>/informes/<uuid>.pdf` y el
   logotipo del perfil (primer PNG o JPEG); ambos los fija la base de datos.
3. El **trabajador de medios** dibuja el PDF con **pdf-lib 1.17.1** (licencia
   MIT; dependencias MIT, 0BSD y MIT+Zlib; JavaScript puro, sin binarios; sin
   versiones nuevas desde 2022, estable): portada con los colores (el marcado
   como principal y el siguiente) y el logotipo de la marca, cifras, gráficos de
   barras diarios, mejores y peores publicaciones, datos, hipótesis, avisos y
   lo que no se puede medir. Tipografía Helvetica estándar (admite el español;
   los emojis salen como «?»).
4. Al completarse el trabajo, un disparador da de alta el PDF en la biblioteca
   (carpeta «Informes», tipo documento, procedencia `analytics_report` que solo
   puede poner la base de datos) y el informe queda «Listo». Si el trabajo falla
   del todo, «Falló» con el motivo. Se descarga desde el panel (URL firmada de 1 h).

«Sin intervención» exige que el trabajador de medios esté encendido (su
alojamiento está pendiente de decidir, como para los reels).

## 5. Interpretación con IA

«Interpretar con IA» en el resumen, solo si `VITE_AI_TEXT_ENABLED=true`, la
marca no está en modo agencia y quien mira puede editarla. La función
`ai-generate` (acción `analytics.summary`) lee las cifras **con la identidad del
usuario**, las redacta con el analista y a la IA solo le llegan esos datos
(y el perfil de marca como contexto). La respuesta son hipótesis que citan los
datos en que se apoyan; las que no citan ninguno se descartan. En modo agencia
el servidor responde 409 sin gastar cupo. El informe PDF automático no usa IA.

## 6. Variables y secretos

Ninguna nueva para la captura: usa los secretos del publicador
(`docs/publicacion.md`, sección 5): `META_APP_ID`, `META_APP_SECRET`,
`META_GRAPH_API_VERSION`, `SOCIAL_TOKEN_KEYS`, `SOCIAL_TOKEN_KEY_ID`. Sin claves
de cifrado, `social-insights` no mide (lo deja en el registro) pero sí prepara
informes. En Vault, `rrss_project_url` y `rrss_service_role_key`.

IA de texto: `AI_TEXT_ANALYTICS_SUMMARY_PROVIDER` y `AI_TEXT_ANALYTICS_SUMMARY_MODEL`
(o los generales `AI_TEXT_PROVIDER`/`AI_TEXT_MODEL`), como el resto de tareas
(`docs/ia-texto.md`).

Prueba local: `SOCIAL_E2E_SIMULATED_GRAPH=true` también activa la Graph API
simulada en `social-insights` (responde por publicaciones hechas desde otra
función, porque cada función tiene su simulada en memoria).

## 7. Activarlo en staging

1. Aplicar las migraciones `20261119610000` a `20261119630000` (vuelta atrás en
   `supabase/rollbacks/`).
2. Desplegar `social-insights` (`verify_jwt = false` en `config.toml`).
3. **Permiso nuevo en Meta: `instagram_manage_insights`** (añadido a los que
   pide la conexión). Hay que incluirlo en la configuración de Facebook Login
   for Business y en la revisión de la aplicación, y **volver a conectar** las
   cuentas conectadas antes de este cambio.
4. Trabajador de medios encendido contra staging para los PDF.
5. Prueba de aceptación: con una cuenta real, comparar las cifras de 3 días ya
   cerrados (más de 48 h) y de 2 publicaciones con las de Instagram (Estadísticas
   en la aplicación o Meta Business Suite), anotando la zona horaria de la
   cuenta; comprobar el corte del día y la unidad del tiempo de reproducción.
