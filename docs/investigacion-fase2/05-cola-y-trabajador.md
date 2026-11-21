# 05 · Cola de trabajos y alojamiento del trabajador de medios (Fase 2)

Fecha de la investigación: 16/11/2026. Cada cifra lleva su fuente [n] (lista al final). «Sin verificar» = no hay fuente oficial leída en esta sesión. Las duraciones de trabajo del cálculo de costes son **supuestos míos**, no medidas.

## 1. Resumen y recomendación

1. **Mantener la tabla `jobs` propia en Postgres.** No migrar a pgmq (sección 3).
2. **Dos clases de trabajo.** Texto IA, webhooks y sondeo de proveedores de vídeo: Edge Functions de Supabase (ya en la UE). Imagen propia y todo FFmpeg: un **contenedor Node + FFmpeg en la UE**, fuera de las Edge Functions, que no pueden con vídeo de 200 MB.
3. **Alojamiento recomendado: Fly.io en `fra` (Frankfurt), máquinas bajo demanda.** Una máquina parada solo cuesta el disco raíz [4]. Se despierta con un POST HTTP desde `pg_net` y consume `claim_jobs` en bucle hasta vaciar la cola. Coste estimado: unos 2 USD/mes de cómputo.
4. **Alternativa más simple, más cara:** worker siempre encendido en Render Frankfurt (25 USD/mes) o Railway Amsterdam. **Plan B si no se quiere otra cuenta:** Vercel Sandbox en `fra1`, o Cloud Run Jobs en `europe-west*`.
5. **Orquestadores gestionados (Trigger.dev, Inngest, Upstash, Temporal, Vercel Workflow): no hacen falta ahora.** Duplicarían el estado de la cola que ya existe. Trigger.dev es el único que ejecuta FFmpeg él mismo, pero su residencia de datos en la UE no está confirmada.
6. **Plan Supabase: Pro (25 USD/mes) obligatorio.** En Free el límite de archivo es 50 MB [8]; para vídeos de 200 MB hay que estar en Pro.

## 2. Límites reales de funciones (qué cabe)

| Plataforma | Duración | CPU / memoria | Tamaño | Fuente |
|---|---|---|---|---|
| Edge Functions Supabase | Reloj de pared: 150 s Free, 400 s de pago. Sin respuesta en 150 s: 504 | **CPU 2 s por petición** (sin contar E/S asíncrona); **memoria 256 MB** | Bundle 20 MB (CLI) o 5 MB (servidor). **Límite de cuerpo de petición/respuesta: la página no lo dice (sin verificar)** | [1] |
| Tareas en segundo plano (Edge) | `EdgeRuntime.waitUntil`; sujetas a los mismos límites de reloj/CPU/memoria. Hay evento `beforeunload` para guardar estado | igual | — | [2] |
| FFmpeg WASM en Edge | **No hay fuente oficial ni caso documentado.** ffmpeg.wasm carga el archivo entero en memoria; con 256 MB y 2 s de CPU no es viable para 200 MB (inferencia) | | | [1], búsqueda |
| Vercel Functions (Fluid) | Hobby 300 s. Pro/Ent: 300 s por defecto, **800 s máximo**, 1800 s en beta | 2 GB/1 vCPU (Hobby); hasta 4 GB/2 vCPU (Pro) | **Cuerpo petición/respuesta 4,5 MB** (no aplica a streaming); paquete 250 MB sin comprimir | [3] |
| Vercel: región | Una región por defecto (`iad1`), configurable; varias solo en Pro/Ent | | | [3] |
| AWS Lambda | 900 s | hasta 10.240 MB; `/tmp` 512 MB–10.240 MB | 6 MB síncrono; imagen de contenedor 10 GB | [17] |

**Qué cabe en Edge Functions:** llamadas a IA de texto (esperan E/S, poca CPU), lanzar generación de imagen o vídeo y recibir su webhook, sondeo corto, firmar URLs. **No caben:** FFmpeg, composición de vídeo, y cualquier cosa que cargue 200 MB en memoria. La generación de imagen cabe si el proveedor devuelve una URL y la función solo copia el archivo con streaming (inferencia: no hay cifra oficial del límite de red).
**Vercel Functions** serviría para recortes cortos con `ffmpeg-static` (800 s en Pro), pero el límite de 4,5 MB de cuerpo obliga a pasar por Storage con URL firmada, y `/tmp` de Vercel **no lo he verificado**. Se descarta como trabajador principal.

