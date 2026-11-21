# 02 · Generación y edición de imagen por API (investigado el 16/11/2026)

Convención: «V» = verificado en página oficial; «SV» = sin verificar (fuente secundaria o no encontrada). Precios en USD, sin IVA. Los precios y modelos cambian a menudo: revisar antes de contratar.

## 1. Resumen

- Todos los de la lista tienen API pública real, salvo dudas menores (Freepik/Magnific: renombrado, precios no leídos).
- Para «foto real del cliente como base + marca» los mejores candidatos son **Google Gemini image (Nano Banana)**, **FLUX.2 (BFL)** y **OpenAI gpt-image**: aceptan varias imágenes de referencia y edición por instrucción.
- Para **texto legible dentro de la imagen** (carteles, ofertas): Ideogram, Recraft y gpt-image son los fuertes (capacidad de modelo, SV en benchmarks; no medido aquí).
- Residencia UE real (inferencia en UE) solo claramente documentada en **Google Vertex AI** y **BFL (endpoint EU, SV oficial)**. OpenAI: la residencia UE cubre datos en reposo; la inferencia sigue en EE. UU. según prensa (SV).

## 2. Tabla comparativa

| Proveedor | API pública / acceso | Precio por imagen (fuente) | Edición con foto real y referencias | Marca / estilo | Modo |
|---|---|---|---|---|---|
| **Higgsfield** | Sí, API de pago por uso, claves en open.higgsfield.ai, cabecera `Key id:secret` (V) | Soul 2 0,0032; Marketing Studio Image 0,0126; Ideogram 4.0 0,03; Recraft 4.1 0,035; Soul Standard 0,0938 (V) | La página no documenta edición de imagen ni referencias (V: no cubierto) | Soul/ID de personaje; sin estilos de marca documentados | Trabajos asíncronos: `request_id`, polling y webhook (webhook sin detallar). Salidas guardadas ≥7 días |
| **fal.ai** | Sí, agregador, cobro por uso | Nano Banana 0,0398; Nano Banana 2 0,08; Pro 0,15; Seedream V4.5 0,04; FLUX.2 0,012/MP; FLUX.1 dev 0,025/MP (V) | Según modelo (edit endpoints de Nano Banana, FLUX Kontext, Seedream edit, GPT image) | Depende del modelo; hay entrenamiento LoRA (no verificado aquí) | Cola/trabajos con webhook (SV en esta sesión) |
| **Replicate** | Sí, agregador | FLUX 1.1 Pro 0,04; FLUX dev 0,025; Ideogram v3 Quality 0,09; Recraft V3 0,04 (V) | Según modelo | Fine-tunes FLUX propios (SV) | Predicciones con webhook; límite 600 crear/min (V); salidas se borran a la hora (V) |
| **Black Forest Labs** | Sí, API directa de pago por uso, sin suscripción (V) | FLUX.2 pro 0,03 el 1.er MP +0,015/MP extra; referencia +0,015/MP; max 0,07; flex 0,05; klein 9B 0,015; klein 4B 0,014; Kontext pro 0,04; Fill pro 0,05 (V) | FLUX.2: edición con hasta 10 imágenes de referencia, hasta 4 MP (V, docs); Kontext y Fill (relleno) | Referencias múltiples; sin «estilo de marca» propio | Asíncrono (polling); webhooks SV; endpoint EU `api.eu.bfl.ai` citado por fuentes secundarias (SV) |
| **OpenAI** | Sí; requiere verificar la organización (V) | Por tokens: salida 30 $/M, entrada imagen 8 $/M (V). Estimado 1024²: low 0,006 / medium 0,013 / high 0,053 (gpt-image-2.5), xhigh 0,094, max 0,211 (SV: apidog/laozhang, no oficial) | `images/edits` con varias imágenes y máscara (inpainting) (V). La máscara es orientativa | Sin estilos entrenados; se pasa logo y referencias | Síncrono; límites por tier (p. ej. Build 20 imágenes/min) (V, de gpt-image-2) |
| **Google** (Gemini image / Imagen) | Sí: Gemini API (AI Studio) y Vertex AI | Nano Banana 2.1: 1K 0,0336, 2K 0,0504, 4K 0,113; Nano Banana 2: 1K 0,067; Pro: 0,134 (1K/2K), 0,24 (4K); Nano Banana (2.5) 0,039, se apaga el 15/03/2027 (V). Imagen: no pude leerlo (SV) | Edición conversacional con imágenes de entrada (entrada ≈0,0011 por imagen en Pro) (V); varias referencias (SV) | Referencias de personaje/objeto; sin entrenamiento | Síncrono; lote a mitad de precio (V) |
| **Ideogram** | Sí, API de pago por uso; sin suscripción, saldo prepago (V) | 3.0: Turbo 0,03 / Default 0,06 / Quality 0,09; 4.0: 0,03 / 0,06 / 0,10; 4.5: 0,008 a 0,22 según calidad; modelos propios 0,06 a 0,20; entrenar 40 $ por tanda (V) | Edit (inpaint), remix, reframe (ampliar), replace background al mismo precio (V) | Style reference, character reference (3.0: +0,07 a 0,11), modelos personalizados entrenables (V) | 10 peticiones en vuelo por defecto (V) |
| **Recraft** | Sí, unidades API prepago (1 ud = 0,001 $; no caducan) (V) | Raster V4/V3 0,04; vector 0,08; remove bg 0,01; upscale nítido 0,004; creativo 0,25; crear estilo 0,005 (V) | Image to image, inpaint, replace background (0,04) (V) | Estilos por referencia y estilos propios (V parcial) | Síncrono (SV) |
| **Stability AI** | Sí | Ultra 0,08; SD3.5 Large 0,065; Core 0,03; Inpaint 0,05; Outpaint 0,04; Search&Replace 0,05; Replace bg + relight 0,08; Style transfer 0,08 (V; 1 crédito = 0,01 $) | La suite de edición más completa y barata (inpaint, outpaint, estructura, fondo) (V) | Style Guide, Style Transfer (V) | Síncrono (SV) |
| **Leonardo** | Sí, pago por uso, sin cuota mensual (V) | Sin tarifa oficial legible; la web de docs no da valor del crédito (V). Cifras de terceros: SV | Guiado por imagen (SV) | Modelos propios entrenables (SV) | Webhooks (SV) |
| **Freepik / Magnific** | Sí, créditos por llamada (docs ahora en docs.magnific.com) (V) | No pude leer la tabla de créditos (403): SV | Reescalado, quitar fondo, relight, style transfer (nombres, SV) | Mystic con estilos/LoRA (SV) | SV |

