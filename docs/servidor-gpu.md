# IA de imagen y texto: ¿servidor GPU propio, API o una mezcla?

Estudio del 21/11/2026. **Solo documentación:** no se ha tocado código, no se
ha contratado nada y no se ha creado ninguna cuenta. Los precios se han
consultado hoy en las webs oficiales que se citan. Cuando no se ha podido
confirmar un precio se dice **NO CONFIRMADO**, y las cifras de cálculo propio
van marcadas como *estimación*. Ningún proveedor está probado todavía contra el
servicio real (ver `docs/ia-medios.md` y `docs/ia-texto.md`), así que la
calidad es la que se espera, no una medida.

Documentos relacionados: `docs/ia-medios.md` (proveedores de imagen, §11
ComfyUI propio, §13 OpenAI, §14 Workers AI), `docs/edicion-fotos.md` (recorte
en el navegador, flujos de ComfyUI y «Proteger el plato»), `docs/ia-texto.md`
(adaptadores de texto), `docs/copiloto-voz.md` y el cuaderno de Colab de
`C:\Users\migue\tools\rrss-colab-imagenes\` (`rrss-comfyui-tunel.ipynb`).

**Moneda.** Las APIs cobran en USD y las nubes europeas en EUR. Para sumar se
usa **1 € ≈ 1,10 $**: es un supuesto redondo y no se ha consultado el cambio.
Todos los precios van **sin IVA**.

---

## 1. Resumen y recomendación

1. **Quitar el fondo:** en el navegador con IS-Net. Ya está integrado, es gratis y la foto no sale del dispositivo. **Cambiar el fondo:** OpenAI con máscara y «Proteger el plato», que ya está integrado. Salen unos 25 $ al mes.
2. **Generar imágenes:** FLUX.2 por la API de BFL, ya integrada (con klein 4B, 4 $ al mes; con FLUX.2 pro, 9 $). **Ampliar:** de momento no se ofrece. Cuando haga falta, con ComfyUI propio sin servidor fijo (§4).
3. **Texto y copiloto:** por API. Claude Haiku 5.5 para el copiloto y Sonnet 5.5 para los pies, a través de Vertex o Bedrock en la UE. Son unos 9 $ al mes, o 2 $ si todo va con Haiku. Un modelo de lenguaje en GPU propia no compensa: el copiloto necesita contestar en 1 o 2 segundos y una GPU parada no lo consigue.
4. **Total hoy, todo por API: unos 40-50 $ al mes** para 5-10 marcas, sin coste fijo. Un servidor encendido todo el mes cuesta como mínimo 214 € (Hetzner, UE) y entre 575 y 600 € con L4 en Scaleway u OVH.
5. **Cuándo cambiar:**
   - A **ComfyUI sin servidor fijo** (RunPod u OVH AI Deploy, en la UE) cuando se quiera ampliar, o cuando el gasto en la API de imagen pase de unos 100 $ al mes (unos 900-1.000 cambios de fondo al mes, el doble de hoy).
   - A **servidor encendido** (Hetzner GEX45) cuando la factura del ComfyUI sin servidor fijo pase de unos 230 € al mes, o haya GPU ocupada de forma continua en horario de trabajo (más de 30-40 marcas).
   - El texto se queda en la API en cualquier escenario razonable.

---

## 2. Tabla con todas las opciones

### 2.1 Volumen y supuestos del cálculo

Volumen de arranque (5-10 marcas) al mes:

| Tarea | Volumen | Supuesto del cálculo |
|---|---|---|
| Ediciones de foto | 500 | Mitad quitar el fondo (250) y mitad cambiar el fondo (250). Si las 500 fueran «cambiar el fondo», el coste de esa línea se duplica |
| Imágenes generadas | 300 | De ~1 MP |
| Ampliaciones | 100 | ×2 o ×4, hasta 4096 px por lado |
| Órdenes del copiloto por voz | 3.000 | ≈ 3.000 tokens de entrada y 300 de salida cada una. Total 9 M de entrada y 0,9 M de salida. El dictado lo hace el navegador (Web Speech API) y no tiene coste de API |
| Pies de foto con IA | 1.000 | ≈ 1.500 tokens de entrada y 400 de salida cada uno. Total 1,5 M de entrada y 0,4 M de salida |
| **Texto total** | | **10,5 M de tokens de entrada y 1,3 M de salida**, sin caché (con caché bajaría) |

**OpenAI y el cambio de fondo.** OpenAI cobra por tokens. Una edición de
~1,5 MP con calidad media sale a **≈ 0,10 $** (*estimación*: 0,053 $ por
1024² media de la tabla «histórica» × 1,5 más la entrada). La cota que
reserva rrss es de **0,26 $** por foto de 12 MP (`docs/ia-medios.md` §13).

### 2.2 Qué edición permite cada opción desde la app

Leyenda: **I** = integrada en rrss (adaptador escrito, sin probar contra el
servicio real); **A** = hace falta un adaptador nuevo; **C** = vía «ComfyUI
propio», que ya existe (cualquier servidor ComfyUI con el proxy de token); —
= no lo ofrece.

| Opción | Quitar el fondo | Cambiar el fondo (máscara) | Mejorar luz y color | Ampliar | Generar | Texto / copiloto |
|---|---|---|---|---|---|---|
| Navegador (IS-Net y ajustes sin IA) | **I** (gratis) | **I** solo fondo liso, color o imagen de la biblioteca, sin IA | **I** sin IA | — | — | — |
| OpenAI (gpt-image-2.5) | **I** | **I** (máscara orientativa más «Proteger el plato») | **I** | — | **I** | **I** (texto) |
| BFL (FLUX.2, Kontext, Fill) | — | **A** (Fill pro con máscara; Kontext sin máscara) | — | — | **I** | — |
| Ideogram | **A** (0,01 $) | **A** (precio NO CONFIRMADO) | — | **A** (NO CONFIRMADO) | **I** | — |
| Vertex (Gemini, Imagen) | — | **A** (Imagen 3 edita con máscara) | **A** | **A** (Imagen 4) | **I** | **I** (Claude y Gemini) |
| Anthropic, Bedrock, Mistral | — | — | — | — | — | **I** |
| Cloudflare Workers AI | — | — (no hay inpainting vivo) | — | — | **A** | **A** |
| fal.ai | **A** (BiRefNet) | **A** (FLUX Fill, Qwen-Image-Edit) | **A** | **A** (ESRGAN, SeedVR2) | **A** (el adaptador fal es de vídeo) | — |
| Replicate | **A** | **A** | **A** | **A** | **A** | — |
| Together, DeepInfra | — | Together: **A** (Kontext pro) | — | — | **A** | **A** |
| Fireworks, Groq | — | — | — | — | — | **A** |
| ComfyUI propio (Colab, GPU por horas o sin servidor fijo) | **C** (BiRefNet) | **C** con flujo nuevo (ver §4.5) | **C** con flujo nuevo | **C** (Real-ESRGAN) | **C** (FLUX.2 klein 4B) | — (el adaptador es de imagen) |
| RunPod Serverless con `worker-comfyui` | Los mismos grafos que ComfyUI propio, pero con otra API: **A** (adaptador `runpod-comfyui`) | | | | | |

### 2.3 Tabla grande

Coste mensual con el volumen del §2.1. En «Región», UE significa que se puede
procesar en la UE con la opción que se indica.

| # | Opción | Tareas en este escenario | Coste/mes | Calidad esperada | Latencia (orientativa, sin medir) | Región de datos | Licencia de los modelos | Montaje | ¿Integrada? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Recorte en el navegador (IS-Net)** | Quitar el fondo (250) y máscara del plato | **0 $** | Buena en platos sobre fondo liso, algo peor en bordes finos | 1-2 s con WebGPU; 13-19 s con WASM (medido en el panel con uint8). Descarga de 84 MiB la primera vez | **No sale del dispositivo** | IS-Net MIT/Apache-2.0; onnxruntime-web MIT | Hecho | **Sí** |
| 2 | **Colab gratis con ComfyUI** (`rrss-comfyui-tunel.ipynb`) | Solo pruebas: generar, quitar el fondo, ampliar | 0 $ | La de los modelos abiertos | T4: un par de minutos por imagen; sesión de hasta 52 min (vigilante) | **Desconocida**: no admite datos personales | FLUX.2 klein 4B Apache-2.0, BiRefNet MIT, Real-ESRGAN BSD-3, ComfyUI GPL-3.0 | Cuaderno hecho; sin ejecutar | Sí, como «ComfyUI propio» (solo staging) |
| 3 | **OpenAI imagen** (`gpt-image-2.5-sunburst` / `-flare`) | Cambiar el fondo (250) y, si se quiere, generar | Cambiar el fondo ≈ **25 $** (cota máxima 65 $). Generar 300 a calidad media con `gpt-image-2` ≈ 16 $ | Alta. La máscara es orientativa, por eso se vuelve a pegar el plato | Decenas de segundos por edición (*sin medir*) | UE con `eu.api.openai.com` y un proyecto europeo (+10 %) | Propietario; salidas del cliente | Clave y verificación de la organización | **Sí** |
| 4 | **OpenAI texto** | Copiloto y pies | `gpt-6-luna` con recargo UE ≈ **1,9 $**; `gpt-6.1-terra` UE ≈ 18,7 $ (precios de `docs/ia-texto.md`, consultados el 20/11) | luna sin medir; terra, buena | 1-3 s | UE con residencia (+10 %; hay que pedir la elegibilidad a ventas) | Propietario | Clave | **Sí** |
| 5 | **Anthropic directo** (Claude Haiku 5.5 y Sonnet 5.5) | Copiloto y pies | Todo Haiku **1,70 $**; todo Sonnet 34 $; Haiku en el copiloto y Sonnet en los pies **8,35 $** | Haiku buena para órdenes; Sonnet, muy buena para redactar | 1-3 s | **No hay UE**: solo `global` o `us` | Propietario | Clave | **Sí** (solo con aceptación expresa de datos fuera de la UE) |
| 6 | **Vertex AI** (Claude, Gemini, Imagen, Nano Banana) | Texto; generar | Claude por Vertex UE ≈ 1,9 $ (todo Haiku) o ≈ 9,2 $ (mixto), con +10 % *estimado* y precio NO CONFIRMADO. Gemini 3.1 Flash-Lite regional 5,0 $. Generar: Nano Banana 2.1 a 0,034 $ → 10,2 $; Imagen 4 a 0,04 $ → 12 $. Ampliar con Imagen 4: 0,06 $ → 6 $ | Alta | 1-3 s el texto; segundos la imagen | **UE** (multirregión `eu`) | Propietario | Cuenta de servicio | **Sí** (texto y generar). Editar y ampliar: no |
| 7 | **Bedrock** (Claude, perfil `eu.`) | Copiloto y pies | Como Vertex (NO CONFIRMADO; los revendedores dan Haiku 0,11/0,55 y Sonnet 2,20/11) | Igual que Anthropic | 1-3 s | **UE** (`eu-…`, sin enrutado `global.`) | Propietario | Claves de IAM | **Sí** |
| 8 | **Mistral** (Small 4) | Copiloto y pies | **2,36 $** (0,15/0,60) | Sin medir en español | 1-2 s | Empresa europea; dónde procesa: NO CONFIRMADO | Propietario por API (Small 3.2 abierto, Apache-2.0) | Clave | **Sí** |
| 9 | **BFL** (FLUX.2) | Generar (300) | klein 4B **4,2 $** (0,014 $ el primer MP); klein 9B 4,5 $; FLUX.2 pro **9 $**; flex 15 $. Editar con Fill pro (0,05 $/imagen) → 12,5 $; Kontext pro (0,04 $) → 10 $ | pro: alta; klein: buena y rápida | Segundos | El adaptador usa `api.eu.bfl.ai` (documentación del 17/11). Hoy no se ha encontrado la página de residencia: NO CONFIRMADO. Entrena con las entradas salvo contrato enterprise | Uso por API cubierto por BFL | Clave | **Sí** (generar). Editar: no |
| 10 | **Ideogram** | Generar | 3.0/4.0 a 0,03 $ → **9 $** (4.6 desde 0,008 $). Background remover a 0,01 $. Edit y Replace Background: NO CONFIRMADO | Alta con texto dentro de la imagen | Segundos | No documentada | Propietario | Clave | **Sí** (generar) |
| 11 | **Cloudflare Workers AI** | Generar y texto | klein 4B ≈ 0,3 $ (≈ 0,001 $/imagen, NO CONFIRMADO); klein 9B 0,015 $ → 4,5 $. Texto `gpt-oss-20b` ≈ 2,5 $; `llama-3.3-70b` ≈ 6 $. Gratis 10.000 neuronas al día | Generar, buena; no edita fotos | Segundos | **Sin garantía de UE** | Según el modelo (servido por Cloudflare) | Token | **No** (valorado en `ia-medios.md` §14) |
| 12 | **fal.ai** | Todo menos texto | klein 4B 0,005 $/MP → 1,5 $; FLUX.1 Fill dev 0,035 $/MP → **13 $** con 1,5 MP; Qwen-Image-Edit 0,03 $/MP → 11 $; ESRGAN 0,00111 $/s → ≈ 0,3 $ (*con 3 s*); SeedVR2 ≈ 1,6 $; BiRefNet «0 $/s» (parece un marcador: NO CONFIRMADO). **≈ 16 $ en total** | La de los modelos abiertos | Segundos; cola compartida | **No hay UE** (EE. UU. con cláusulas tipo) | Uso por su API; FLUX.1 dev Fill a través de fal (licencia comercial de fal con BFL: NO CONFIRMADO) | Clave | Solo vídeo; imagen **no** |
| 13 | **Replicate** (modelos públicos) | Quitar el fondo, generar | FLUX schnell 0,003 $ → 0,9 $; FLUX dev 0,025 $ → 7,5 $; `remove-bg` ≈ 0,0004 $; klein 4B, Fill dev, Kontext dev y Real-ESRGAN sin precio visible (NO CONFIRMADO) | Variable según el modelo de la comunidad | Segundos más el arranque | No consta | Según el modelo | Clave | No |
| 14 | **Together** | Generar, Kontext, texto | FLUX.2 dev 0,0154 $ → 4,6 $; Kontext pro 0,04 $/MP → 10 $; `gpt-oss-120B` → 2,4 $ | Buena | Segundos | Residencia UE «a petición» (privacy@) | Uso por su API | Clave | No |
| 15 | **Fireworks** | Texto | `gpt-oss-120B` 0,15/0,60 → **2,4 $** | Buena | Rápida | No consta UE | Apache-2.0 (gpt-oss) | Clave | No |
| 16 | **DeepInfra** | Generar y texto | klein 4B ≈ 0,014 $/MP → 4,2 $; `gpt-oss-120b` 0,037/0,17 → **0,6 $**; Mistral Small 3.2 → 1,05 $; Qwen3-32B → 1,2 $ | Buena | Rápida | No consta UE; no guarda entradas | Abiertas (Apache-2.0 la mayoría) | Clave | No |
| 17 | **Groq** | Texto | NO CONFIRMADO (la web oficial no trae tabla; terceros dan `gpt-oss-120b` 0,15/0,60 → ≈ 2,4 $) | Buena | La más rápida (fama, sin medir aquí) | NO CONFIRMADO | Abiertas | Clave | No |
| 18 | **RunPod Serverless** (escala a cero) | Imagen con ComfyUI | GPU de 24 GB a 0,75 $/h (4090: 1,34 $/h). Unas 6,6 h al mes → **5-9 $**, más el volumen de red (30 GB × 0,07 $ = 2,1 $) | La de los modelos abiertos | Caliente: segundos. En frío: 30-90 s (*estimación*; FlashBoot sin cifras) | Se puede limitar a centros de datos de la UE (los identificadores no constan en la documentación) | Las de los modelos | Imagen Docker con `worker-comfyui` y **adaptador nuevo** (no habla la API de ComfyUI) | No |
| 19 | **Modal** (escala a cero) | Imagen con ComfyUI | L4 a 0,000222 $/s (0,80 $/h). ~16 h al mes (*con ventana de 2 min*) → **13 $** (15-22 $ con recargo de región ×1,15-1,75). El plan Starter trae **30 $ al mes gratis** | Igual | Igual; facturable 60 s tras la última petición (configurable) | Región elegible con recargo; la UE no se cita expresamente | Igual | `@modal.web_server` con ComfyUI y el proxy: **sirve tal cual como «ComfyUI propio»** con un solo contenedor | No |
| 20 | **Replicate con modelo propio** (Cog) | Imagen | T4 a 0,81 $/h; L40S a 3,51 $/h. Los privados cobran arranque e inactividad → **≥ 15-50 $** | Igual | Arranque en frío largo | No consta | Igual | Cog y un adaptador nuevo | No |
| 21 | **Beam** | Imagen | 4090 a 0,69 $/h por milisegundo → ≈ 5-11 $; plan Developer de 20 $ al mes con 20 $ de crédito | Igual | En frío, sin cifra | No consta | Igual | SDK propio y adaptador nuevo | No |
| 22 | **RunPod Pods** (por horas, fuera de la UE o sin garantía) | Todo imagen | 4090 Community 0,34 $/h → 248 $ (24/7); Secure 0,89 $/h → 650 $; L4 Secure 0,69 $/h → 504 $. Encendiéndolo solo en horario laboral (~200 h): 70-180 $ | Igual | Sin arranque en frío mientras está encendido | Community: hosts de terceros; Secure: centros de datos elegibles | Igual | Plantilla de ComfyUI y el proxy | Sí, como «ComfyUI propio» |
| 23 | **Vast.ai** | Igual | Mercado: NO CONFIRMADO (por segundo, sin mínimo; interrumpible «50 %+ más barato») | Igual | Igual | Hosts de terceros: **no apto con datos de clientes** | Igual | Igual | Sí, como «ComfyUI propio» |
| 24 | **Lambda** | Igual | A10 24 GB 1,29 $/h → 942 $ (24/7) | Igual | Igual | EE. UU. (regiones no listadas) | Igual | Igual | Sí, como «ComfyUI propio» |
| 25 | **Scaleway** (UE) | Igual | L4 24 GB 0,79 €/h → **575 €** (24/7); L40S 1,40 €/h; H100 2,73 €/h. Por minuto | Igual | Igual | **Francia, UE** | Igual | Instancia, Docker y proxy | Sí, como «ComfyUI propio» |
| 26 | **OVHcloud** (UE) | Igual | **AI Deploy** L4 0,83 €/h por minuto, **escala a cero** → 16 h ≈ **13 €** (24/7 ≈ 606 €). Cloud GPU L4 desde 1 $/h | Igual | En frío: NO CONFIRMADO | UE (país NO CONFIRMADO) | Igual | Imagen Docker. Sirve como «ComfyUI propio» con una réplica | Sí, como «ComfyUI propio» |
| 27 | **Hetzner GPU** (UE, dedicado) | Igual | **GEX45** (RTX PRO 4000 Blackwell, 24 GB): **214 € al mes** más 209 € de alta. GEX63 (96 GB): 999 € más 999 € | Igual | Sin arranque en frío | **Helsinki / Falkenstein, UE** | Igual | Servidor dedicado (sistema, drivers, TLS y copias a nuestro cargo) | Sí, como «ComfyUI propio» |
| 28 | **Verda (antes DataCrunch)** | Igual | RTX A6000 48 GB 0,933 $/h; L40S 2,08 $/h (otra página oficial da 1,37 $: contradictorio); V100 16 GB 0,256 $/h → 187 $ (24/7) | Igual | Igual | Finlandia (UE); Islandia es EEE, no UE | Igual | Igual | Sí, como «ComfyUI propio» |
| 29 | **Nebius** (UE) | Igual | L40S 1,35 $/h más CPU y RAM (otra página: 1,55 $) → ≥ 985 $ (24/7); hay «Serverless AI» sin precios publicados | Igual | Igual | Finlandia (`eu-north1`), Francia (H200) | Igual | Igual | Sí, como «ComfyUI propio» |
| 30 | **IONOS** (UE) | Igual | Solo H200 141 GB: 3,26 $/h (mezcla USD y EUR); **no hay GPU de 24 GB** | Sobredimensionada | Igual | Alemania | Igual | Igual | Sí, como «ComfyUI propio» |
| 31 | **Genesis Cloud** | Igual | NO CONFIRMADO (las páginas oficiales dieron error SSL; un agregador da 4090 ≈ 0,55 $/h) | Igual | Igual | NO CONFIRMADO | Igual | Igual | Sí, como «ComfyUI propio» |
| 32 | **Colab Pro / Pro+ como servidor** | Imagen | NO CONFIRMADO (la página exige iniciar sesión; de memoria, Pro ≈ 10 $ y Pro+ ≈ 50 $ al mes con unidades de cómputo) | Igual | Sesiones de hasta 24 h en Pro+ y cortes por inactividad | Desconocida | Igual | Cuaderno y túnel | Sí (staging) |

**Por qué Colab (gratis, Pro o Pro+) no vale para producción.** La FAQ de
Colab (`research.google.com/colaboratory/faq.html`, consultada el 21/11/2026)
prohíbe en cualquier entorno conectarse a proxies remotos («connecting to
remote proxies»). A los usuarios gratuitos les prohíbe además saltarse la
interfaz del cuaderno para trabajar sobre todo por una interfaz web. Las
sesiones caducan (12 h en gratis, hasta 24 h en Pro+), la GPU no está
garantizada, la dirección del túnel cambia cada vez, la región es desconocida
y no hay contrato de tratamiento de datos.

*Nota:* el README del cuaderno cita la frase «servicios web no relacionados
con cómputo interactivo». Hoy la FAQ no la usa con esas palabras, aunque la
prohibición de proxies remotos lleva a lo mismo. Conviene corregir esa cita
del README en otra tarea.

---

## 3. Coste mensual por escenario

Volumen del §2.1. Las cifras son de precios oficiales del 21/11/2026, más las
*estimaciones* indicadas.

### 3.1 Segundos de GPU de la carga de imagen (para servidor propio)

*Estimación, sin medir.* GPU de 24 GB, modelos en caliente:

| Trabajo | Cálculo | Segundos |
|---|---|---|
| Generar con FLUX.2 klein 4B (4 pasos, ~1 MP) | 300 × 4 s | 1.200 |
| Cambiar el fondo con BiRefNet + fondo con klein 4B + composición (§4.5) | 250 × 10 s | 2.500 |
| Quitar el fondo en el servidor (opcional; hoy lo hace el navegador) | 250 × 1 s | 250 |
| Ampliar con Real-ESRGAN ×4 | 100 × 4 s | 400 |
| **Trabajo útil** | | **≈ 4.350 s ≈ 1,2 h** |
| Arranques en frío: 10 al día de 60 s | 300 × 60 s | 18.000 s = 5 h |
| Ventana de inactividad: 5 s (RunPod) o 120 s (ComfyUI con su API, ver §4.3) | 300 ráfagas | 0,4 h o 10 h |

Arranques y ventanas pesan **más que el trabajo**. Por eso con este volumen
el coste es casi fijo y depende de cuántas veces al día se despierta la GPU.

### 3.2 Escenarios

| Escenario | Qué va dónde | Coste/mes | Comentario |
|---|---|---|---|
| **A. Todo API** (lo integrado hoy, UE donde se puede) | Quitar el fondo: navegador (0). Cambiar el fondo: OpenAI (≈ 25 $). Generar: BFL FLUX.2 pro (9 $) o klein 4B (4,2 $). Ampliar: Vertex Imagen 4 (6 $; adaptador por hacer) o no se ofrece. Texto: Haiku en el copiloto y Sonnet en los pies por Vertex o Bedrock UE (≈ 9 $), o todo Haiku (≈ 2 $) | **≈ 49 $** (rango 31-90 $ según modelos y la cota de OpenAI) | Sin coste fijo ni mantenimiento. Es lo que ya hay |
| A′. Todo API barata (fuera de la UE) | fal.ai para imagen (≈ 16 $) más DeepInfra `gpt-oss-120b` (0,6 $) | **≈ 17 $** | Exige adaptadores nuevos y aceptar datos fuera de la UE. Calidad del cambio de fondo sin comparar con OpenAI |
| **B. Todo servidor encendido** (24/7) | Imagen en una GPU propia. El texto, por API (un modelo de lenguaje en la misma GPU de 24 GB no cabe junto a FLUX y no da la latencia del copiloto) | **Hetzner GEX45: 214 € (≈ 235 $) más 9 $ de texto ≈ 245 $** (el primer mes, más 209 € de alta). Scaleway L4 UE: 575 € (≈ 630 $). RunPod 4090 Community: 248 $ (sin UE) | Con texto propio de verdad haría falta otra GPU o una de 96 GB (GEX63, 999 €) |
| **C. Serverless** (imagen en ComfyUI que escala a cero; texto por API) | Generar, cambiar el fondo con flujo propio, quitar el fondo en el servidor y ampliar | RunPod (UE, adaptador nuevo): **≈ 7-11 $**. Modal (sirve tal cual): 13-22 $, cubiertos por los 30 $ gratis. OVH AI Deploy (UE, sirve tal cual): ≈ 13 €. **Más 9 $ de texto → ≈ 16-31 $** | La calidad del cambio de fondo con modelos abiertos y licencia comercial (§5) está **por demostrar** frente a OpenAI. Esfuerzo de montaje de 1 a 3 días |
| **D. Mixto** (el paso siguiente recomendado) | API para el texto (9 $) y el cambio de fondo con OpenAI (25 $). ComfyUI que escala a cero para generar (klein 4B), ampliar y quitar el fondo en el servidor (≈ 7-13 $) | **≈ 41-47 $** | Añade «Ampliar» por 7-13 $. Cuando el volumen crezca, pasar el cambio de fondo al flujo propio, si su calidad aguanta |

### 3.3 Punto de equilibrio

*Estimaciones con los precios de arriba.*

| Paso | Cuándo compensa | Cálculo |
|---|---|---|
| API → serverless (imagen) | El ahorro debe pagar el mantenimiento. Con **2 h al mes × 40 €/h = 80 € ≈ 90 $** (supuesto de coste de manos), compensa con **≈ 900-1.000 cambios de fondo al mes** (el doble de hoy, unas 15-20 marcas) | Cada cambio de fondo cuesta ≈ 0,10 $ en OpenAI y ≈ 0,003-0,005 $ en GPU que escala a cero (10 s a 0,75-0,83 $/h, más su parte de arranque). Ahorro ≈ 0,095 $ por edición |
| Serverless → servidor encendido | Cuando la factura serverless pase de **≈ 230 €** (GEX45 más la alta amortizada en 12 meses ≈ 231 €), es decir, **≈ 300-340 h de GPU al mes**. En la práctica, cuando haya cola continua en horario laboral o los arranques en frío molesten (más de 30-40 marcas) | 231 € ≈ 254 $ ÷ 0,75 $/h ≈ 340 h |
| API → servidor encendido (sin pasar por serverless) | **≈ 2.500 cambios de fondo al mes** solo con OpenAI. Con la mezcla actual (≈ 40 $ de imagen por cada 5-10 marcas), **unas 6 veces el volumen de hoy (35-60 marcas)** | 254 $ ÷ 0,10 $ |
| Texto propio frente a API | **Nunca, en la práctica.** Una GPU encendida para un modelo de lenguaje (≥ 214 €) equivale a **≈ 500.000 órdenes del copiloto al mes** con Haiku 5.5 | Haiku: 1,70 $ por 10,5 M de entrada y 1,3 M de salida |

---

## 4. Receta del montaje recomendado (cuando se monte servidor)

Objetivo: el mismo ComfyUI del cuaderno de Colab (mismos commits, modelos y
proxy con token), pero en una GPU de pago en la UE, y que rrss lo use **sin
cambiar código** como «ComfyUI propio» (Plataforma → Integraciones → ComfyUI
propio: URL https, token y región `eu`).

### 4.1 Imagen Docker `rrss-comfyui` (una sola para todas las nubes)

Contenido, sacado tal cual de `rrss-comfyui-tunel.ipynb`:

- **Base:** imagen oficial de CUDA o PyTorch con versión fijada (Python 3.11 o 3.12).
- **ComfyUI** en el commit `b5a432157de6b8884f81104cd02926adf4d597e4` (GPL-3.0), con `pip install -r requirements.txt`.
- **ComfyUI-RMBG** en el commit `4d738d23aef4dbdd2951fa0fc1d454dcef19ca61`, recortado a `AILab_BiRefNet.py` y `AILab_utils.py` (celda 3).
- **Modelos dentro de la imagen**, con su huella sha256 comprobada al construirla (celda 4):
  - `flux-2-klein-4b-fp8`, `qwen_3_4b_fp8_mixed` y `flux2-vae` (Apache-2.0);
  - BiRefNet general de `ZhengPeng7` (MIT);
  - `RealESRGAN_x4plus.pth` (BSD-3).
  - Unos 11 GB. Meterlos en la imagen evita la descarga al arrancar y que ComfyUI-RMBG baje pesos «la primera vez».
- **Proxy** de la celda 6 (aiohttp, `hmac.compare_digest`, cuerpo de hasta 64 MB, sin websockets). Un único cambio: el token sale de una variable de entorno (`COMFY_PROXY_TOKEN`) en vez de generarse.
- **Puertos:** ComfyUI escucha en `127.0.0.1:8188`; el proxy, en `0.0.0.0:8190`, es lo único expuesto.
- **Arranque:** un script que lanza ComfyUI, espera a `/system_stats` y lanza el proxy.
- **Lo que sobra:** no hace falta `cloudflared`, porque la plataforma da https. Tampoco el vigilante de 52 min: lo sustituye el escalado a cero.

### 4.2 Dónde desplegarla (por orden de preferencia)

| Opción | Cómo | Ventajas | A comprobar antes |
|---|---|---|---|
| **1. OVH AI Deploy (UE, escala a cero, por minuto)** | App con la imagen, GPU L4 (0,83 €/h), puerto 8190, **mínimo 0 y máximo 1 réplica** | UE, sin cambiar código, se factura por minuto | Que el mínimo de 0 réplicas despierte con la primera petición y cuánto tarda; el país del centro de datos; el contrato de tratamiento de datos |
| 2. Modal | `@modal.web_server(8190)` sobre la imagen, `gpu="L4"`, `min_containers=0`, **`max_containers=1`**, `scaledown_window` de 120-300 s, región europea | Sin cambiar código; 30 $ al mes gratis; Modal publica un ejemplo de ComfyUI | Que se pueda fijar la región en la UE y su recargo (×1,15-1,75); contrato de tratamiento de datos |
| 3. RunPod Serverless con `runpod/worker-comfyui` | Endpoint con centros de datos de la UE, FlashBoot, modelos en la imagen o en un volumen de red | El más barato (5-9 $ al mes); ventana de 5 s | **Exige un adaptador nuevo** (`/run` y `/status` con el grafo en JSON; devuelve la imagen en base64). Es trabajo de código, fuera de este estudio |
| 4. Hetzner GEX45 (cuando toque servidor encendido) | La misma imagen con `docker compose`, más Caddy para el TLS. Cortafuegos con solo el 443 abierto | Precio fijo de 214 € en la UE; sin arranques en frío | Mantenimiento del sistema y los drivers; 209 € de alta |

### 4.3 Condiciones para que el adaptador actual funcione con escala a cero

1. **Una sola réplica.** ComfyUI guarda la cola y `/history` en memoria. Si `/prompt` va a un contenedor y `/history` a otro, el trabajo se pierde.
2. **Ventana de inactividad de 2-5 min o más.** rrss consulta el resultado con `ai-media-poll` cada 30 s (pg_cron). Si el contenedor se apaga antes, el trabajo acaba como «no terminó a tiempo» y devuelve el cupo.
3. **Tiempos de espera.** El adaptador corta cada petición HTTP a los **30 s** (`timeoutMs` por defecto en `comfyui-image.ts`) y el arranque completo a los **120 s** (`startTimeoutMs` en `service.ts`). Un arranque en frío de más de 30 s haría fallar la primera subida (`/upload/image`) aunque la plataforma retenga la petición. Hay dos salidas:
   - (a) despertar la GPU antes con «Probar conexión» (`/system_stats`), que es manual;
   - (b) subir esos tiempos en otra tarea, que ya es cambio de código.
4. **«Probar conexión» despierta la GPU** y cuesta un arranque.
5. **Región:** `COMFYUI_DATA_REGION=eu` solo si el proveedor garantiza la UE por contrato. Entonces no hace falta fijar el modelo con `AI_MEDIA_*_MODEL`.
6. **Precio en el registro.** Cada fila de `ai_media_models` (`comfyui · flux-2-klein-4b`, `birefnet-general` y `realesrgan-x4plus`) debe llevar su coste por imagen. Con L4 a 0,83 €/h ≈ 0,00025 $/s y unos 10 s más la parte de arranque, poner **≈ 0,005 $ por imagen** y revisarlo con la factura real. Después, `price_verified = true` y `active = true` (`docs/ia-medios.md` §11, `docs/edicion-fotos.md` §4).

### 4.4 Coste del arranque en frío

*Estimación, sin medir.* Un arranque es descargar la imagen si el nodo no la
tiene en caché (unos 15 GB: minutos la primera vez) más cargar unos 11 GB en
la VRAM (20-60 s desde disco local).

| Concepto | Cálculo | Coste |
|---|---|---|
| Un arranque de 30-120 s en L4 (0,83 €/h) | | 0,007-0,028 € |
| Con 10 arranques al día | 300 arranques al mes | 2-8 € al mes |
| Ventana de 2 min por ráfaga (ComfyUI con su API) | 10 h al mes | ≈ 8 € al mes más |

En RunPod con FlashBoot y una ventana de 5 s es menos, pero exige el
adaptador nuevo.

### 4.5 Cambiar el fondo con modelos abiertos sin problemas de licencia

FLUX.1 Fill [dev] y Kontext [dev] **no** sirven en un servidor propio de pago
(licencia no comercial, §5). La ruta limpia reutiliza «Proteger el plato»:

1. **Recortar el plato** con BiRefNet (MIT) en el servidor, o con IS-Net en el navegador, como ahora.
2. **Generar solo el fondo** con FLUX.2 klein 4B (Apache-2.0) a partir del texto, con la foto como referencia (`ReferenceLatent`) o con *inpainting* por máscara de latente (`SetLatentNoiseMask` del núcleo de ComfyUI).
3. **Componer** el plato original encima con sombra suave. Ya existe en el navegador (`restorePlate`, `cutout/composition.ts`).

Otra opción es **Qwen-Image-Edit 2511** (Apache-2.0, 20B), que edita por
instrucciones. Pide unos 20 GB en fp8 (*estimación*): en 24 GB va justo y en
48 GB (L40S) va holgado.

Cualquiera de las dos es un **grafo nuevo** en el adaptador `comfyui`
(operación `replace_background`), así que también es trabajo de código. La
calidad, frente a OpenAI, hay que medirla con 20-30 fotos reales antes de
cambiar nada.

---

## 5. Riesgos y licencias

### 5.1 Licencias de los modelos abiertos

Fuentes: fichas oficiales en Hugging Face y GitHub, consultadas el 21/11/2026.
La VRAM marcada como *est.* es un cálculo propio (parámetros × bytes).

| Tarea | Modelo | Licencia | ¿Comercial en un SaaS propio? | VRAM | Fuente |
|---|---|---|---|---|---|
| Quitar el fondo | **BiRefNet** (general) | MIT | **Sí** | 0,2B: 2-4 GB *est.* | huggingface.co/ZhengPeng7/BiRefNet |
| Quitar el fondo | IS-Net (navegador) | MIT / Apache-2.0 | Sí | navegador | `docs/edicion-fotos.md` §7 |
| Quitar el fondo | RMBG-2.0 (BRIA) | **CC BY-NC 4.0** | **No** (prohibido) | — | huggingface.co/briaai/RMBG-2.0 |
| Ampliar | **Real-ESRGAN x4plus** | BSD-3-Clause | **Sí** | Poca (con `--tile`); cabe en 16 GB de sobra | github.com/xinntao/Real-ESRGAN |
| Editar con máscara | FLUX.1 Fill [dev] | FLUX.1 [dev] **Non-Commercial** | **No** sin licencia de BFL. Las salidas sí se pueden usar, pero ejecutar el modelo en un servicio de pago no | 12B: ~24 GB bf16, ~12 GB fp8 *est.* | huggingface.co/black-forest-labs/FLUX.1-Fill-dev |
| Editar con referencia | FLUX.1 Kontext [dev] | Igual que Fill | **No** | Igual | huggingface.co/black-forest-labs/FLUX.1-Kontext-dev |
| Editar con instrucciones | **Qwen-Image-Edit 2511** | Apache-2.0 | **Sí** | 20B: ~20 GB fp8 *est.* | huggingface.co/Qwen/Qwen-Image-Edit-2511 |
| Editar con máscara | SDXL Inpainting 0.1 | OpenRAIL++-M, pero la ficha dice «research purposes only» | **Dudoso**: revisarlo con alguien de legal | 8-12 GB *est.* | huggingface.co/diffusers/stable-diffusion-xl-1.0-inpainting-0.1 |
| Generar y editar | **FLUX.2 [klein] 4B** | **Apache-2.0** | **Sí** | ~13 GB (ficha) | huggingface.co/black-forest-labs/FLUX.2-klein-4B |
| Generar y editar | FLUX.2 [klein] 9B | FLUX **Non-Commercial** | **No** sin licencia (Builder/Platform de BFL, precio NO CONFIRMADO) | ~29 GB (ficha) | huggingface.co/black-forest-labs/FLUX.2-klein-9B |
| Generar y editar | FLUX.2 [dev] | FLUX Non-Commercial | **No** sin licencia | ≫ 60 GB bf16 | huggingface.co/black-forest-labs/FLUX.2-dev |
| Texto | Qwen3-30B-A3B / 32B, Qwen3.5-35B-A3B | Apache-2.0 | Sí | 30B: ~16-18 GB en 4 bits *est.* | huggingface.co/Qwen |
| Texto | Llama 3.3 70B | Llama 3.3 Community | Sí con condiciones (umbral de 700 M de usuarios) | ~40 GB en 4 bits *est.* | huggingface.co/meta-llama/Llama-3.3-70B-Instruct |
| Texto | Llama 3.2 Vision y Llama 4 (multimodal) | Community | **Evitar**: la política de Llama 3.2 Vision excluye a empresas con sede en la UE. En Llama 4: NO CONFIRMADO | — | github.com/meta-llama/llama-models |
| Texto | Mistral Small 3.2 24B | Apache-2.0 | Sí | ~55 GB bf16 | huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506 |
| Texto | Ministral 8B | **Mistral Research License** | **No** | ~24 GB | huggingface.co/mistralai/Ministral-8B-Instruct-2410 |
| Texto | gpt-oss-20b / 120b | Apache-2.0 | Sí | 16 GB / 80 GB (MXFP4) | huggingface.co/openai/gpt-oss-120b |
| Texto | Gemma 4 (E4B a 31B) | Apache-2.0 (desde 2026) | Sí | 31B: ~15 GB int4 *est.* | huggingface.co/google/gemma-4-31B-it |
| Texto | Gemma 3 | Términos propios de Gemma, con política de uso prohibido | Probablemente sí: NO CONFIRMADO (los términos redirigen a un dominio que no es de Google; no se siguió) | 27B: ~54 GB bf16 *est.* | huggingface.co/google/gemma-3-27b-it |
| Servidor | ComfyUI y ComfyUI-RMBG | GPL-3.0 | Sí: corren en nuestro servidor y no se distribuyen con rrss (no es AGPL) | — | repos del cuaderno |

**Trampas de licencia:**

- Los nombres «FLUX» engañan. De la familia, **solo klein 4B** es Apache-2.0.
- Por API (BFL, fal, Together, Cloudflare) la licencia del modelo la gestiona el proveedor. En un servidor propio, es nuestra.
- La licencia comercial de BFL (planes Builder y Platform en bfl.ai/licensing) no publica precio. Builder dice que no está pensada para uso de clientes («Not meant for client use»). Alojar un endpoint con el modelo exige hablar con ventas.
- Entrenar con salidas de FLUX requiere una licencia aparte.

### 5.2 Riesgos

| Riesgo | Afecta a | Mitigación |
|---|---|---|
| **Nada está probado contra el servicio real** (ni OpenAI, ni BFL, ni ComfyUI de pago) | Todas | Una llamada real por proveedor antes de activarlo (`docs/ia-medios.md` §6); medir calidad y tiempos con 20-30 fotos reales |
| Datos fuera de la UE | Anthropic directo (sin UE), fal, Replicate, Workers AI, Groq, RunPod Community, Vast, Lambda, Colab | Vertex o Bedrock UE para Claude, OpenAI con residencia, nubes de la UE. Hace falta DPA con cada proveedor y aparecer en el registro de tratamientos (`docs/rgpd.md`). Nada de datos personales en Colab |
| Entrenamiento con las entradas | BFL (salvo enterprise), Higgsfield | Ya marcado en `trains_on_inputs`. Evitar fotos con personas |
| Precios que cambian sin avisar (OpenAI por tokens; Gemini 3.8 Flash dobla su precio el 01/01/2027; precios de Verda y Nebius contradictorios) | APIs y nubes | Fecha y fuente en `ai_media_models` y en `AI_PRICES`; cota de coste antes de generar (ya existe); revisar cada trimestre |
| ComfyUI no tiene autenticación | Cualquier ComfyUI propio | Solo detrás del proxy con token (`hmac`), sin nodos que lean o escriban archivos, con un token por entorno guardado en Vault y vigilancia de la cola (`ia-medios.md` §11) |
| Arranques en frío y tiempos de espera del adaptador (30 s / 120 s) | Serverless | §4.3: despertar antes o subir los tiempos (cambio de código) |
| Una sola réplica en serverless (no escala con picos) | OVH AI Deploy, Modal | Con este volumen basta; si hay cola, pasar a RunPod (adaptador nuevo) o a un servidor encendido |
| Disponibilidad de la GPU | RunPod restringido a la UE, Colab | Admitir 2-3 centros de datos de la UE; dejar la API de OpenAI como respaldo del cambio de fondo |
| Mantenimiento propio (drivers, CUDA, actualizaciones de ComfyUI, seguridad) | Hetzner, Scaleway, pods | Imagen Docker fijada a commits y huellas; actualizar solo a propósito; estimar 2-4 h al mes |
| Calidad del cambio de fondo con modelos abiertos | Escenarios C y D | No sustituir a OpenAI sin una comparación a ciegas con fotos reales |
| Obsolescencia del catálogo (Workers AI retiró su inpainting; Mistral Medium 3.5 obsoleto desde el 31/10/2026) | APIs | Todo pasa por el registro de modelos: se cambia la fila sin redesplegar |
| Colab como servidor | Colab gratis, Pro y Pro+ | Solo pruebas en staging, como dice `ia-medios.md` §11 |

### 5.3 Pendiente de confirmar

- Precio de Claude en Vertex y Bedrock en la UE, y su recargo.
- Endpoint UE de BFL hoy.
- Precios de Ideogram (Edit, Replace Background, Upscale).
- Precio de BiRefNet en fal.
- Precios de Groq.
- Si OVH AI Deploy admite mínimo 0 réplicas, su arranque en frío y su país.
- Región UE de Modal.
- Identificadores de los centros de datos de la UE en RunPod.
- Precios de Vast y Genesis.
- Colab Pro y Pro+ en EUR.
- Precio de la licencia comercial de BFL.
- Tiempos reales de GPU de la tabla del §3.1.