## 3. Opciones dentro de Supabase

| Mecanismo | Qué aporta | Límites documentados | Fuente |
|---|---|---|---|
| `pg_cron` | Programa SQL o HTTP; mínimo 1 s | Recomendado ≤ 8 jobs concurrentes y ≤ 10 min cada uno (recomendación, no tope) | [5] |
| `pg_net` | HTTP asíncrono desde SQL/triggers; se envía **tras el commit** | ~200 req/s fiables; timeout por defecto **2.000 ms**; respuestas 6 h en `net._http_response`; tablas unlogged | [6] |
| Database Webhooks | Trigger + `pg_net` por INSERT/UPDATE/DELETE, payload `record`/`old_record` | La clave secreta puede verse en `net.http_request_queue` y en volcados si se crea desde el panel; guardar URL y clave en Vault | [7] |
| Supabase Queues (pgmq) | Entrega con ventana de visibilidad, archivo, RLS; API `read(vt,n)`, `pop`, `archive`, `delete`, `send_batch` | La doc no menciona reintentos con espera ni cancelación | [9], [10] |
| Realtime | Avisar a la interfaz | Pro incluye 500 conexiones pico y 5 M mensajes; mensaje máx. 3 MB | [11] |

**¿Migrar a pgmq? No.** Tu `jobs` ya tiene reserva con caducidad, reintentos con espera creciente y `cancel_job`. pgmq da visibilidad y archivo, pero la doc consultada no recoge backoff ni cancelación, y habría que reescribir las 5 funciones sin ganar nada. Revisar solo si `jobs` llega a decenas de miles de filas/día.
**Patrón de disparo recomendado:** trigger `AFTER INSERT` en `jobs` que llama con `pg_net` al trabajador (despertar) + un `pg_cron` cada minuto de red de seguridad que reencola los vencidos y vuelve a despertar. Como `pg_net` solo envía tras el commit y su cola es unlogged, **el cron es obligatorio** (se puede perder una llamada).
**Interfaz:** suscribir la UI a cambios de `jobs` filtrados por marca (Realtime) con RLS; si falla, sondeo cada 5–10 s. Detalle de publicación y RLS de Realtime: no verificado aquí.

## 4. Dónde alojar el trabajador con FFmpeg