Otros: **Bria** (quitar fondo 0,018 en fal, V; modelos entrenados con datos con licencia, SV) y **Seedream (ByteDance)** 0,04 por imagen en fal (V). No se profundizó.

## 3. Condiciones (comercial, reventa, propiedad, UE)

- **OpenAI**: sus salidas llevan metadatos C2PA y marca SynthID, incluso por API; se pierden fácilmente al subir o transformar (prensa, SV oficial). Propiedad de la imagen: no localizada, SV. Residencia UE: datos en reposo sí, inferencia solo EE. UU. (VentureBeat, SV). Recomienda enviar `safety_identifier` por usuario final (V).
- **Google**: en Vertex, Gemini 3.1 Flash Image y Gemini 2.5 Flash Image admiten procesamiento en multi-región UE; no figura región única UE; Imagen no aparece (V, docs.cloud.google.com). Nano Banana Pro: no figura, probablemente solo global (SV). SynthID en salidas: SV para Nano Banana.
- **fal.ai**: puede integrarse en tu producto, pero no exponer sus API directamente a usuarios finales; hay que dar a los usuarios términos al menos tan protectores; el cliente indemniza. Los términos no te dan propiedad de las salidas ni garantizan originalidad. Con modelos de terceros, el contenido pasa al tercero. El DPA y la política de no entrenar no valen en «Excluded Models». Residencia UE: no encontrada (V: fal.ai/legal/api-services).
- **Replicate**: concede «todo derecho» sobre la salida y permite uso comercial, sujeto a términos de cada modelo (FLUX dev no para productos competidores, Ideogram: no presentar como fotografía real). Prohíbe revender el servicio como tal; el uso de FLUX API en una app exige informar al usuario de los términos de FLUX. Ubicación de datos y DPA: no figuran (V: replicate.com/terms).
- **BFL (términos EU)**: licencia limitada «para desarrollar y operar integraciones», dentro de tu aplicación; no puedes alojar un endpoint que dé acceso a terceros. BFL obtiene licencia perpetua sobre entradas y salidas, incluso para entrenar; el texto no dice quién es dueño de las salidas ni dónde se procesa (V: bfl.ai/legal/eu-api-service-terms). Importante para RGPD: fotos de clientes pueden entrenar sus modelos salvo pacto enterprise. Retención cero y residencia UE: «enterprise», SV.
- **Ideogram**: no reclama propiedad; uso libre incluido comercial (V). Residencia UE: no encontrada.
- **Recraft**: plan de pago = propiedad y derechos comerciales; plan gratuito no (V). Condiciones para reventa vía API: no leídas.
- **Stability, Leonardo, Freepik, Higgsfield**: licencia comercial, reventa y residencia UE: no verificado.

## 4. Agregador frente a contratar directo

Ventajas del agregador (fal/Replicate): una sola factura y un solo adaptador; cambiar de modelo con un parámetro (útil porque los modelos se renuevan cada pocos meses); catálogo enorme (Nano Banana, FLUX, Seedream, Ideogram, Recraft); LoRA/fine-tunes alojados; cola y webhooks homogéneos; sin verificación de organización por proveedor.

Inconvenientes: un intermediario más tratando fotos de clientes (RGPD: subencargado adicional, DPA solo para algunos modelos en fal, sin DPA visible en Replicate); sin región UE garantizada; sobrecoste o igualdad de precio según modelo (Nano Banana en fal 0,0398 frente a 0,0336 a 0,039 en Google directo); términos en cascada (los del modelo y los del agregador); salidas efímeras en Replicate (1 h); riesgo de que un modelo deje de estar disponible; límites y cuotas compartidos.

Directo: mejores precios, mejor residencia y contrato (Vertex), y soporte; pero un SDK y una factura por proveedor.

Recomendación de patrón: adaptador propio con **Google Vertex (UE)** como proveedor principal y **fal.ai** como segundo adaptador para probar modelos nuevos con datos sin fotos reales sensibles.

## 5. Coste mensual de una marca (60 publicaciones × 4 propuestas = 240 imágenes)

Fórmula: coste = 240 × precio por imagen × factor de repetición. Muestro el factor 1 (sin repetir) y 1,5 (el cliente descarta o regenera un tercio).

| Opción | Modelo y supuestos | Precio unitario | 240 imágenes | Con ×1,5 |
|---|---|---|---|---|
| Barata | FLUX.2 [klein] 9B, 1 MP, 1 referencia: 0,015 + 0,002 | 0,017 | 4,08 $ | 6,12 $ |
| Media | Nano Banana 2.1 (Gemini API), 1K: 0,0336 (+ ~0,001 por foto de entrada) | ~0,035 | 8,4 $ | 12,6 $ |
| Media-alta (alternativa) | FLUX.2 [pro], 2 MP (un 4:5 de 1080×1350 son 1,46 MP y se redondea a 2): 0,03 + 0,015, más 1 referencia 2 MP: 0,03 | 0,075 | 18,0 $ | 27,0 $ |
| Alta | Nano Banana Pro, 2K: 0,134 (+ entrada ~0,0011) | ~0,135 | 32,4 $ | 48,6 $ |
| Referencia de texto | Ideogram 4.0 Quality 0,10 (si se prioriza texto en imagen) | 0,10 | 24,0 $ | 36,0 $ |

Notas: precios de BFL y Google leídos en sus páginas oficiales. El 1K de Google es hasta ~1024 px; para 1080×1350 se necesitaría 2K (0,0504): 240 × 0,0504 = 12,10 $. Con gpt-image 2.5 el coste estimado sería ~3 $ (low) a ~12,6 $ (high) (240 × 0,0132 a 0,0527; SV, cifras no oficiales). Todo ello es órdenes de magnitud por debajo de lo que se factura por una marca: el cupo mensual protege más contra bucles y abusos que contra el gasto normal. Calcular además generación de texto/visión y almacenamiento aparte.

## 6. Recomendación razonada

1. **Principal: Google Gemini image vía Vertex AI en multi-región UE** (Nano Banana 2.x). Razones: único con residencia UE de procesamiento documentada en página oficial; edición con foto real e imágenes de referencia; precio 0,034 a 0,05 por imagen; síncrono, simple de integrar. Cuidado: Gemini 2.5 Flash Image se apaga el 15/03/2027; Pro y la UE no están confirmados.
2. **Segundo adaptador: FLUX.2 (BFL) o Ideogram** para casos concretos: FLUX.2 para composiciones con hasta 10 referencias y relleno (Fill); Ideogram para piezas con texto (ofertas, menús) y modelos entrenados de marca (40 $ por entrenamiento, 0,06 a 0,20 por imagen).
3. **Edición determinista de la foto real** (quitar fondo, ampliar, reencuadrar): Stability (0,04 a 0,08) o Recraft (0,01 a 0,04) son más baratos y predecibles que un modelo generativo; útiles para 9:16 y 16:9 a partir de una foto 4:5.
4. Mantener **OpenAI gpt-image** como adaptador opcional por su calidad con texto y precisión de edición, sabiendo que la inferencia puede salir de la UE.
5. Higgsfield: queda fuera de la primera fase (API sí existe, pero no documenta edición con foto real, ni residencia, ni condiciones comerciales).
6. Capa propia obligatoria: colocar logo, tipografía y colores de marca **en el servidor sobre la imagen** (composición determinista) en vez de pedirlo al modelo; así se garantiza el respeto de la marca y el texto legible.