| Opción | Región UE | Precio con poco uso / ¿escala a 0? | Tiempo y disco | Despliegue y acceso | Fuente |
|---|---|---|---|---|---|
| **Fly.io** | `fra`, `ams`, `lhr`, `cdg`, `arn` | Facturación por segundo; máquina parada solo 0,15 USD/GB-mes de disco raíz; shared-cpu-2x 2 GB 13,39 USD/mes encendida; RAM extra 6 USD/GB-mes; salida UE 0,02 USD/GB; entrada gratis. Escala a 0 con autostop/autostart (arranque ≥ 2 s) o suspend (cientos de ms) | Tope de duración y tamaño de rootfs: **sin verificar** | Imagen Docker; despliegue desde GitHub Actions **sin verificar** (flyctl). Las máquinas no se crean solas: número fijo, el proxy las arranca/para | [4], [12], [13] |
| **Railway** | EU West Amsterdam | Hobby 5 USD (incluye 5 USD de uso); 20 USD/vCPU-mes, 10 USD/GB RAM-mes, salida 0,05 USD/GB. Escala a 0 y cron: **sin verificar** | Efímero 100 GB; volumen 5 GB (Hobby) | Despliegue desde GitHub (conocido, sin fuente leída) | [14], [15] |
| **Render** | Frankfurt | Workspace Hobby 0 / Pro 25 USD; worker 1 CPU 2 GB 25 USD/mes siempre encendido; cron por minuto (0,00058 USD/min con 1 CPU 2 GB), mínimo 1 USD/mes, máx. 12 h; salida 5 GB (Hobby) / 25 GB (Pro) y 0,15 USD/GB extra; disco 0,25 USD/GB-mes | Workflows: tareas hasta 24 h, 0,20 USD/h CPU activa + 0,05 USD/GB-h; región de Workflows **sin verificar** | Git conectado | [16], [18] |
| **Cloudflare Containers** | **Sin verificar** (no hay selección de región documentada) | Workers Paid 5 USD/mes con consumo incluido; CPU 0,000020 USD/vCPU-s, memoria 0,0000025 USD/GiB-s; salida 1 TB incluido UE/NA | Máx. 4 vCPU, 12 GiB, **20 GB de disco** | Beta/sleep: sin verificar | [19], [20] |
| **Google Cloud Run Jobs** | Regiones europeas (nivel de precio de `europe-west1`/`west4`: **sin verificar**) | Jobs: 0,000018 USD/vCPU-s y 0,000002 USD/GiB-s; gratis 240.000 vCPU-s y 450.000 GiB-s/mes (cifras de resultado de búsqueda sobre la página oficial; la página no se cargó) | Tarea por defecto 10 min, **máx. 168 h** | Requiere autenticar con Google (cuenta de servicio) desde Supabase: más pieza | [21], [22] |
| **AWS Lambda** | Sí (Irlanda, Frankfurt…) | Pago por uso; precio por GB-s **sin verificar** | 15 min; `/tmp` hasta 10 GB; imagen 10 GB | IAM + ECR + invocación firmada | [17] |
| **AWS Fargate** | Sí | x86 (EE. UU. este): 0,0405 USD/vCPU-h, 0,0044 USD/GB-h; 20 GB de disco gratis; mín. 1 min. Tarifas UE: sin verificar | Sin tope de duración documentado | ECS + red + ECR: la más compleja | [23] |
| **Modal** | **Sin verificar** | Starter: 30 USD de crédito/mes; 0,0000131 USD/core-s, 0,00000222 USD/GiB-s; selección de región ×1,15–1,75 | Tiempo máx.: sin verificar | Python primero | [24] |
| **Hetzner (VPS)** | Falkenstein, Núremberg, Helsinki | Desde 5,49 EUR/mes + IVA; siempre encendido; tráfico «generoso» (TB sin verificar) | Disco del VPS | Tú mantienes SO, Docker, parches, copias | [25] |
| **Vercel Sandbox** | `fra1`, `cdg1`, `dub1`, `lhr1`, `arn1` | Pro: 0,128 USD/h CPU activa + 0,0212 USD/GB-h + 0,60 USD/M creaciones (tarifas en `iad1`; **tarifa UE sin verificar**); 20 USD/mes de crédito Pro; Hobby: 5 h CPU, 45 min máx. | Hasta 24 h (Pro), 8 vCPU/16 GB, **disco 64 GB** | SDK desde una función de Vercel | [26], [27] |

**Seguridad de acceso a Supabase (válido para todas):** las claves viven como secreto de la plataforma (Fly secrets, etc.). Para el trabajador es mejor **un rol de Postgres limitado** (solo `EXECUTE` sobre `claim_jobs`, `complete_job`, `fail_job` y acceso a Storage por URL firmada) que la clave secreta general, que salta RLS [28]. Si usa la clave secreta, el worker debe validar siempre el `marca_id` de cada trabajo contra la ruta de Storage. Supabase no ofrece lista blanca de IP en la API pública (no verificado). Nombres de secretos: no pueden empezar por `SUPABASE_` en Edge Functions [28].

## 5. Orquestadores gestionados

| Servicio | Precio | UE | ¿Ejecuta FFmpeg? | Encaje con cola Postgres | Fuente |
|---|---|---|---|---|---|
| Trigger.dev | Free 0 USD (5 USD crédito, 20 runs concurrentes); Hobby 10 USD; Pro 50 USD. Cómputo 0,0000338 USD/s (0,5 vCPU/0,5 GB) a 0,00034 USD/s (4 vCPU/8 GB) + 0,000025 USD por run | Región de ejecución `eu-central-1`; **datos de runs en EE. UU. según un post de feedback antiguo, sin verificar**. Self-host posible | **Sí**: extensión `ffmpeg()`; 10 GB de disco por máquina; sin duración máxima | Cola paralela: habría que crear un run por fila de `jobs` | [29], [30], [31], [32] |
| Inngest | Free 50k ejecuciones; Pro desde 99 USD/mes (1 M); eventos 256 KiB (Free) / 3 MiB | **Sin verificar** | No: llama a tus funciones (Vercel), heredan sus 800 s | Mala: duplica estado | [33] |
| Upstash Workflow / QStash | Free 1.000 pasos/día; PAYG 1 USD/100k pasos; mensaje 10 MB; respuesta HTTP hasta 2 h (PAYG) | **Sin verificar** | No | Útil solo para despertar/reintentar | [34] |
| Temporal Cloud | PAYG sin cuota base, acciones 50 USD/M; Business mínimo 500 USD/mes | **Sin verificar** | No (tú alojas workers) | Excesivo | [35] |
| Vercel Workflow | 0,02 USD/1.000 eventos; 0,50 USD/GB escrito; sin límite de duración de run; cada paso limitado por Functions (800 s Pro) | Región de la función | No (paso = función; ver sección 2) | Estado propio; duplica `jobs` | [36] |

**Veredicto:** con una cola ya hecha y un equipo de una o dos personas, un orquestador añade una segunda fuente de verdad. Solo Trigger.dev resuelve FFmpeg sin servidor propio; ponerlo en revisión si el mantenimiento del contenedor pesa más que ~10–50 USD/mes.

## 6. Servicios de procesado de medios

| Servicio | Precio | Encaje |
|---|---|---|
| Supabase Storage (transformaciones) | Solo Pro+; 100 imágenes de origen incluidas, luego 5 USD por 1.000; ancho/alto 1–2500, origen ≤ 25 MB, ≤ 50 MP; resize, calidad, formato; **no vídeo** [37] | Basta para miniaturas y redimensionar; no compone ni añade texto |
| Cloudinary | Free 25 créditos; Plus 89 USD/mes (anual) o 99 (mensual), 225 créditos; 1 crédito = 1.000 transformaciones o 1 GB de almacenamiento o de ancho de banda; vídeo 2 GB por crédito [38]. Consumo de una transformación de vídeo: **sin verificar** | Compensa si no se quiere mantener FFmpeg y se acepta coste por uso |
| Mux | 1080p básico gratis; Plus 0,03125 USD/min; almacén 0,003 USD/min-mes; entrega 0,001 USD/min tras 100.000 min gratis; UE: **sin verificar** [39] | Pensado para streaming; para publicar MP4 en redes (inferencia) no es el camino |
| Transloadit | Free 5 GB (archivos de salida con marca); Lite 29 USD/mes (15 GB, máx. 1 GB/archivo); Pro 54 USD/mes anual (40 GB); sobreconsumo 1,80–2 USD/GB; UE: sin verificar [40] | Con 500 vídeos × ~130 MB ≈ 65 GB/mes se pasaría de los 40 GB de Pro (cálculo con mis supuestos) |
| Bunny Stream | Codificación gratis; almacenamiento desde 0,01 USD/GB; entrega desde 0,005 USD/GB; mínimo 1 USD/mes [41] | Reproducción/HLS; no sustituye recorte/composición para publicar |
| imgproxy | Software libre (**sin fuente leída**) | Sirve imágenes bajo demanda, pero hay que alojarlo: otro contenedor |

**Cuándo compensa:** solo para imágenes simples (Storage ya lo hace). Para vídeo con composición propia no hay sustituto claro; FFmpeg en contenedor es lo más barato.

## 7. Patrones

- **Webhooks de proveedores de vídeo, idempotentes.** (a) Verificar firma y marca de tiempo (la especificación Standard Webhooks existe precisamente para defender de suplantación y repetición [42]). (b) Tabla `webhook_events(provider, event_id, received_at, payload)` con **UNIQUE (provider, event_id)**; `INSERT … ON CONFLICT DO NOTHING`; si no inserta, devolver 200 sin hacer nada. (c) Responder rápido y encolar un `job` de «descargar y adjuntar» (la Edge Function solo gasta ~2 s de CPU). (d) **Sondeo de respaldo**: los webhooks no están garantizados y Replicate documenta el sondeo como alternativa [43]. (e) **Copiar el resultado enseguida**: Replicate borra entradas y salidas de predicciones de API a la hora [43].
- **Subida de archivos grandes.** TUS reanudable con trozos de **6 MB exactos**, contra `https://<proyecto>.storage.supabase.co/storage/v1/upload/resumable`; la URL de subida vale 24 h; con `createSignedUploadUrl` se pasa el token en la cabecera `x-signature` [44]. Subir a un camino con prefijo de marca, no sobrescribir (`x-upsert` solo si procede). Límite global configurable hasta 500 GB en Pro [8].
- **Tráfico de salida.** Supabase Pro: 250 GB incluidos, luego 0,09 USD/GB; 100 GB de almacenamiento incluidos, luego 0,0213 USD/GB [11]. Fly cobra la salida a 0,02 USD/GB y la entrada es gratis [4]; Render 0,15 USD/GB sobre el cupo [16]. El worker **descarga** (cuenta contra el egress de Supabase) y **sube** (entrada). Guardar solo el original si la política de retención lo exige y borrar derivados intermedios.
- **Secretos.** Secretos de Edge Functions con `supabase secrets set` (solo Owner/Admin) [28]. Claves de proveedores de IA y de redes sociales solo en el entorno del worker o en Vault, nunca en el navegador ni en el payload del job. Rotar si se muestra el payload de `net.http_request_queue`.