## 7. Riesgos

- **RGPD**: fotos del cliente (y potencialmente personas identificables) se envían a un tercero; exigir DPA, subencargados y no entrenamiento. BFL (licencia sobre entradas para entrenar) y fal «Excluded Models» son los puntos más delicados.
- **Reventa**: fal prohíbe exponer su API a usuarios finales y exige términos propios para ellos; Replicate prohíbe revender el servicio; BFL limita el uso a tu aplicación. Un SaaS que genera imágenes desde su propio servidor suele cumplirlo, pero conviene confirmar por escrito con cada proveedor (sobre todo si el cupo se vende como producto).
- **Procedencia**: marcas C2PA/SynthID pueden aparecer en las imágenes; Meta e Instagram las etiquetan como «hecho con IA». Informar al cliente. Aviso del AI Act sobre etiquetado de contenido sintético (no analizado aquí).
- **Obsolescencia**: modelos con fecha de retirada (Gemini 2.5 Flash Image 15/03/2027; la página de OpenAI marca gpt-image-2 como deprecado). Diseñar el adaptador con el nombre del modelo en configuración.
- **Costes variables por tokens** (OpenAI, Google): registrar el coste real devuelto por la API, no un precio fijo.
- **Propiedad de la imagen** y posible parecido con obras ajenas: ninguno garantiza originalidad (fal lo dice expresamente).
- Seguridad: no exponer claves en el cliente; llamar desde Edge Function y guardar el resultado en Storage propio (Replicate borra a la hora, Higgsfield a los 7 días).

## 8. Preguntas abiertas

- ¿Nano Banana 2.1 / Pro tienen región UE en Vertex hoy (la página oficial solo lista 3.1 Flash y 2.5 Flash)? Pedir confirmación a Google Cloud.
- Precio oficial de Imagen 4 y de Freepik/Magnific y Leonardo (no se pudo leer).
- ¿BFL ofrece de verdad API UE con retención cero y DPA? Pedir el contrato enterprise.
- ¿OpenAI ofrece inferencia en UE para imágenes? No hay fuente.
- Calidad real con nuestras fotos de hostelería: hacer una prueba ciega de 20 casos con 3 candidatos (Google, FLUX.2, gpt-image) antes de decidir.
- ¿La propuesta visual necesita texto dentro de la imagen o se superpone en servidor? Define si Ideogram/Recraft hacen falta.
- ¿Hace falta entrenamiento por marca (LoRA / modelo personalizado)? Ideogram lo vende (40 $); en fal/BFL no verificado.

## 9. Fuentes

- fal.ai precios: https://fal.ai/pricing
- fal.ai términos API: https://fal.ai/legal/api-services
- Replicate precios: https://replicate.com/pricing
- Replicate límites: https://replicate.com/docs/topics/predictions/rate-limits
- Replicate retención: https://replicate.com/docs/topics/predictions/data-retention
- Replicate términos: https://replicate.com/terms
- BFL precios: https://bfl.ai/pricing
- BFL docs: https://docs.bfl.ai/ y https://docs.bfl.ml/llms.txt
- BFL términos EU: https://bfl.ai/legal/eu-api-service-terms
- OpenAI precios (tokens): https://developers.openai.com/api/docs/pricing
- OpenAI guía de imagen: https://developers.openai.com/api/docs/guides/image-generation
- OpenAI gpt-image-2 (límites): https://developers.openai.com/api/docs/models/gpt-image-2
- Precios por imagen OpenAI (SV, terceros): https://apidog.com/blog/gpt-image-2-5-flare-vs-sunburst-vs-gpt-image-2/ y https://blog.laozhang.ai/en/posts/gpt-image-2-5-api-pricing
- OpenAI C2PA/SynthID y residencia (SV): https://openai.com/index/supporting-eu-trustworthy-ai-ecosystem y https://venturebeat.com/ai/openai-now-lets-enterprises-choose-where-to-host-their-data
- Google precios: https://aistudio.google.com/docs/pricing
- Google residencia de datos: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency
- Ideogram API: http://ideogram.ai/pricing/?pricing_tab=api
- Recraft: https://www.recraft.ai/pricing y https://www.recraft.ai/docs/api-reference/pricing
- Stability: https://docs.stability.ai/pricing
- Leonardo: https://docs.leonardo.ai/docs/pricing-and-plans-faq
- Freepik/Magnific: https://docs.magnific.com/pricing
- Higgsfield: https://higgsfield.ai/higgsfield-api y https://docs.higgsfield.ai