## 8. Estimación de coste mensual (20 empresas × 2 marcas)

**Supuestos (míos, a medir con un prototipo):** 500 vídeos × 90 s de pared en 2 vCPU/4 GB = 45.000 s; 2.400 imágenes × 5 s en 1 vCPU/2 GB = 12.000 s; total 57.000 s ≈ **15,8 h/mes** de cómputo activo. Vídeo medio: 100 MB de entrada, 30 MB de salida → ≈ 65 GB/mes nuevos de almacenamiento (+7 GB de imágenes).

**Supabase (común a todas las opciones).** Pro 25 USD (incluye 10 USD de crédito de cómputo [11]). Almacenamiento acumulado: mes 3 = 216 GB → (216−100) × 0,0213 = 2,5 USD; mes 12 = 864 GB → 764 × 0,0213 = **16,3 USD** sin política de borrado. Egress del worker (50 GB originales + 12 GB imágenes + ~15 GB de publicación) ≈ 77 GB < 250 GB incluidos → 0 USD.

| Opción | Cálculo del cómputo | Total mensual (mes 3 / mes 12) |
|---|---|---|
| **Barata: Fly bajo demanda** | shared-cpu-2x con RAM a 4 GB ≈ 13,39 + 2 × 6 = 25,39 USD/mes ÷ 730 h = 0,0348 USD/h × 15,8 h × 2 (margen de arranque) = **1,1 USD**; disco raíz parado ~2 GB × 0,15 = 0,30 USD; salida ~20 GB × 0,02 = 0,40 USD → **≈ 1,8 USD** | 25 + 2,5 + 1,8 = **≈ 29 USD** / 25 + 16,3 + 1,8 = **≈ 43 USD** |
| **Barata B: Cloud Run Jobs** | 102.000 vCPU-s y 204.000 GiB-s → dentro del cupo gratis (240.000 / 450.000) si aplica a la región; si no: 102.000 × 0,000018 + 204.000 × 0,000002 = 1,84 + 0,41 = **2,25 USD** | ≈ 28–30 USD / ≈ 42–44 USD |
| **Cómoda A: Render Frankfurt siempre encendido** | Workspace Pro 25 + worker 1 CPU 2 GB 25 = **50 USD** (25 GB de salida incluidos) | 25 + 2,5 + 50 = **≈ 78 USD** / **≈ 91 USD** |
| **Cómoda B: Trigger.dev Hobby** | 500 × 90 s en medium-1x (0,000085) = 3,83; 2.400 × 5 s en small-2x (0,0000675) = 0,81; 2.000 jobs IA × 20 s en small-1x (0,0000338) = 1,35; 5.000 runs × 0,000025 = 0,13 → **6,1 USD de cómputo** cubiertos por los 10 USD de crédito del plan Hobby = **10 USD** | 25 + 2,5 + 10 = **≈ 38 USD** / **≈ 51 USD** |
| Referencia: Cloudflare Containers | 5 USD + extras (memoria 8 GiB × 15,8 h = 126 GiB-h; ~0,9 USD; CPU 1,8 USD) ≈ **7,7 USD**; región UE sin verificar | ≈ 35 USD / ≈ 49 USD |

Si el proyecto aún no tiene Vercel Pro, sumar 20 USD (requisito comercial de Hobby: sin verificar aquí). Los costes de IA y de proveedores de vídeo no están incluidos.

## 9. Riesgos

- **Supuestos de tiempo** de FFmpeg no medidos: un vídeo largo o 1080p→recodificación puede triplicar el cómputo (el coste sigue siendo bajo; el riesgo es la latencia).
- **`pg_net` pierde llamadas** (cola unlogged, timeout 2 s) → obligatorio el cron barredor y que el worker haga `claim_jobs` en bucle [6].
- **Fly autostart**: el proxy no crea máquinas; con carga alta hay que fijar 2–3 máquinas paradas o que la app se pare sola al quedar ociosa [13]. Una sola máquina serializa el trabajo.
- **Reserva con caducidad vs vídeo largo**: renovar la reserva (latido) mientras FFmpeg trabaja, o el trabajo se reparte dos veces.
- **Clave secreta en el worker salta RLS**: usar rol limitado y validar siempre la marca.
- **Trigger.dev**: datos de runs fuera de la UE posible (sin verificar). **Cloudflare Containers / Modal**: región UE sin confirmar.
- **Almacenamiento** crece ~65 GB/mes sin política de retención.

## 10. Preguntas abiertas

1. ¿Tiempo real de FFmpeg (recorte, 1080p→1080p, composición con texto) en 2 vCPU? Hay que medirlo con 5 vídeos reales.
2. ¿Vídeo máximo de entrada en minutos, y ¿hay vertical 9:16 obligatorio para cada red?
3. ¿Se exige que los datos de las empresas no salgan de la UE (incluidas colas y logs de terceros)? Decide si Trigger.dev, Cloudflare o Modal quedan fuera.
4. ¿Qué proveedores de vídeo/imagen se usarán? Cada uno fija si hay webhook firmado y cuánto duran las salidas.
5. ¿Hay Vercel Pro contratado hoy? Cambia el Plan B (Sandbox) y el límite de 800 s.
6. ¿Política de retención de originales y derivados?
7. Confirmar con prueba: tamaño de `/tmp`/rootfs y duración máxima de una máquina Fly; si el cupo gratis de Cloud Run Jobs aplica a `europe-west1/4`; la tarifa EU de Vercel Sandbox.

## 11. Fuentes (consultadas el 16/11/2026)

[1] https://supabase.com/docs/guides/functions/limits
[2] https://supabase.com/docs/guides/functions/background-tasks
[3] https://vercel.com/docs/functions/limitations
[4] https://docs.fly.io/about/pricing
[5] https://supabase.com/docs/guides/cron
[6] https://supabase.com/docs/guides/database/extensions/pg_net
[7] https://supabase.com/docs/guides/database/webhooks
[8] https://supabase.com/docs/guides/storage/uploads/file-limits
[9] https://supabase.com/docs/guides/queues
[10] https://supabase.com/docs/guides/queues/api
[11] https://supabase.com/pricing
[12] https://docs.fly.io/reference/regions/
[13] https://docs.fly.io/launch/autostop-autostart
[14] https://docs.railway.com/reference/pricing/plans
[15] https://docs.railway.com/reference/deployment-regions
[16] https://render.com/pricing.md
[17] https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
[18] https://render.com/docs/cronjobs · https://render.com/docs/regions · https://render.com/docs/workflows
[19] https://developers.cloudflare.com/containers/pricing/
[20] https://developers.cloudflare.com/containers/platform-details/limits/
[21] https://docs.cloud.google.com/run/docs/configuring/task-timeout
[22] https://cloud.google.com/run/pricing (cifras de Jobs vía resultado de búsqueda; página no cargable)
[23] https://aws.amazon.com/fargate/pricing/
[24] https://modal.com/pricing
[25] https://www.hetzner.com/cloud/
[26] https://vercel.com/docs/sandbox/pricing
[27] https://vercel.com/docs/sandbox/concepts/regions
[28] https://supabase.com/docs/guides/functions/secrets
[29] https://trigger.dev/pricing
[30] https://trigger.dev/docs/machines
[31] https://trigger.dev/docs/config/extensions/ffmpeg
[32] https://trigger.dev/changelog/multi-region-workers · https://feedback.trigger.dev/p/eu-located-workers (post de usuario, no oficial)
[33] https://www.inngest.com/pricing
[34] https://upstash.com/pricing/workflow
[35] https://temporal.io/pricing
[36] https://vercel.com/docs/workflows/pricing
[37] https://supabase.com/docs/guides/storage/serving/image-transformations
[38] https://cloudinary.com/pricing
[39] https://www.mux.com/pricing
[40] https://transloadit.com/pricing/
[41] https://bunny.net/pricing/stream/
[42] https://www.standardwebhooks.com/
[43] https://replicate.com/docs/topics/webhooks
[44] https://supabase.com/docs/guides/storage/uploads/resumable-uploads
